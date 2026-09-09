import { searchPattern } from "../shared/search";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { LineupStatus, WatchPriority } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { fulfillableLocationIds } from "../publication/queries";
import { locationPaths } from "../locations/queries";
import { movementFilterSchema } from "../inventory/history";
import { inventoryTotalsSql } from "../inventory/aggregates";
import { sourcingFilterSchema } from "../watchlist/filters";
import {
  catalogStatuses,
  effectiveRelease,
  summarizeStock,
  type StockLocationRow,
} from "./presentation";

const sortOptions = [
  "release-desc",
  "release-asc",
  "added",
  "updated",
  "alphabetical",
  "msrp-asc",
  "msrp-desc",
  "stock",
  "fulfillable",
  "priority",
] as const;
export const catalogSortLabels: Record<(typeof sortOptions)[number], string> = {
  "release-desc": "Newest release",
  "release-asc": "Oldest release",
  added: "Recently catalogued",
  updated: "Recently updated",
  alphabetical: "Alphabetically",
  "msrp-asc": "MSRP low to high",
  "msrp-desc": "MSRP high to low",
  stock: "Total stock",
  fulfillable: "Fulfillable stock",
  priority: "Purchase priority",
};
export const pageSizes = [24, 48, 96] as const;

export const catalogFilterSchema = z.object({
  q: z.string().trim().max(200).catch(""),
  franchise: z.uuid().optional().catch(undefined),
  lineup: z.uuid().optional().catch(undefined),
  character: z.uuid().optional().catch(undefined),
  category: z.uuid().optional().catch(undefined),
  location: z.uuid().optional().catch(undefined),
  manufacturer: z.string().trim().max(500).optional().catch(undefined),
  year: z.coerce.number().int().min(1).max(9999).optional().catch(undefined),
  month: z.coerce.number().int().min(1).max(12).optional().catch(undefined),
  status: z.enum(LineupStatus).optional().catch(undefined),
  stock: z.enum(["any", "has", "none", "fulfillable"]).catch("any"),
  listing: z.enum(["any", "published", "unpublished"]).catch("any"),
  watch: z.enum(["any", "enabled", "disabled"]).catch("any"),
  priority: z.enum(WatchPriority).optional().catch(undefined),
  jan: z.enum(["any", "has", "none"]).catch("any"),
  source: z.enum(["any", "official", "none"]).catch("any"),
  archived: z.enum(["false", "true", "only"]).catch("false"),
  // Server-side option search. Large operator catalogs hold far more lineups and characters
  // than any select may usefully render, so these narrow the option list instead of the results.
  lineupQuery: z.string().trim().max(200).catch(""),
  characterQuery: z.string().trim().max(200).catch(""),
  sort: z.enum(sortOptions).catch("release-desc"),
  page: z.coerce.number().int().positive().max(1_000_000).catch(1),
  size: z.coerce
    .number()
    .refine((value) => (pageSizes as readonly number[]).includes(value))
    .catch(24),
});
export type CatalogFilters = z.infer<typeof catalogFilterSchema>;

// The item's own release date wins; otherwise the lineup's supplies both value and precision.
const release = Prisma.sql`COALESCE(i.release_date, l.release_date)`;
const releasePrecision = Prisma.sql`COALESCE(i.release_date_precision, l.release_date_precision)`;
const manufacturer = Prisma.sql`COALESCE(i.manufacturer, l.manufacturer)`;
const officialSourceTypes = [
  "OFFICIAL_STORE",
  "MANUFACTURER",
  "OFFICIAL_ANNOUNCEMENT",
];

export function idList(ids: string[]) {
  return ids.length
    ? Prisma.sql`(${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.sql`(NULL::uuid)`;
}
export const activeCatalogSql = Prisma.sql`i.archived_at IS NULL AND l.archived_at IS NULL AND f.archived_at IS NULL`;
function whereClause(filters: CatalogFilters, fulfillable: Prisma.Sql) {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (filters.archived === "false") parts.push(activeCatalogSql);
  if (filters.archived === "only")
    parts.push(
      Prisma.sql`(i.archived_at IS NOT NULL OR l.archived_at IS NOT NULL OR f.archived_at IS NOT NULL)`,
    );
  if (filters.franchise)
    parts.push(Prisma.sql`l.franchise_id = ${filters.franchise}::uuid`);
  if (filters.lineup)
    parts.push(Prisma.sql`i.lineup_id = ${filters.lineup}::uuid`);
  if (filters.category)
    parts.push(Prisma.sql`i.category_id = ${filters.category}::uuid`);
  if (filters.manufacturer)
    parts.push(Prisma.sql`${manufacturer} = ${filters.manufacturer}`);
  if (filters.status)
    parts.push(Prisma.sql`l.status::text = ${filters.status}`);
  if (filters.character)
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM item_characters ic
      WHERE ic.merchandise_item_id = i.id AND ic.character_id = ${filters.character}::uuid)`);
  if (filters.year)
    parts.push(Prisma.sql`EXTRACT(YEAR FROM ${release}) = ${filters.year}`);
  // A year-precision date is anchored on 1 January and must not answer a month filter.
  if (filters.month)
    parts.push(
      Prisma.sql`EXTRACT(MONTH FROM ${release}) = ${filters.month} AND ${releasePrecision}::text <> 'YEAR'`,
    );
  if (filters.stock === "has")
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM inventory_balances b WHERE b.merchandise_item_id = i.id AND b.quantity > 0)`);
  if (filters.stock === "none")
    parts.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM inventory_balances b WHERE b.merchandise_item_id = i.id AND b.quantity > 0)`);
  if (filters.stock === "fulfillable")
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM inventory_balances b
      WHERE b.merchandise_item_id = i.id AND b.quantity > 0
        AND b.storage_location_id IN ${fulfillable})`);
  if (filters.location)
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM inventory_balances b
      WHERE b.merchandise_item_id = i.id AND b.quantity > 0
        AND b.storage_location_id = ${filters.location}::uuid)`);
  if (filters.listing === "published") parts.push(Prisma.sql`s.published`);
  if (filters.listing === "unpublished")
    parts.push(Prisma.sql`(s.merchandise_item_id IS NULL OR NOT s.published)`);
  if (filters.watch === "enabled") parts.push(Prisma.sql`w.enabled`);
  if (filters.watch === "disabled")
    parts.push(Prisma.sql`(w.merchandise_item_id IS NULL OR NOT w.enabled)`);
  if (filters.priority)
    parts.push(Prisma.sql`w.priority::text = ${filters.priority}`);
  if (filters.jan === "has") parts.push(Prisma.sql`i.jan_code IS NOT NULL`);
  if (filters.jan === "none") parts.push(Prisma.sql`i.jan_code IS NULL`);
  if (filters.source === "official")
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM item_sources src
      WHERE src.merchandise_item_id = i.id
        AND src.source_type::text IN (${Prisma.join(officialSourceTypes)}))`);
  if (filters.source === "none")
    parts.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM item_sources src WHERE src.merchandise_item_id = i.id)`);
  if (filters.q) {
    const pattern = searchPattern(filters.q);
    parts.push(Prisma.sql`(
      normalize(i.name,NFKC) ILIKE ${pattern} OR normalize(i.japanese_name,NFKC) ILIKE ${pattern}
      OR normalize(i.internal_sku,NFKC) ILIKE ${pattern} OR i.jan_code ILIKE ${pattern}
      OR EXISTS (SELECT 1 FROM unnest(i.aliases) alias WHERE normalize(alias,NFKC) ILIKE ${pattern})
      OR normalize(l.name,NFKC) ILIKE ${pattern} OR normalize(l.japanese_name,NFKC) ILIKE ${pattern}
      OR normalize(f.name,NFKC) ILIKE ${pattern} OR normalize(f.japanese_name,NFKC) ILIKE ${pattern}
      OR i.id IN (
        -- Uncorrelated so the matching characters are resolved once, not per catalog row.
        SELECT ic.merchandise_item_id FROM item_characters ic
        JOIN characters c ON c.id = ic.character_id
        WHERE normalize(c.name,NFKC) ILIKE ${pattern} OR normalize(c.japanese_name,NFKC) ILIKE ${pattern}
          OR EXISTS (SELECT 1 FROM unnest(c.aliases) alias WHERE normalize(alias,NFKC) ILIKE ${pattern})))`);
  }
  return Prisma.join(parts, " AND ");
}

function orderClause(sort: CatalogFilters["sort"]) {
  const orders: Record<CatalogFilters["sort"], Prisma.Sql> = {
    "release-desc": Prisma.sql`${release} DESC NULLS LAST`,
    "release-asc": Prisma.sql`${release} ASC NULLS LAST`,
    added: Prisma.sql`i.created_at DESC`,
    updated: Prisma.sql`i.updated_at DESC`,
    alphabetical: Prisma.sql`i.name ASC`,
    // Amounts are compared exactly as recorded; no currency conversion is implied.
    "msrp-asc": Prisma.sql`i.official_msrp_amount ASC NULLS LAST, i.official_msrp_currency ASC NULLS LAST`,
    "msrp-desc": Prisma.sql`i.official_msrp_amount DESC NULLS LAST, i.official_msrp_currency ASC NULLS LAST`,
    stock: Prisma.sql`COALESCE(st.total, 0) DESC`,
    fulfillable: Prisma.sql`COALESCE(st.fulfillable, 0) DESC`,
    // WatchPriority is declared LOW→URGENT, so descending puts the most urgent first.
    priority: Prisma.sql`COALESCE(w.enabled, false) DESC, w.priority DESC NULLS LAST`,
  };
  return orders[sort];
}

/** Per-location stock for the current page only; never for the whole catalog. */
async function stockForItems(
  tx: Prisma.TransactionClient,
  ids: string[],
  fulfillable: Prisma.Sql,
) {
  if (!ids.length) return new Map<string, StockLocationRow[]>();
  const rows = await tx.$queryRaw<
    (StockLocationRow & { itemId: string; quantity: number })[]
  >(Prisma.sql`
    SELECT b.merchandise_item_id::text AS "itemId", loc.id::text AS "locationId",
      loc.code, loc.name, loc.type::text AS type, b.quantity,
      (loc.id IN ${fulfillable}) AS fulfillable
    FROM inventory_balances b
    JOIN storage_locations loc ON loc.id = b.storage_location_id
    WHERE b.merchandise_item_id IN ${idList(ids)} AND b.quantity > 0
  `);
  const byItem = new Map<string, StockLocationRow[]>();
  const paths = new Map(
    (await locationPaths(tx)).map((location) => [location.id, location]),
  );
  for (const { itemId, ...row } of rows)
    byItem.set(itemId, [
      ...(byItem.get(itemId) ?? []),
      {
        ...row,
        path: paths.get(row.locationId)?.path,
        effectiveActive: paths.get(row.locationId)?.effectiveActive,
        countryCode: paths.get(row.locationId)?.effectiveCountry,
      },
    ]);
  return byItem;
}

const cardSelection = {
  id: true,
  name: true,
  japaneseName: true,
  internalSku: true,
  janCode: true,
  archivedAt: true,
  manufacturer: true,
  officialMsrpAmount: true,
  officialMsrpCurrency: true,
  officialMsrpTaxInclusion: true,
  releaseDate: true,
  releaseDatePrecision: true,
  createdAt: true,
  updatedAt: true,
  lineupId: true,
  category: { select: { id: true, name: true } },
  lineup: {
    select: {
      id: true,
      name: true,
      japaneseName: true,
      manufacturer: true,
      releaseDate: true,
      releaseDatePrecision: true,
      status: true,
      archivedAt: true,
      franchise: { select: { id: true, name: true, archivedAt: true } },
    },
  },
  characters: {
    select: {
      character: { select: { id: true, name: true, japaneseName: true } },
    },
  },
  // One image reference per card keeps the payload small; the detail page loads the rest.
  images: {
    select: { storageKey: true, imageRole: true, caption: true },
    orderBy: [
      { imageRole: "asc" },
      { displayOrder: "asc" },
      { id: "asc" },
    ] satisfies Prisma.ItemImageOrderByWithRelationInput[],
    take: 1,
  },
  purchaseWatch: {
    select: {
      enabled: true,
      priority: true,
      targetQuantity: true,
      maxUnitPriceAmount: true,
      maxUnitPriceCurrency: true,
      marketplaceSearchQuery: true,
      conditionPreference: true,
      lastCheckedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  saleListing: {
    select: {
      published: true,
      publishedAt: true,
      sellingPriceAmount: true,
      sellingPriceCurrency: true,
      sellingPriceTaxInclusion: true,
      slug: true,
      featured: true,
      publicTitle: true,
      publicDescription: true,
      updatedAt: true,
    },
  },
  _count: { select: { sources: true, images: true } },
} satisfies Prisma.MerchandiseItemSelect;

type CardRow = Prisma.MerchandiseItemGetPayload<{
  select: typeof cardSelection;
}>;

function toCard(item: CardRow, stock: StockLocationRow[]) {
  const summary = summarizeStock(stock);
  const archived = Boolean(
    item.archivedAt ||
    item.lineup.archivedAt ||
    item.lineup.franchise.archivedAt,
  );
  return {
    ...item,
    manufacturer: item.manufacturer ?? item.lineup.manufacturer,
    release: effectiveRelease(item),
    stock: summary,
    archived,
    characters: item.characters.map(({ character }) => character),
    statuses: catalogStatuses({
      archived,
      published: Boolean(item.saleListing?.published),
      totalStock: summary.total,
      fulfillableStock: summary.fulfillable,
      watching: Boolean(item.purchaseWatch?.enabled),
    }),
  };
}
export type CatalogCard = ReturnType<typeof toCard>;

export async function cardsForItems(
  tx: Prisma.TransactionClient,
  ids: string[],
  fulfillable: Prisma.Sql,
) {
  const rows = await tx.merchandiseItem.findMany({
    where: { id: { in: ids } },
    select: cardSelection,
  });
  const stock = await stockForItems(tx, ids, fulfillable);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is CardRow => Boolean(row))
    .map((row) => toCard(row, stock.get(row.id) ?? []));
}

export function createCatalogQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    /** Resolve a bounded selection with the exact same predicates as catalog browsing. */
    matchingIds: (input: unknown, limit: number, selectedIds?: string[]) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const filters = catalogFilterSchema.parse(input);
        const fulfillable = idList(await fulfillableLocationIds(tx));
        const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT i.id::text AS id FROM merchandise_items i
          JOIN lineups l ON l.id = i.lineup_id
          JOIN franchises f ON f.id = l.franchise_id
          LEFT JOIN purchase_watches w ON w.merchandise_item_id = i.id
          LEFT JOIN sale_listings s ON s.merchandise_item_id = i.id
          WHERE ${whereClause(filters, fulfillable)}
            ${selectedIds ? Prisma.sql`AND i.id IN ${idList(selectedIds)}` : Prisma.empty}
          ORDER BY i.id LIMIT ${z.number().int().min(1).max(100001).parse(limit)}
        `);
        return rows.map((row) => row.id);
      }),
    /** Bulk review/export use the same cards, status rules and stock summaries as the grid. */
    selected: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const ids = z.array(z.uuid()).max(1000).parse(input);
        return cardsForItems(tx, ids, idList(await fulfillableLocationIds(tx)));
      }),
    /** Private, catalog-only export selector; no balances, movements or SaleListing data. */
    exportRecords: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const ids = z.array(z.uuid()).max(1000).parse(input);
        const rows = await tx.merchandiseItem.findMany({
          where: { id: { in: ids } },
          select: {
            ...cardSelection,
            saleListing: false,
            privateNotes: true,
            category: { select: { id: true, name: true, slug: true } },
            sources: {
              select: { provider: true, sourceType: true, url: true },
              orderBy: { id: "asc" },
            },
          },
        });
        const byId = new Map(rows.map((row) => [row.id, row]));
        return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      }),
    /**
     * One indexed page of merchandise. Three statements run per request: the filtered page
     * of IDs with its total, the relations for those IDs, and their per-location stock.
     */
    list: (input: unknown = {}, sourcingInput?: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const filters = catalogFilterSchema.parse(input);
        const fulfillable = idList(await fulfillableLocationIds(tx));
        const sourcing =
          sourcingInput === undefined
            ? null
            : sourcingFilterSchema.parse(sourcingInput);
        const predicates = [whereClause(filters, fulfillable)];
        if (sourcing) predicates.push(Prisma.sql`w.enabled = true`);
        if (sourcing?.below === "yes")
          predicates.push(
            Prisma.sql`w.target_quantity IS NOT NULL AND w.target_quantity > COALESCE(st.total, 0)`,
          );
        if (sourcing?.checked === "never")
          predicates.push(Prisma.sql`w.last_checked_at IS NULL`);
        else if (sourcing && sourcing.checked !== "any") {
          const cutoff = new Date(
            Date.now() - Number(sourcing.checked) * 86_400_000,
          );
          predicates.push(
            Prisma.sql`(w.last_checked_at IS NULL OR w.last_checked_at <= ${cutoff})`,
          );
        }
        if (sourcing?.country) {
          const locations = (await locationPaths(tx))
            .filter((row) => row.effectiveCountry === sourcing.country)
            .map((row) => row.id);
          predicates.push(
            Prisma.sql`EXISTS (SELECT 1 FROM inventory_balances b WHERE b.merchandise_item_id = i.id AND b.quantity > 0 AND b.storage_location_id IN ${idList(locations)})`,
          );
        }
        const where = Prisma.join(predicates, " AND ");
        const needsStock =
          filters.sort === "stock" ||
          filters.sort === "fulfillable" ||
          sourcing?.sort === "gap" ||
          sourcing?.below === "yes";
        const stockCte = needsStock
          ? Prisma.sql`WITH stock AS (${inventoryTotalsSql(fulfillable)})`
          : Prisma.empty;
        const stockJoin = needsStock
          ? Prisma.sql`LEFT JOIN stock st ON st.item_id = i.id`
          : Prisma.empty;
        const sourcingOrder = sourcing
          ? {
              priority: orderClause("priority"),
              gap: Prisma.sql`CASE WHEN w.target_quantity IS NULL THEN NULL ELSE GREATEST(w.target_quantity - COALESCE(st.total, 0), 0) END DESC NULLS LAST`,
              "release-desc": orderClause("release-desc"),
              "watch-added": Prisma.sql`w.created_at DESC`,
              checked: Prisma.sql`w.last_checked_at ASC NULLS FIRST`,
              msrp: Prisma.sql`i.official_msrp_currency ASC NULLS LAST, i.official_msrp_amount ASC NULLS LAST`,
              "max-price": Prisma.sql`w.max_unit_price_currency ASC, w.max_unit_price_amount ASC NULLS LAST`,
            }[sourcing.sort]
          : orderClause(filters.sort);
        const selectPage = (page: number) =>
          tx.$queryRaw<{ id: string; total: bigint }[]>(Prisma.sql`
          ${stockCte}
          SELECT i.id::text AS id, count(*) OVER ()::bigint AS total
          FROM merchandise_items i
          JOIN lineups l ON l.id = i.lineup_id
          JOIN franchises f ON f.id = l.franchise_id
          LEFT JOIN purchase_watches w ON w.merchandise_item_id = i.id
          LEFT JOIN sale_listings s ON s.merchandise_item_id = i.id
          ${stockJoin}
          WHERE ${where}
          ORDER BY ${sourcingOrder}, i.id ASC
          LIMIT ${filters.size} OFFSET ${(page - 1) * filters.size}
        `);

        let page = filters.page;
        let selected = await selectPage(page);
        let total = Number(selected[0]?.total ?? 0);
        if (!selected.length && page > 1) {
          // Only an out-of-range page pays for a second pass; it is then clamped to the last one.
          const [counted] = await tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
            ${stockCte}
            SELECT count(*)::bigint AS total
            FROM merchandise_items i
            JOIN lineups l ON l.id = i.lineup_id
            JOIN franchises f ON f.id = l.franchise_id
            LEFT JOIN purchase_watches w ON w.merchandise_item_id = i.id
            LEFT JOIN sale_listings s ON s.merchandise_item_id = i.id
            ${stockJoin}
            WHERE ${where}
          `);
          total = Number(counted?.total ?? 0);
          page = Math.max(1, Math.ceil(total / filters.size));
          selected = total ? await selectPage(page) : [];
          total = Number(selected[0]?.total ?? total);
        }
        const ids = selected.map((row) => row.id);
        return {
          items: await cardsForItems(tx, ids, fulfillable),
          total,
          pageCount: Math.max(1, Math.ceil(total / filters.size)),
          filters: { ...filters, page },
        };
      }),

    /** Bounded option lists for the filter panel; scoped to the selected franchise. */
    facets: (input: unknown = {}) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const filters = catalogFilterSchema.parse(input);
        const scope = filters.franchise
          ? { franchiseId: filters.franchise }
          : {};
        const franchises = await tx.franchise.findMany({
          select: { id: true, name: true, archivedAt: true },
          orderBy: { name: "asc" },
          take: 500,
        });
        // A truncated option list must never silently drop the option that is currently
        // applied, or reloading a filtered page would quietly clear that filter. The selected
        // record is therefore always unioned back in, and the caller is told the real total so
        // the operator can see that refinement is needed rather than assuming they saw
        // everything. NFKC matching mirrors the catalog search so Japanese names behave the same.
        const optionLimit = 200;
        const selected = async <T extends { id: string }>(
          rows: T[],
          id: string | undefined,
          load: () => Promise<T | null>,
        ) => (!id || rows.some((row) => row.id === id) ? rows : [...(await load().then((row) => (row ? [row] : []))), ...rows]);

        const lineupWhere = {
          ...scope,
          ...(filters.lineupQuery
            ? { name: { contains: filters.lineupQuery, mode: "insensitive" as const } }
            : {}),
        };
        const lineupTotal = await tx.lineup.count({ where: lineupWhere });
        const lineups = await selected(
          await tx.lineup.findMany({
            where: lineupWhere,
            select: { id: true, name: true },
            orderBy: { name: "asc" },
            take: optionLimit,
          }),
          filters.lineup,
          () => tx.lineup.findUnique({ where: { id: filters.lineup! }, select: { id: true, name: true } }),
        );
        const characterWhere = {
          ...scope,
          ...(filters.characterQuery
            ? { name: { contains: filters.characterQuery, mode: "insensitive" as const } }
            : {}),
        };
        const characterTotal = await tx.character.count({ where: characterWhere });
        const characters = await selected(
          await tx.character.findMany({
            where: characterWhere,
            select: { id: true, name: true, japaneseName: true },
            orderBy: { name: "asc" },
            take: optionLimit,
          }),
          filters.character,
          () => tx.character.findUnique({ where: { id: filters.character! }, select: { id: true, name: true, japaneseName: true } }),
        );
        const categories = await tx.category.findMany({
          select: { id: true, name: true },
          orderBy: { name: "asc" },
          take: 500,
        });
        const locations = await tx.storageLocation.findMany({
          select: { id: true, code: true, name: true, type: true },
          orderBy: { code: "asc" },
          take: 500,
        });
        const manufacturers = await tx.$queryRaw<{ name: string }[]>(Prisma.sql`
          SELECT DISTINCT ${manufacturer} AS name
          FROM merchandise_items i JOIN lineups l ON l.id = i.lineup_id
          WHERE ${manufacturer} IS NOT NULL ORDER BY name ASC LIMIT 500
        `);
        const years = await tx.$queryRaw<{ year: number }[]>(Prisma.sql`
          SELECT DISTINCT EXTRACT(YEAR FROM ${release})::int AS year
          FROM merchandise_items i JOIN lineups l ON l.id = i.lineup_id
          WHERE ${release} IS NOT NULL ORDER BY year DESC LIMIT 200
        `);
        return {
          franchises,
          lineups,
          characters,
          optionLimit,
          lineupTotal,
          characterTotal,
          categories,
          locations,
          manufacturers: manufacturers.map((row) => row.name),
          years: years.map((row) => row.year),
        };
      }),

    /** Everything the item detail page groups into catalog, sourcing, inventory and sale. */
    detail: (id: string) =>
      withInternalTransaction(database, authorize, async (tx) => {
        if (!z.uuid().safeParse(id).success) return null;
        const item = await tx.merchandiseItem.findUnique({
          where: { id },
          select: {
            ...cardSelection,
            slug: true,
            aliases: true,
            description: true,
            privateNotes: true,
            createdAt: true,
            updatedAt: true,
            images: {
              select: {
                id: true,
                storageKey: true,
                originalUrl: true,
                sourceUrl: true,
                sourceProvider: true,
                imageRole: true,
                caption: true,
                approvedForPublicUse: true,
              },
              orderBy: [
                { imageRole: "asc" },
                { displayOrder: "asc" },
                { id: "asc" },
              ],
            },
            sources: {
              select: {
                id: true,
                provider: true,
                sourceType: true,
                url: true,
                checkedAt: true,
                notes: true,
              },
              orderBy: { createdAt: "asc" },
            },
            purchaseWatch: true,
            saleListing: true,
          },
        });
        if (!item) return null;
        const fulfillable = idList(await fulfillableLocationIds(tx));
        const stock =
          (await stockForItems(tx, [item.id], fulfillable)).get(item.id) ?? [];
        const movements = await tx.inventoryMovement.count({
          where: { merchandiseItemId: item.id },
        });
        const { images, sources, purchaseWatch, saleListing, ...card } = item;
        return {
          ...toCard(
            { ...card, images: images.slice(0, 1), purchaseWatch, saleListing },
            stock,
          ),
          images,
          sources,
          purchaseWatch,
          saleListing,
          movementCount: movements,
          slug: item.slug,
          aliases: item.aliases,
          description: item.description,
          privateNotes: item.privateNotes,
        };
      }),

    /** Paginated movement history for one item; history itself is append-only. */
    movements: (id: string, input: unknown = {}) =>
      withInternalTransaction(database, authorize, async (tx) => {
        if (!z.uuid().safeParse(id).success) return null;
        const filters = movementFilterSchema.parse(input);
        const { page, size } = filters;
        const item = await tx.merchandiseItem.findUnique({
          where: { id },
          select: { id: true, name: true, japaneseName: true, lineupId: true },
        });
        if (!item) return null;
        const where: Prisma.InventoryMovementWhereInput = {
          merchandiseItemId: id,
          ...(filters.type ? { movementType: filters.type } : {}),
          ...(filters.location
            ? {
                OR: [
                  { sourceLocationId: filters.location },
                  { destinationLocationId: filters.location },
                ],
              }
            : {}),
          ...(filters.from || filters.to
            ? {
                createdAt: {
                  ...(filters.from
                    ? { gte: new Date(`${filters.from}T00:00:00Z`) }
                    : {}),
                  ...(filters.to
                    ? {
                        lt: new Date(
                          new Date(`${filters.to}T00:00:00Z`).getTime() +
                            86_400_000,
                        ),
                      }
                    : {}),
                },
              }
            : {}),
        };
        const total = await tx.inventoryMovement.count({ where });
        const pageCount = Math.max(1, Math.ceil(total / size));
        const current = Math.min(page, pageCount);
        const rows = await tx.inventoryMovement.findMany({
          where,
          select: {
            id: true,
            movementType: true,
            quantityDelta: true,
            createdAt: true,
            notes: true,
            referenceType: true,
            referenceId: true,
            operationKey: true,
            acquisitionUnitCostAmount: true,
            acquisitionUnitCostCurrency: true,
            sourceLocation: { select: { id: true, code: true, name: true } },
            destinationLocation: {
              select: { id: true, code: true, name: true },
            },
            actorUser: { select: { id: true, name: true, email: true } },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: size,
          skip: (current - 1) * size,
        });
        const locations = await locationPaths(tx);
        const paths = new Map(
          locations.map((location) => [location.id, location.path]),
        );
        return {
          item,
          rows: rows.map((row) => ({
            ...row,
            sourcePath: row.sourceLocation
              ? (paths.get(row.sourceLocation.id) ?? row.sourceLocation.code)
              : null,
            destinationPath: row.destinationLocation
              ? (paths.get(row.destinationLocation.id) ??
                row.destinationLocation.code)
              : null,
          })),
          locations,
          total,
          page: current,
          pageCount,
          size,
          filters: { ...filters, page: current },
        };
      }),
  };
}
