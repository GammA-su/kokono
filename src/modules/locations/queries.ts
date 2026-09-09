import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { fulfillableLocationIds } from "../publication/queries";

export type LocationPath = {
  id: string;
  code: string;
  name: string;
  type: string;
  parentId: string | null;
  active: boolean;
  fulfillmentEnabled: boolean;
  notes: string | null;
  updatedAt: Date;
  path: string;
  depth: number;
  ancestors: string[];
  effectiveActive: boolean;
  inTransit: boolean;
  countryCode: string | null;
  effectiveCountry: string | null;
};
/** One shared physical address resolver for inventory, catalog details and location forms. */
export async function locationPaths(tx: Prisma.TransactionClient) {
  return tx.$queryRaw<LocationPath[]>`
    WITH RECURSIVE tree AS (
      SELECT id, code, name, type, parent_id, active, fulfillment_enabled, notes, updated_at, country_code,
        country_code::text AS effective_country,
        code AS path, 0 AS depth, ARRAY[]::uuid[] AS ancestors, active AS effective_active,
        type = 'IN_TRANSIT' AS in_transit
      FROM storage_locations WHERE parent_id IS NULL
      UNION ALL
      SELECT c.id, c.code, c.name, c.type, c.parent_id, c.active, c.fulfillment_enabled, c.notes, c.updated_at, c.country_code,
        COALESCE(c.country_code::text, t.effective_country),
        t.path || ' / ' || c.name, t.depth + 1, t.ancestors || t.id,
        t.effective_active AND c.active, t.in_transit OR c.type = 'IN_TRANSIT'
      FROM storage_locations c JOIN tree t ON t.id = c.parent_id
    ) SELECT id::text, code, name, type::text, parent_id::text AS "parentId", active,
      fulfillment_enabled AS "fulfillmentEnabled", notes, updated_at AS "updatedAt", path, depth,
      ancestors::text[] AS ancestors, effective_active AS "effectiveActive", in_transit AS "inTransit",
      country_code AS "countryCode", CASE WHEN in_transit THEN NULL ELSE effective_country END AS "effectiveCountry"
    FROM tree ORDER BY path, id
  `;
}
export function createLocationQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    tree: () =>
      withInternalTransaction(database, authorize, async (tx) => {
        const rows = await locationPaths(tx);
        const eligible = new Set(await fulfillableLocationIds(tx));
        const totals = await tx.inventoryBalance.groupBy({
          by: ["storageLocationId"],
          where: { quantity: { gt: 0 } },
          _sum: { quantity: true },
          _count: { merchandiseItemId: true },
        });
        const byId = new Map(totals.map((row) => [row.storageLocationId, row]));
        return rows.map((row) => ({
          ...row,
          fulfillable: eligible.has(row.id),
          units: byId.get(row.id)?._sum.quantity ?? 0,
          items: byId.get(row.id)?._count.merchandiseItemId ?? 0,
        }));
      }),
    detail: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const id = z.uuid().parse(input);
        return tx.storageLocation.findUnique({ where: { id } });
      }),
  };
}
