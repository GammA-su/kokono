import type { DatePrecision } from "../../generated/prisma/enums";

/**
 * Catalog presentation rules shared by the grid, the item detail page and the tests.
 * Nothing here reads the database, so every surface labels an item identically.
 */
export type CatalogStatus =
  | "ARCHIVED"
  | "LIVE"
  | "OUT_OF_STOCK"
  | "IN_STOCK"
  | "WATCHING"
  | "CATALOG_ONLY";

export const catalogStatusLabels: Record<CatalogStatus, string> = {
  ARCHIVED: "Archived",
  LIVE: "Live",
  OUT_OF_STOCK: "Out of stock",
  IN_STOCK: "In stock",
  WATCHING: "Watching",
  CATALOG_ONLY: "Catalog only",
};

export type StatusInput = {
  archived: boolean;
  published: boolean;
  totalStock: number;
  fulfillableStock: number;
  watching: boolean;
};

/**
 * An item can hold several states at once: owned stock, an active watch and a listing are
 * independent. Archived merchandise never advertises a live listing.
 */
export function catalogStatuses(item: StatusInput): CatalogStatus[] {
  const statuses: CatalogStatus[] = [];
  if (item.archived) statuses.push("ARCHIVED");
  if (item.published && !item.archived)
    statuses.push(item.fulfillableStock > 0 ? "LIVE" : "OUT_OF_STOCK");
  if (item.totalStock > 0) statuses.push("IN_STOCK");
  if (item.watching) statuses.push("WATCHING");
  if (!item.archived && !item.published && item.totalStock === 0)
    statuses.push("CATALOG_ONLY");
  return statuses;
}

export type StockLocationRow = {
  locationId: string;
  code: string;
  name: string;
  type: string;
  quantity: number;
  fulfillable: boolean;
  path?: string;
  effectiveActive?: boolean;
  countryCode?: string | null;
};
export type StockSummary = {
  total: number;
  fulfillable: number;
  locations: StockLocationRow[];
  countries: Record<string, number>;
  buckets: { label: string; quantity: number; transit: boolean }[];
};

/**
 * Compact grouping for cards. Location codes are identifiers, so the segment before the
 * first hyphen is used as the display bucket (`JP-WAREHOUSE` reads as `JP`); anything in
 * transit is grouped separately because those units are owned but not on hand.
 */
export function stockBucketLabel(location: { code: string; type: string }) {
  if (location.type === "IN_TRANSIT") return "Transit";
  const [prefix] = location.code.split("-");
  return prefix || location.code;
}
export function summarizeStock(rows: StockLocationRow[]): StockSummary {
  const buckets = new Map<
    string,
    { label: string; quantity: number; transit: boolean }
  >();
  let total = 0;
  const countries: Record<string, number> = {};
  let fulfillable = 0;
  for (const row of rows) {
    total += row.quantity;
    if (row.countryCode)
      countries[row.countryCode] =
        (countries[row.countryCode] ?? 0) + row.quantity;
    if (row.fulfillable) fulfillable += row.quantity;
    const label = stockBucketLabel(row);
    const bucket = buckets.get(label) ?? {
      label,
      quantity: 0,
      transit: row.type === "IN_TRANSIT",
    };
    bucket.quantity += row.quantity;
    buckets.set(label, bucket);
  }
  return {
    total,
    fulfillable,
    locations: [...rows].sort((a, b) => b.quantity - a.quantity),
    countries,
    buckets: [...buckets.values()].sort((a, b) => b.quantity - a.quantity),
  };
}

/** The item's own release date, falling back to the lineup's, always with its precision. */
export function effectiveRelease(item: {
  releaseDate: Date | null;
  releaseDatePrecision: DatePrecision | null;
  lineup: {
    releaseDate: Date | null;
    releaseDatePrecision: DatePrecision | null;
  };
}) {
  return item.releaseDate
    ? {
        date: item.releaseDate,
        precision: item.releaseDatePrecision,
        inherited: false,
      }
    : {
        date: item.lineup.releaseDate,
        precision: item.lineup.releaseDatePrecision,
        inherited: item.lineup.releaseDate !== null,
      };
}
