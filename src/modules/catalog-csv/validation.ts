import { z } from "zod";
import { SourceType } from "../../generated/prisma/enums";
import type { Prisma } from "../../generated/prisma/client";
import { bulkRowSchema } from "../catalog/bulk-validation";
import { parsePartialDate } from "../catalog/partial-date";
import { DomainError } from "../shared/errors";
import { decodeCharacters, type CsvRow } from "./format";

export const existingInclude = {
  characters: { orderBy: { characterId: "asc" as const } },
  purchaseWatch: true,
  sources: { orderBy: { id: "asc" as const } },
  images: { orderBy: { id: "asc" as const } },
};
export type ExistingItem = Prisma.MerchandiseItemGetPayload<{
  include: typeof existingInclude;
}>;
export type References = {
  categories: { id: string; name: string; slug: string }[];
  characters: { id: string; name: string; japaneseName: string | null }[];
};
export const present = (row: CsvRow, field: keyof CsvRow) =>
  typeof row[field] === "string" && row[field]!.trim() !== "";
export function ownDate(item: ExistingItem | null) {
  return (
    item?.releaseDate
      ?.toISOString()
      .slice(
        0,
        item.releaseDatePrecision === "YEAR"
          ? 4
          : item.releaseDatePrecision === "MONTH"
            ? 7
            : 10,
      ) ?? null
  );
}
const sourceSchema = z
  .object({
    provider: z.string().trim().min(1).max(200),
    source_type: z.enum(SourceType),
    url: z.url({ protocol: /^https?$/ }).max(2048),
  })
  .strict();
export function csvSources(row: CsvRow) {
  const raw: unknown[] = [];
  if (present(row, "source_url") || present(row, "source_provider"))
    raw.push({
      provider: row.source_provider?.trim() ?? "",
      source_type: row.source_type?.trim() || "OTHER",
      url: row.source_url?.trim() ?? "",
    });
  if (present(row, "sources_json")) {
    try {
      raw.push(
        ...z.array(z.unknown()).max(100).parse(JSON.parse(row.sources_json!)),
      );
    } catch {
      throw new DomainError(
        "CSV_SOURCES",
        "sources_json must be a JSON array of {provider, source_type, url} objects (maximum 100).",
      );
    }
  }
  const sources = z.array(sourceSchema).max(101).parse(raw);
  const byUrl = new Map<string, (typeof sources)[number]>();
  for (const source of sources) {
    const earlier = byUrl.get(source.url);
    if (
      earlier &&
      (earlier.provider !== source.provider ||
        earlier.source_type !== source.source_type)
    )
      throw new DomainError(
        "CSV_SOURCES",
        "The same source URL has conflicting provider/type values.",
      );
    byUrl.set(source.url, source);
  }
  return [...byUrl.values()].map(({ source_type, ...source }) => ({
    ...source,
    sourceType: source_type,
  }));
}
export function validateCsvRow(
  row: CsvRow,
  refs: References,
  current: ExistingItem | null,
) {
  const value = (field: keyof CsvRow, fallback: unknown = null) =>
    present(row, field) ? row[field]!.trim() : fallback;
  const categoryText = value("category") as string | null;
  const matches = categoryText
    ? refs.categories.filter(
        (category) =>
          category.slug === categoryText || category.name === categoryText,
      )
    : [];
  const slugMatch = matches.find((category) => category.slug === categoryText);
  const categoryId = categoryText
    ? (slugMatch?.id ?? (matches.length === 1 ? matches[0].id : null))
    : current?.categoryId;
  if (!categoryId)
    throw new DomainError(
      "CSV_CATEGORY",
      categoryText
        ? `Category '${categoryText}' is unknown or ambiguous. Use an existing category slug.`
        : "A category is required to create merchandise.",
    );
  const characterIds = present(row, "characters")
    ? decodeCharacters(row.characters!).map((name) => {
        const matches = refs.characters.filter(
          (character) =>
            character.name === name || character.japaneseName === name,
        );
        if (matches.length !== 1)
          throw new DomainError(
            "CSV_CHARACTER",
            `Character '${name}' is unknown or ambiguous in this franchise. Create/fix the character before importing.`,
          );
        return matches[0].id;
      })
    : (current?.characters.map((link) => link.characterId) ?? []);
  const release = value("release_date", ownDate(current)) as string | null;
  if (present(row, "release_date_precision")) {
    const precision = z
      .enum(["YEAR", "MONTH", "DAY"])
      .parse(row.release_date_precision!.trim());
    if (!release || parsePartialDate(release).precision !== precision)
      throw new DomainError(
        "CSV_DATE",
        "release_date and release_date_precision disagree. Use YYYY / YEAR, YYYY-MM / MONTH, or YYYY-MM-DD / DAY.",
      );
  }
  const watch = current?.purchaseWatch;
  let enabled = watch?.enabled ?? false;
  if (present(row, "watch_enabled")) {
    const text = row.watch_enabled!.trim().toLowerCase();
    if (!["true", "false", "1", "0"].includes(text))
      throw new DomainError(
        "CSV_WATCH",
        "watch_enabled must be true, false, 1 or 0.",
      );
    enabled = text === "true" || text === "1";
  }
  if (
    present(row, "official_msrp_amount") &&
    !present(row, "official_msrp_currency") &&
    !current?.officialMsrpCurrency
  )
    throw new DomainError(
      "CSV_MSRP",
      "Provide official_msrp_currency with the MSRP amount.",
    );
  if (
    present(row, "watch_max_price_amount") &&
    !present(row, "watch_max_price_currency") &&
    !watch?.maxUnitPriceCurrency
  )
    throw new DomainError(
      "CSV_WATCH",
      "Provide watch_max_price_currency with the maximum price amount.",
    );
  const sources = csvSources(row);
  const result = bulkRowSchema.parse({
    name: value("name", current?.name ?? ""),
    japaneseName: value("japanese_name", current?.japaneseName),
    internalSku: value("internal_sku", current?.internalSku),
    categoryId,
    characterIds,
    janCode: value("jan_code", current?.janCode),
    manufacturer: value("manufacturer", current?.manufacturer),
    releaseDate: release,
    officialMsrpAmount: value(
      "official_msrp_amount",
      current?.officialMsrpAmount,
    ),
    officialMsrpCurrency: value(
      "official_msrp_currency",
      current?.officialMsrpCurrency ?? "JPY",
    ),
    officialMsrpTaxInclusion: value(
      "official_msrp_tax_state",
      current?.officialMsrpTaxInclusion ?? "UNKNOWN",
    ),
    privateNotes: value("private_notes", current?.privateNotes),
    image: value("image_url"),
    source: sources[0] ?? undefined,
    watch: {
      enabled,
      targetQuantity: value("watch_target_quantity", watch?.targetQuantity),
      maxUnitPriceAmount: value(
        "watch_max_price_amount",
        watch?.maxUnitPriceAmount,
      ),
      maxUnitPriceCurrency: value(
        "watch_max_price_currency",
        watch?.maxUnitPriceCurrency ?? "JPY",
      ),
      priority: value("watch_priority", watch?.priority ?? "NORMAL"),
      conditionPreference: value("watch_condition", watch?.conditionPreference),
      marketplaceSearchQuery: value(
        "marketplace_search_query",
        watch?.marketplaceSearchQuery,
      ),
    },
  });
  if (
    result.officialMsrpAmount === null &&
    present(row, "official_msrp_tax_state") &&
    row.official_msrp_tax_state!.trim() !== "UNKNOWN"
  )
    throw new DomainError(
      "CSV_MSRP",
      "A known tax state requires an MSRP amount.",
    );
  return { value: result, sources };
}
