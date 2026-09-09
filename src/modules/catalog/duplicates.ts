import type { Prisma } from "../../generated/prisma/client";
import type { BulkRow } from "./bulk-validation";

export type DuplicateSignal = "JAN" | "JAPANESE_NAME" | "NAME" | "ATTRIBUTES";
export type DuplicateWarning = {
  row: number;
  signal: DuplicateSignal;
  message: string;
  existingItemId?: string;
};

/** Comparison form only: full-width, case and punctuation differences stop hiding repeats. */
export function normalizedName(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** CSV identity review: hard SKU, global JAN, exact Japanese name and normalized display name within a lineup. */
export function catalogDuplicateSignals(
  candidate: {
    internalSku?: string | null;
    janCode?: string | null;
    name?: string | null;
    japaneseName?: string | null;
    lineupId: string;
  },
  existing: {
    internalSku?: string | null;
    janCode?: string | null;
    name?: string | null;
    japaneseName?: string | null;
    lineupId: string;
  },
) {
  const signals: string[] = [];
  if (candidate.internalSku && candidate.internalSku === existing.internalSku)
    signals.push("SKU");
  if (candidate.janCode && candidate.janCode === existing.janCode)
    signals.push("JAN");
  if (candidate.lineupId === existing.lineupId) {
    if (
      candidate.japaneseName &&
      candidate.japaneseName === existing.japaneseName
    )
      signals.push("JAPANESE_NAME");
    if (
      candidate.name &&
      existing.name &&
      normalizedName(candidate.name) &&
      normalizedName(candidate.name) === normalizedName(existing.name)
    )
      signals.push("NAME");
  }
  return signals;
}
function attributeKey(row: {
  categoryId: string;
  characterIds: string[];
  officialMsrpAmount: number | null;
  officialMsrpCurrency: string | null;
}) {
  // Requires characters: category plus an absent MSRP alone would flag unrelated items.
  if (!row.characterIds.length) return null;
  return [
    row.categoryId,
    row.officialMsrpAmount ?? "none",
    row.officialMsrpCurrency ?? "none",
    [...row.characterIds].sort().join("+"),
  ].join("|");
}

/**
 * Reports weak duplicate signals for review. It never rejects: the administrator decides.
 * Strong conflicts (an existing internal SKU, unique constraints) are handled by the service.
 */
export async function detectDuplicates(
  tx: Prisma.TransactionClient,
  lineupId: string,
  candidates: { row: number; value: BulkRow }[],
) {
  const warnings: DuplicateWarning[] = [];
  const janCodes = candidates
    .map(({ value }) => value.janCode)
    .filter((code): code is string => Boolean(code));
  const existing = await tx.merchandiseItem.findMany({
    where: { lineupId },
    select: {
      id: true,
      name: true,
      japaneseName: true,
      janCode: true,
      categoryId: true,
      officialMsrpAmount: true,
      officialMsrpCurrency: true,
      characters: { select: { characterId: true } },
    },
  });
  const janMatches = janCodes.length
    ? await tx.merchandiseItem.findMany({
        where: { janCode: { in: [...new Set(janCodes)] } },
        select: {
          id: true,
          name: true,
          janCode: true,
          lineupId: true,
          lineup: { select: { name: true } },
        },
      })
    : [];

  const byJapaneseName = new Map<string, (typeof existing)[number]>();
  const byName = new Map<string, (typeof existing)[number]>();
  const byAttributes = new Map<string, (typeof existing)[number]>();
  for (const item of existing) {
    if (item.japaneseName)
      byJapaneseName.set(normalizedName(item.japaneseName), item);
    byName.set(normalizedName(item.name), item);
    const key = attributeKey({
      categoryId: item.categoryId,
      characterIds: item.characters.map((link) => link.characterId),
      officialMsrpAmount: item.officialMsrpAmount,
      officialMsrpCurrency: item.officialMsrpCurrency,
    });
    if (key) byAttributes.set(key, item);
  }

  const seenJan = new Map<string, number>();
  const seenJapaneseName = new Map<string, number>();
  const seenName = new Map<string, number>();
  const seenAttributes = new Map<string, number>();
  for (const { row, value } of candidates) {
    if (value.janCode) {
      const earlier = seenJan.get(value.janCode);
      if (earlier)
        warnings.push({
          row,
          signal: "JAN",
          message: `Possible duplicate — row ${earlier} in this batch uses JAN ${value.janCode} as well.`,
        });
      else seenJan.set(value.janCode, row);
      for (const match of janMatches.filter(
        (item) => item.janCode === value.janCode,
      )) {
        warnings.push({
          row,
          signal: "JAN",
          existingItemId: match.id,
          message:
            match.lineupId === lineupId
              ? `Possible duplicate — JAN ${value.janCode} already belongs to “${match.name}” in this lineup.`
              : `Possible duplicate — JAN ${value.janCode} is also recorded on “${match.name}” in the lineup “${match.lineup.name}”. Assortment codes may be shared.`,
        });
      }
    }
    if (value.japaneseName) {
      const key = normalizedName(value.japaneseName);
      const earlier = seenJapaneseName.get(key);
      if (earlier)
        warnings.push({
          row,
          signal: "JAPANESE_NAME",
          message: `Possible duplicate — row ${earlier} in this batch uses the same Japanese name.`,
        });
      else seenJapaneseName.set(key, row);
      const match = byJapaneseName.get(key);
      if (match)
        warnings.push({
          row,
          signal: "JAPANESE_NAME",
          existingItemId: match.id,
          message: `Possible duplicate — “${match.name}” in this lineup already uses this Japanese name.`,
        });
    }
    const nameKey = normalizedName(value.name);
    const earlierName = seenName.get(nameKey);
    if (earlierName)
      warnings.push({
        row,
        signal: "NAME",
        message: `Possible duplicate — row ${earlierName} in this batch uses the same English name.`,
      });
    else seenName.set(nameKey, row);
    const nameMatch = byName.get(nameKey);
    if (nameMatch)
      warnings.push({
        row,
        signal: "NAME",
        existingItemId: nameMatch.id,
        message: `Possible duplicate — “${nameMatch.name}” in this lineup has a matching English name.`,
      });
    const key = attributeKey(value);
    if (key) {
      const earlier = seenAttributes.get(key);
      if (earlier)
        warnings.push({
          row,
          signal: "ATTRIBUTES",
          message: `Possible duplicate — row ${earlier} in this batch has the same characters, category and MSRP.`,
        });
      else seenAttributes.set(key, row);
      const match = byAttributes.get(key);
      if (match)
        warnings.push({
          row,
          signal: "ATTRIBUTES",
          existingItemId: match.id,
          message: `Possible duplicate — “${match.name}” in this lineup has the same characters, category and MSRP.`,
        });
    }
  }
  return warnings;
}
