import type { createCatalogQueries } from "../catalog/queries";
import { CSV_FORMAT, csvColumns, csvRecord, encodeCharacters } from "./format";

export type ExportItem = Awaited<
  ReturnType<ReturnType<typeof createCatalogQueries>["exportRecords"]>
>[number];
export const csvHeader = "\uFEFF" + csvRecord([...csvColumns]);
export function exportItemRecord(item: ExportItem) {
  const watch = item.purchaseWatch;
  const source = item.sources[0];
  const date =
    item.releaseDate
      ?.toISOString()
      .slice(
        0,
        item.releaseDatePrecision === "YEAR"
          ? 4
          : item.releaseDatePrecision === "MONTH"
            ? 7
            : 10,
      ) ?? "";
  const values = {
    csv_format: CSV_FORMAT,
    lineup_id: item.lineupId,
    lineup_name: item.lineup.name,
    franchise_name: item.lineup.franchise.name,
    internal_sku: item.internalSku,
    name: item.name,
    japanese_name: item.japaneseName,
    characters: encodeCharacters(
      item.characters.map((link) => link.character.name),
    ),
    category: item.category.slug,
    official_msrp_amount: item.officialMsrpAmount,
    official_msrp_currency: item.officialMsrpCurrency,
    official_msrp_tax_state: item.officialMsrpTaxInclusion,
    jan_code: item.janCode,
    release_date: date,
    release_date_precision: item.releaseDatePrecision,
    manufacturer: item.manufacturer,
    source_provider: source?.provider,
    source_type: source?.sourceType,
    source_url: source?.url,
    sources_json: item.sources.length
      ? JSON.stringify(
          item.sources.map((row) => ({
            provider: row.provider,
            source_type: row.sourceType,
            url: row.url,
          })),
        )
      : "",
    marketplace_search_query: watch?.marketplaceSearchQuery,
    watch_enabled: watch?.enabled,
    watch_target_quantity: watch?.targetQuantity,
    watch_max_price_amount: watch?.maxUnitPriceAmount,
    watch_max_price_currency: watch?.maxUnitPriceCurrency,
    watch_priority: watch?.priority,
    watch_condition: watch?.conditionPreference,
    private_notes: item.privateNotes,
    image_url: item.images[0]?.storageKey,
  };
  return csvRecord(csvColumns.map((column) => values[column]));
}
export function exportCatalogRecords(items: ExportItem[]) {
  return csvHeader + items.map(exportItemRecord).join("");
}
