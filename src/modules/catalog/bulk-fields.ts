/**
 * Field naming shared by row validation and the bulk editor. This module holds no
 * dependencies so the client bundle can format issues without the validation stack.
 */
export type RowIssue = { row: number; field: string; message: string };

const fieldLabels: Record<string, string> = {
  name: "English name",
  japaneseName: "Japanese name",
  categoryId: "Category",
  characterIds: "Characters",
  internalSku: "Internal SKU",
  janCode: "JAN code",
  manufacturer: "Manufacturer",
  releaseDate: "Release date",
  officialMsrpAmount: "Official MSRP",
  officialMsrpCurrency: "MSRP currency",
  officialMsrpTaxInclusion: "MSRP tax status",
  privateNotes: "Private notes",
  image: "Primary image",
  "source.provider": "Source provider",
  "source.sourceType": "Source type",
  "source.url": "Source URL",
  "watch.targetQuantity": "Target quantity",
  "watch.maxUnitPriceAmount": "Maximum unit price",
  "watch.maxUnitPriceCurrency": "Maximum price currency",
  "watch.priority": "Watch priority",
  "watch.conditionPreference": "Condition preference",
  "watch.marketplaceSearchQuery": "Marketplace search query",
  "watch.notes": "Watch notes",
};
export function fieldLabel(field: string) {
  return fieldLabels[field] ?? field ?? "Item";
}
export function formatRowIssue({ row, field, message }: RowIssue) {
  return `Row ${row} — ${fieldLabel(field)}: ${message}`;
}
