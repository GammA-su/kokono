import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { activeCatalogSql, cardsForItems, idList } from "../catalog/queries";
import {
  inventoryTotalsSql,
  latestAcquisitionSql,
} from "../inventory/aggregates";
import { locationPaths } from "../locations/queries";
import { fulfillableLocationIds, publicListingIdsSql } from "../publication/queries";

export const dashboardPolicy = {
  recentDays: 30,
  uncheckedDays: 30,
  lowStockUnits: 3,
} as const;
type Metrics = Record<
  | "franchises"
  | "lineups"
  | "items"
  | "recent"
  | "watched"
  | "high"
  | "urgent"
  | "below"
  | "unchecked"
  | "owned"
  | "fulfillable"
  | "stocked"
  | "published"
  | "drafts"
  | "outOfStock"
  | "featured",
  bigint
>;
export type ValueTotal = {
  currency: string | null;
  amount: bigint | null;
  units: bigint;
  skus: bigint;
};

export function createDashboardQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    overview: () =>
      withInternalTransaction(
        database,
        authorize,
        async (tx) => {
          const now = new Date();
          const recentCutoff = new Date(
            now.getTime() - dashboardPolicy.recentDays * 86_400_000,
          );
          const checkedCutoff = new Date(
            now.getTime() - dashboardPolicy.uncheckedDays * 86_400_000,
          );
          const locations = await locationPaths(tx);
          const fulfillable = idList(await fulfillableLocationIds(tx));
          const stock = inventoryTotalsSql(fulfillable);
          // Physical ownership remains unchanged by reservations. Listing attention uses
          // the same France scope and reservation subtraction as the public storefront.
          const availableStock = inventoryTotalsSql(idList(await fulfillableLocationIds(tx, "FRANCE")), true);
          const base = Prisma.sql`WITH stock AS (${stock}), available_stock AS (${availableStock}), public_listings AS MATERIALIZED (${publicListingIdsSql()}), items AS (
        SELECT i.id, i.created_at, l.franchise_id, (${activeCatalogSql}) AS live,
          COALESCE(st.total, 0)::bigint AS owned, COALESCE(st.fulfillable, 0)::bigint AS fulfillable,
          COALESCE(av.fulfillable, 0)::bigint AS available, (s.id IN (SELECT id FROM public_listings)) AS visible,
          w.enabled, w.priority, w.target_quantity, w.last_checked_at,
          s.id AS listing_id, s.published, s.featured, s.selling_price_amount, s.selling_price_currency
        FROM merchandise_items i JOIN lineups l ON l.id = i.lineup_id JOIN franchises f ON f.id = l.franchise_id
        LEFT JOIN stock st ON st.item_id = i.id
        LEFT JOIN available_stock av ON av.item_id = i.id
        LEFT JOIN purchase_watches w ON w.merchandise_item_id = i.id
        LEFT JOIN sale_listings s ON s.merchandise_item_id = i.id
      )`;
          const [metrics] = await tx.$queryRaw<Metrics[]>(Prisma.sql`${base}
        SELECT (SELECT COUNT(*) FROM franchises) AS franchises, (SELECT COUNT(*) FROM lineups) AS lineups,
          COUNT(*) AS items, COUNT(*) FILTER (WHERE created_at >= ${recentCutoff}) AS recent,
          COUNT(*) FILTER (WHERE enabled) AS watched,
          COUNT(*) FILTER (WHERE enabled AND priority = 'HIGH') AS high,
          COUNT(*) FILTER (WHERE enabled AND priority = 'URGENT') AS urgent,
          COUNT(*) FILTER (WHERE enabled AND target_quantity > owned) AS below,
          COUNT(*) FILTER (WHERE enabled AND (last_checked_at IS NULL OR last_checked_at <= ${checkedCutoff})) AS unchecked,
          COALESCE(SUM(owned), 0)::bigint AS owned, COALESCE(SUM(fulfillable), 0)::bigint AS fulfillable,
          COUNT(*) FILTER (WHERE owned > 0) AS stocked,
          COUNT(*) FILTER (WHERE visible) AS published,
          COUNT(*) FILTER (WHERE listing_id IS NOT NULL AND NOT published) AS drafts,
          COUNT(*) FILTER (WHERE visible AND available = 0) AS "outOfStock",
          COUNT(*) FILTER (WHERE visible AND featured) AS featured
        FROM items`);

          // Only location aggregates cross into JS; no individual balance or merchandise scan.
          const balances = await tx.inventoryBalance.groupBy({
            by: ["storageLocationId"],
            _sum: { quantity: true },
          });
          const byLocation = new Map(
            balances.map((row) => [
              row.storageLocationId,
              BigInt(row._sum.quantity ?? 0),
            ]),
          );
          const geography = { japan: 0n, france: 0n, transit: 0n, other: 0n };
          const logistics = locations
            .filter((location) => location.parentId === null)
            .map((root) => {
              const descendants = locations.filter(
                (location) =>
                  location.id === root.id ||
                  location.ancestors.includes(root.id),
              );
              return {
                id: root.id,
                code: root.code,
                name: root.name,
                active: root.active,
                units: descendants.reduce(
                  (sum, location) => sum + (byLocation.get(location.id) ?? 0n),
                  0n,
                ),
              };
            });
          for (const location of locations) {
            const group = location.inTransit
              ? "transit"
              : location.effectiveCountry === "JP"
                ? "japan"
                : location.effectiveCountry === "FR"
                  ? "france"
                  : "other";
            geography[group] += byLocation.get(location.id) ?? 0n;
          }

          // Reuse the aggregate CTE once for all bounded queues instead of rescanning
          // inventory and public eligibility for each queue. Each still has its own limit.
          const queue = (label: string, predicate: Prisma.Sql, order: Prisma.Sql, limit: number) => Prisma.sql`
            (SELECT ${label}::text AS queue, id::text, available,
              row_number() OVER (ORDER BY ${order}, id) AS position
             FROM items WHERE ${predicate} ORDER BY ${order}, id LIMIT ${limit})`;
          const attention = await tx.$queryRaw<{ queue: string; id: string; available: bigint }[]>(Prisma.sql`
            ${base} SELECT * FROM (${Prisma.join([
              queue("priority", Prisma.sql`enabled AND priority IN ('HIGH', 'URGENT')`, Prisma.sql`priority DESC, last_checked_at ASC NULLS FIRST`, 5),
              queue("gaps", Prisma.sql`enabled AND target_quantity > owned`, Prisma.sql`target_quantity - owned DESC, priority DESC`, 5),
              queue("unchecked", Prisma.sql`enabled AND (last_checked_at IS NULL OR last_checked_at <= ${checkedCutoff})`, Prisma.sql`last_checked_at ASC NULLS FIRST, priority DESC`, 5),
              queue("low", Prisma.sql`visible AND available <= ${dashboardPolicy.lowStockUnits}`, Prisma.sql`available ASC`, 8),
              queue("recent", Prisma.sql`created_at >= ${recentCutoff}`, Prisma.sql`created_at DESC`, 5),
            ], " UNION ALL ")}) queues ORDER BY queue, position`);
          const priority = attention.filter((row) => row.queue === "priority");
          const gaps = attention.filter((row) => row.queue === "gaps");
          const unchecked = attention.filter((row) => row.queue === "unchecked");
          const low = attention.filter((row) => row.queue === "low");
          const recent = attention.filter((row) => row.queue === "recent");
          const selected = await cardsForItems(
            tx,
            [
              ...new Set(
                [...priority, ...gaps, ...unchecked, ...low, ...recent].map(
                  (row) => row.id,
                ),
              ),
            ],
            fulfillable,
          );
          const cards = new Map(selected.map((item) => [item.id, item]));
          const hydrate = (rows: { id: string }[]) =>
            rows.map((row) => cards.get(row.id)!);

          const latestLineups = await tx.lineup.findMany({
            where: { archivedAt: null, franchise: { archivedAt: null } },
            select: {
              id: true,
              name: true,
              japaneseName: true,
              releaseDate: true,
              releaseDatePrecision: true,
              status: true,
              franchise: { select: { name: true } },
              _count: { select: { items: true } },
            },
            orderBy: [
              { releaseDate: { sort: "desc", nulls: "last" } },
              { id: "asc" },
            ],
            take: 8,
          });
          const years = await tx.$queryRaw<
            { year: number | null; count: bigint }[]
          >`
        SELECT EXTRACT(YEAR FROM release_date)::int AS year, COUNT(*) AS count FROM lineups
        GROUP BY EXTRACT(YEAR FROM release_date) ORDER BY year DESC NULLS LAST`;
          const franchises = await tx.$queryRaw<
            {
              id: string;
              name: string;
              items: bigint;
              ownedSkus: bigint;
              units: bigint;
            }[]
          >(Prisma.sql`${base}
        SELECT f.id::text, f.name, COUNT(i.id) AS items, COUNT(i.id) FILTER (WHERE i.owned > 0) AS "ownedSkus",
          COALESCE(SUM(i.owned), 0)::bigint AS units
        FROM franchises f LEFT JOIN items i ON i.franchise_id = f.id
        GROUP BY f.id ORDER BY COUNT(i.id) DESC, f.name, f.id LIMIT 10`);
          const activity = await tx.inventoryMovement.findMany({
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 10,
            select: {
              id: true,
              movementType: true,
              quantityDelta: true,
              createdAt: true,
              sourceLocationId: true,
              destinationLocationId: true,
              acquisitionUnitCostAmount: true,
              acquisitionUnitCostCurrency: true,
              referenceId: true,
              merchandiseItem: { select: { id: true, name: true } },
              actorUser: { select: { name: true } },
            },
          });
          const paths = new Map(
            locations.map((location) => [location.id, location.path]),
          );
          return {
            asOf: now,
            policy: dashboardPolicy,
            metrics,
            geography,
            logistics,
            priority: hydrate(priority),
            gaps: hydrate(gaps),
            unchecked: hydrate(unchecked),
            lowStock: hydrate(low).map((item, index) => ({ ...item, availableQuantity: Number(low[index].available) })),
            recentlyAdded: hydrate(recent),
            latestLineups,
            years,
            franchises,
            activity: activity.map((row) => ({
              ...row,
              sourcePath: row.sourceLocationId
                ? paths.get(row.sourceLocationId)
                : null,
              destinationPath: row.destinationLocationId
                ? paths.get(row.destinationLocationId)
                : null,
            })),
          };
        },
        { isolationLevel: "RepeatableRead", timeout: 15000 },
      ),
    /**
     * Whole-ledger and whole-catalog valuation. These three aggregates measured ~2.3 s of a
     * ~3.9 s combined dashboard at 50k items, and none of them answers an operational question
     * ("what needs my attention now"), so they load after the operational panels instead of
     * delaying them. Each figure is computed live inside its own snapshot, not cached, so the
     * numbers are current as of `asOf` rather than a stale precomputed summary.
     */
    valuation: () =>
      withInternalTransaction(
        database,
        authorize,
        async (tx) => {
          const fulfillable = idList(await fulfillableLocationIds(tx));
          const stock = inventoryTotalsSql(fulfillable);
          const availableStock = inventoryTotalsSql(idList(await fulfillableLocationIds(tx, "FRANCE")), true);
          const acquisition = await tx.$queryRaw<ValueTotal[]>`
        SELECT acquisition_unit_cost_currency AS currency,
          SUM(quantity_delta::bigint * acquisition_unit_cost_amount)::bigint AS amount,
          SUM(quantity_delta)::bigint AS units, COUNT(DISTINCT merchandise_item_id) AS skus
        FROM inventory_movements WHERE quantity_delta > 0 AND movement_type <> 'TRANSFER'
        GROUP BY acquisition_unit_cost_currency ORDER BY currency NULLS LAST`;
          const inventoryValue = await tx.$queryRaw<ValueTotal[]>(Prisma.sql`
        WITH stock AS (${stock}), cost AS (${latestAcquisitionSql()})
        SELECT cost.currency, SUM(stock.total * cost.amount)::bigint AS amount,
          SUM(stock.total)::bigint AS units, COUNT(*) AS skus
        FROM stock LEFT JOIN cost ON cost."itemId" = stock.item_id::text
        GROUP BY cost.currency ORDER BY cost.currency NULLS LAST`);
          // Only items holding sellable France stock can contribute, so this starts from that
          // aggregate instead of rebuilding the operational per-item CTE over the whole catalog.
          // The join stays a LEFT JOIN so stock with no listing is still reported as uncovered
          // units, exactly as the combined query did.
          const retail = await tx.$queryRaw<ValueTotal[]>(Prisma.sql`
        WITH available_stock AS (${availableStock}), public_listings AS MATERIALIZED (${publicListingIdsSql()}),
        priced AS (
          SELECT (s.id IN (SELECT id FROM public_listings)) AS visible,
            av.fulfillable::bigint AS available,
            s.selling_price_amount, s.selling_price_currency
          FROM available_stock av LEFT JOIN sale_listings s ON s.merchandise_item_id = av.item_id
          WHERE av.fulfillable > 0)
        SELECT CASE WHEN visible THEN selling_price_currency END AS currency,
          SUM(CASE WHEN visible THEN available * selling_price_amount END)::bigint AS amount,
          SUM(available)::bigint AS units, COUNT(*) AS skus
        FROM priced
        GROUP BY CASE WHEN visible THEN selling_price_currency END ORDER BY currency NULLS LAST`);
          return {
            asOf: new Date(),
            acquisition,
            inventoryValue,
            landedValue: null,
            retail,
          };
        },
        { isolationLevel: "RepeatableRead", timeout: 15000 },
      ),
  };
}
