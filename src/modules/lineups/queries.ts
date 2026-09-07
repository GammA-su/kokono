import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { LineupStatus } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";

export const lineupFilterSchema = z.object({
  q: z.string().trim().max(200).catch(""),
  franchise: z.uuid().optional().catch(undefined),
  status: z.enum(LineupStatus).optional().catch(undefined),
  year: z.coerce.number().int().min(1).max(9999).optional().catch(undefined),
  manufacturer: z.string().trim().max(500).optional().catch(undefined),
  sort: z.enum(["newest", "oldest", "added", "alphabetical"]).catch("newest"),
  page: z.coerce.number().int().positive().max(1_000_000).catch(1),
  size: z.coerce
    .number()
    .refine((v) => [25, 50, 100].includes(v))
    .catch(25),
  archived: z.enum(["true", "false"]).catch("false"),
});
export type LineupFilters = z.infer<typeof lineupFilterSchema>;

export type LineupCounts = {
  catalogued: number;
  owned: number;
  published: number;
  watched: number;
  characters: number;
  stock: number;
};

async function countsFor(
  tx: Prisma.TransactionClient,
  ids: string[],
): Promise<Map<string, LineupCounts>> {
  if (!ids.length) return new Map();
  const selectedIds = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      catalogued: bigint;
      owned: bigint;
      published: bigint;
      watched: bigint;
      characters: bigint;
      stock: bigint;
    }>
  >(Prisma.sql`
    WITH item_stock AS (
      SELECT b.merchandise_item_id, SUM(b.quantity)::bigint AS quantity
      FROM inventory_balances b JOIN merchandise_items i ON i.id = b.merchandise_item_id
      WHERE i.lineup_id IN (${selectedIds}) GROUP BY b.merchandise_item_id
    ), character_counts AS (
      SELECT i.lineup_id, COUNT(DISTINCT c.character_id) AS characters
      FROM item_characters c JOIN merchandise_items i ON i.id = c.merchandise_item_id
      WHERE i.lineup_id IN (${selectedIds}) GROUP BY i.lineup_id
    )
    SELECT l.id::text AS id, COUNT(i.id) AS catalogued,
      COUNT(i.id) FILTER (WHERE s.quantity > 0) AS owned,
      COUNT(i.id) FILTER (WHERE p.published AND i.archived_at IS NULL AND l.archived_at IS NULL AND f.archived_at IS NULL) AS published,
      COUNT(i.id) FILTER (WHERE w.enabled) AS watched,
      COALESCE(MAX(c.characters), 0)::bigint AS characters,
      COALESCE(SUM(s.quantity), 0)::bigint AS stock
    FROM lineups l JOIN franchises f ON f.id = l.franchise_id
    LEFT JOIN merchandise_items i ON i.lineup_id = l.id
    LEFT JOIN item_stock s ON s.merchandise_item_id = i.id
    LEFT JOIN sale_listings p ON p.merchandise_item_id = i.id
    LEFT JOIN purchase_watches w ON w.merchandise_item_id = i.id
    LEFT JOIN character_counts c ON c.lineup_id = l.id
    WHERE l.id IN (${selectedIds}) GROUP BY l.id
  `);
  return new Map(
    rows.map(({ id, ...counts }) => [
      id,
      Object.fromEntries(
        Object.entries(counts).map(([key, value]) => [key, Number(value)]),
      ) as LineupCounts,
    ]),
  );
}

export function createLineupQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    list: (input: unknown = {}) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const filters = lineupFilterSchema.parse(input);
        const where: Prisma.LineupWhereInput = {
          ...(filters.archived === "false"
            ? { archivedAt: null, franchise: { archivedAt: null } }
            : {}),
          ...(filters.franchise ? { franchiseId: filters.franchise } : {}),
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.manufacturer
            ? { manufacturer: filters.manufacturer }
            : {}),
          ...(filters.year
            ? {
                releaseDate: {
                  gte: new Date(
                    `${String(filters.year).padStart(4, "0")}-01-01T00:00:00Z`,
                  ),
                  lte: new Date(
                    `${String(filters.year).padStart(4, "0")}-12-31T00:00:00Z`,
                  ),
                },
              }
            : {}),
          ...(filters.q
            ? {
                OR: [
                  { name: { contains: filters.q, mode: "insensitive" } },
                  {
                    japaneseName: { contains: filters.q, mode: "insensitive" },
                  },
                  {
                    manufacturer: { contains: filters.q, mode: "insensitive" },
                  },
                  {
                    franchise: {
                      name: { contains: filters.q, mode: "insensitive" },
                    },
                  },
                  {
                    franchise: {
                      japaneseName: {
                        contains: filters.q,
                        mode: "insensitive",
                      },
                    },
                  },
                ],
              }
            : {}),
        };
        const orders: Record<
          LineupFilters["sort"],
          Prisma.LineupOrderByWithRelationInput
        > = {
          newest: { releaseDate: { sort: "desc", nulls: "last" } },
          oldest: { releaseDate: { sort: "asc", nulls: "last" } },
          added: { createdAt: "desc" },
          alphabetical: { name: "asc" },
        };
        const total = await tx.lineup.count({ where });
        const pageCount = Math.max(1, Math.ceil(total / filters.size));
        const page = Math.min(filters.page, pageCount);
        const rows = await tx.lineup.findMany({
          where,
          include: {
            franchise: { select: { id: true, name: true, archivedAt: true } },
          },
          orderBy: [orders[filters.sort], { id: "asc" }],
          skip: (page - 1) * filters.size,
          take: filters.size,
        });
        const counts = await countsFor(
          tx,
          rows.map((row) => row.id),
        );
        return {
          rows: rows.map((row) => ({ ...row, counts: counts.get(row.id)! })),
          total,
          pageCount,
          filters: { ...filters, page },
        };
      }),
    facets: () =>
      withInternalTransaction(database, authorize, async (tx) => {
        const franchises = await tx.franchise.findMany({
          select: { id: true, name: true, archivedAt: true },
          orderBy: { name: "asc" },
        });
        const manufacturers = await tx.lineup.findMany({
          where: { manufacturer: { not: null } },
          select: { manufacturer: true },
          distinct: ["manufacturer"],
          orderBy: { manufacturer: "asc" },
        });
        const years = await tx.$queryRaw<
          { year: number }[]
        >`SELECT DISTINCT EXTRACT(YEAR FROM release_date)::int AS year FROM lineups WHERE release_date IS NOT NULL ORDER BY year DESC`;
        return {
          franchises,
          manufacturers: manufacturers.map((row) => row.manufacturer!),
          years: years.map((row) => row.year),
        };
      }),
    detail: (id: string, input: unknown = {}) =>
      withInternalTransaction(database, authorize, async (tx) => {
        if (!z.uuid().safeParse(id).success) return null;
        const lineup = await tx.lineup.findUnique({
          where: { id },
          include: {
            franchise: true,
            sources: { orderBy: { createdAt: "asc" } },
          },
        });
        if (!lineup) return null;
        const filters = lineupFilterSchema.parse(input);
        const counts = (await countsFor(tx, [id])).get(id)!;
        const pageCount = Math.max(
          1,
          Math.ceil(counts.catalogued / filters.size),
        );
        const page = Math.min(filters.page, pageCount);
        const items = await tx.merchandiseItem.findMany({
          where: { lineupId: id },
          take: filters.size,
          skip: (page - 1) * filters.size,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          include: {
            category: true,
            characters: { include: { character: true } },
            images: {
              orderBy: [
                { imageRole: "asc" },
                { displayOrder: "asc" },
                { id: "asc" },
              ],
              take: 1,
            },
            inventoryBalances: {
              where: { quantity: { gt: 0 } },
              select: { quantity: true },
            },
            purchaseWatch: true,
            saleListing: true,
            sources: { orderBy: { createdAt: "asc" } },
          },
        });
        return {
          ...lineup,
          counts,
          items: items.map(({ inventoryBalances, ...item }) => ({
            ...item,
            stock: inventoryBalances.reduce((n, b) => n + b.quantity, 0),
            locationCount: inventoryBalances.length,
          })),
          page,
          pageCount,
          size: filters.size,
        };
      }),
  };
}
