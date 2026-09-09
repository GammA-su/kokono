import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { DomainError } from "../shared/errors";
import { generatedSlug } from "../lineups/service";
import { allocateInternalSkus } from "./sku";
import {
  bulkBatchSchema,
  bulkRowSchema,
  rowIssues,
  type BulkRow,
  type RowIssue,
} from "./bulk-validation";
import { detectDuplicates, type DuplicateWarning } from "./duplicates";

export class BulkEntryError extends DomainError {
  constructor(
    code: string,
    message: string,
    public readonly issues: RowIssue[] = [],
    public readonly warnings: DuplicateWarning[] = [],
  ) {
    super(code, message);
    this.name = "BulkEntryError";
  }
}

type Candidate = { row: number; value: BulkRow };

async function inspectBatch(
  tx: Prisma.TransactionClient,
  input: unknown,
  lock: boolean,
) {
  const batch = bulkBatchSchema.parse(input);
  // The lineup lock also serializes internal SKU allocation for this lineup.
  if (lock)
    await tx.$queryRaw`SELECT id FROM lineups WHERE id = ${batch.lineupId}::uuid FOR UPDATE`;
  const lineup = await tx.lineup.findFirst({
    where: {
      id: batch.lineupId,
      archivedAt: null,
      franchise: { archivedAt: null },
    },
    select: { id: true, slug: true, franchiseId: true },
  });
  if (!lineup)
    throw new DomainError(
      "LINEUP_UNAVAILABLE",
      "Choose an active lineup in an active franchise.",
    );

  const issues: RowIssue[] = [];
  const parsed: Candidate[] = [];
  batch.rows.forEach((raw, index) => {
    const result = bulkRowSchema.safeParse(raw);
    if (result.success) parsed.push({ row: index + 1, value: result.data });
    else issues.push(...rowIssues(index + 1, result.error));
  });

  const categoryIds = [...new Set(parsed.map(({ value }) => value.categoryId))];
  const knownCategories = new Set(
    (
      await tx.category.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
  const characterIds = [
    ...new Set(parsed.flatMap(({ value }) => value.characterIds)),
  ];
  const knownCharacters = new Set(
    (
      await tx.character.findMany({
        where: { id: { in: characterIds } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
  const manualSkus = parsed
    .map(({ value }) => value.internalSku)
    .filter((sku): sku is string => Boolean(sku));
  const takenSkus = new Set(
    (
      await tx.merchandiseItem.findMany({
        where: { internalSku: { in: manualSkus } },
        select: { internalSku: true },
      })
    ).map((row) => row.internalSku),
  );

  const batchSkus = new Map<string, number>();
  for (const { row, value } of parsed) {
    if (!knownCategories.has(value.categoryId))
      issues.push({
        row,
        field: "categoryId",
        message: "Select an existing category.",
      });
    for (const characterId of value.characterIds)
      if (!knownCharacters.has(characterId))
        issues.push({
          row,
          field: "characterIds",
          message:
            "One selected character no longer exists. Reload the editor.",
        });
    if (value.internalSku) {
      // Strong conflicts are rejected: internal SKUs are globally unique identities.
      if (takenSkus.has(value.internalSku))
        issues.push({
          row,
          field: "internalSku",
          message: `The internal SKU ${value.internalSku} already exists. Use a unique SKU or leave it blank to generate one.`,
        });
      const earlier = batchSkus.get(value.internalSku);
      if (earlier)
        issues.push({
          row,
          field: "internalSku",
          message: `Row ${earlier} already uses the internal SKU ${value.internalSku}.`,
        });
      else batchSkus.set(value.internalSku, row);
    }
  }

  const failedRows = new Set(issues.map((issue) => issue.row));
  const clean = parsed.filter(({ row }) => !failedRows.has(row));
  const warnings = await detectDuplicates(tx, lineup.id, clean);
  return { batch, lineup, clean, issues, warnings };
}

function watchData(row: BulkRow) {
  const { watch } = row;
  const configured =
    watch.enabled ||
    watch.targetQuantity !== null ||
    watch.maxUnitPriceAmount !== null ||
    watch.conditionPreference !== null ||
    watch.marketplaceSearchQuery !== null ||
    watch.notes !== null;
  // A watch record holds its configuration whether or not it is currently enabled.
  return configured ? watch : null;
}
function imageData(row: BulkRow) {
  if (!row.image) return null;
  const remote = /^https?:\/\//.test(row.image);
  return {
    storageKey: row.image,
    imageRole: "PRIMARY" as const,
    displayOrder: 0,
    // Remote images are referenced, never fetched into the database or onto this server.
    originalUrl: remote ? row.image : null,
    sourceUrl: row.source?.url ?? null,
    sourceProvider: row.source?.provider ?? null,
  };
}

export function createBulkEntryService(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    /** Validates and reports duplicates without writing anything. */
    review: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const { clean, issues, warnings } = await inspectBatch(
          tx,
          input,
          false,
        );
        return { valid: clean.length, issues, warnings };
      }),
    /** Validates every row first, then persists the whole batch in one transaction. */
    save: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const { batch, lineup, clean, issues, warnings } = await inspectBatch(
          tx,
          input,
          true,
        );
        if (issues.length)
          throw new BulkEntryError(
            "INVALID_ROWS",
            `${issues.length} problem${issues.length === 1 ? "" : "s"} must be corrected before saving. No items were created.`,
            issues,
            warnings,
          );
        if (warnings.length && !batch.acknowledgeDuplicates)
          throw new BulkEntryError(
            "DUPLICATE_REVIEW",
            `${warnings.length} possible duplicate${warnings.length === 1 ? "" : "s"} found. Review them, then save again to confirm. No items were created.`,
            [],
            warnings,
          );
        const generated = await allocateInternalSkus(
          tx,
          lineup,
          clean.filter(({ value }) => !value.internalSku).length,
          clean
            .map(({ value }) => value.internalSku)
            .filter((sku): sku is string => Boolean(sku)),
        );
        const created: { id: string; name: string; internalSku: string }[] = [];
        for (const { value } of clean) {
          const item = await createValidatedCatalogItem(
            tx,
            lineup.id,
            value,
            value.internalSku ?? generated.shift()!,
          );
          created.push(item);
        }
        return { lineupId: lineup.id, created };
      }),
  };
}

/** Shared domain writer for the grid and reviewed CSV rows. Caller validates and owns the transaction. */
export async function createValidatedCatalogItem(
  tx: Prisma.TransactionClient,
  lineupId: string,
  value: BulkRow,
  internalSku: string,
  id?: string,
  forceWatch = false,
) {
  const source = value.source;
  const image = imageData(value);
  const watch = forceWatch ? value.watch : watchData(value);
  return tx.merchandiseItem.create({
    data: {
      ...(id ? { id } : {}),
      lineupId,
      internalSku,
      name: value.name,
      japaneseName: value.japaneseName,
      slug: generatedSlug(value.name),
      janCode: value.janCode,
      categoryId: value.categoryId,
      manufacturer: value.manufacturer,
      officialMsrpAmount: value.officialMsrpAmount,
      officialMsrpCurrency: value.officialMsrpCurrency,
      officialMsrpTaxInclusion: value.officialMsrpTaxInclusion,
      releaseDate: value.releaseDate?.date ?? null,
      releaseDatePrecision: value.releaseDate?.precision ?? null,
      privateNotes: value.privateNotes,
      characters: {
        create: value.characterIds.map((characterId) => ({ characterId })),
      },
      ...(source ? { sources: { create: [source] } } : {}),
      ...(image ? { images: { create: [image] } } : {}),
      ...(watch ? { purchaseWatch: { create: watch } } : {}),
    },
    select: { id: true, name: true, internalSku: true },
  });
}
