import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { SourceType } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { assertInternalAccount } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { DomainError } from "../shared/errors";
import {
  bulkRowSchema,
  rowIssues,
  type RowIssue,
} from "../catalog/bulk-validation";
import { createValidatedCatalogItem } from "../catalog/bulk-entry";
import { allocateInternalSkus } from "../catalog/sku";
import { detectDuplicates } from "../catalog/duplicates";
import { extractSource } from "./adapters";
import { candidateSchema, type Candidate } from "./types";
import { downloadPublic, outboundUrl } from "./outbound";
import { matchReferences } from "./matching";
import { reviewTokens, type ReviewSnapshot } from "./review-token";

export function importFailure(error: unknown) {
  if (error instanceof DomainError) return error.message;
  if (error instanceof z.ZodError)
    return error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
  return "The source could not be processed. No partial catalog records were created. Check the page or use manual/CSV entry.";
}
async function context(
  tx: Prisma.TransactionClient,
  franchiseId: string,
  lineupId: string,
) {
  const lineup = await tx.lineup.findFirst({
    where: {
      id: lineupId,
      franchiseId,
      archivedAt: null,
      franchise: { archivedAt: null },
    },
    select: { id: true, name: true, slug: true, franchiseId: true },
  });
  if (!lineup)
    throw new DomainError(
      "IMPORT_LINEUP",
      "Select an active lineup belonging to the chosen active franchise.",
    );
  const categories = await tx.category.findMany({
    select: { id: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });
  const characters = await tx.character.findMany({
    where: { franchiseId },
    select: { id: true, name: true, japaneseName: true, aliases: true },
    orderBy: { name: "asc" },
  });
  return { lineup, categories, characters };
}
function value(row: Candidate) {
  for (const source of row.sources) {
    outboundUrl(source.url);
    z.string().trim().min(1).max(200).parse(source.provider);
  }
  for (const image of row.images) {
    outboundUrl(image.url);
    outboundUrl(image.sourceUrl);
    z.string().trim().min(1).max(200).parse(image.provider);
  }
  if (
    (row.releaseDate && !row.releaseDatePrecision) ||
    (!row.releaseDate && row.releaseDatePrecision)
  )
    throw new DomainError(
      "DATE_PRECISION",
      "Supply a release date and its precision together, or leave both blank.",
    );
  const parsed = bulkRowSchema.parse({
    name: row.name,
    japaneseName: row.japaneseName,
    categoryId: row.categoryId,
    characterIds: row.characterIds,
    janCode: row.janCode,
    manufacturer: row.manufacturer,
    releaseDate: row.releaseDate,
    officialMsrpAmount: row.officialMsrpAmount,
    officialMsrpCurrency: row.officialMsrpCurrency,
    officialMsrpTaxInclusion: row.officialMsrpTaxInclusion,
    image: row.images[0]?.url ?? null,
    source: row.sources[0],
  });
  if (
    parsed.releaseDate &&
    parsed.releaseDate.precision !== row.releaseDatePrecision
  )
    throw new DomainError(
      "DATE_PRECISION",
      "Release date and precision disagree. Use YYYY / YEAR, YYYY-MM / MONTH, or YYYY-MM-DD / DAY.",
    );
  // Keep original Japanese spelling/spacing; normalization is used only for matching.
  return { ...parsed, japaneseName: row.japaneseName || null };
}
async function inspect(
  tx: Prisma.TransactionClient,
  snapshot: ReviewSnapshot,
  rows: Candidate[],
) {
  const refs = await context(tx, snapshot.franchiseId, snapshot.lineupId);
  const issues: RowIssue[] = [],
    clean: { row: number; value: ReturnType<typeof value> }[] = [];
  rows.forEach((row, index) => {
    try {
      const parsed = value(row);
      if (!refs.categories.some((c) => c.id === parsed.categoryId))
        throw new DomainError("CATEGORY", "Select an existing category.");
      if (
        parsed.characterIds.some(
          (id) => !refs.characters.some((c) => c.id === id),
        )
      )
        throw new DomainError(
          "CHARACTER",
          "Selected characters must belong to this franchise.",
        );
      clean.push({ row: index + 1, value: parsed });
    } catch (error) {
      issues.push(
        ...(error instanceof z.ZodError
          ? rowIssues(index + 1, error)
          : [
              {
                row: index + 1,
                field: "candidate",
                message: importFailure(error),
              },
            ]),
      );
    }
  });
  const duplicates: {
    row: number;
    message: string;
    existingItemId?: string;
  }[] = await detectDuplicates(tx, snapshot.lineupId, clean);
  const evidence = (row: Candidate) => [
    ...row.sources,
    ...(snapshot.original.find((original) => original.key === row.key)
      ?.sources ?? []),
  ];
  const signals = await tx.merchandiseItem.findMany({
    where: {
      OR: [
        {
          sources: {
            some: {
              url: { in: rows.flatMap((r) => evidence(r).map((s) => s.url)) },
            },
          },
        },
        {
          images: {
            some: {
              originalUrl: {
                in: rows.flatMap((r) => r.images.map((i) => i.url)),
              },
            },
          },
        },
      ],
    },
    select: {
      id: true,
      name: true,
      sources: { select: { url: true } },
      images: { select: { originalUrl: true } },
    },
    take: 501,
  });
  if (signals.length > 500)
    throw new DomainError(
      "IMPORT_MATCHES",
      "This page matches too many existing source records. Use a narrower product page.",
    );
  rows.forEach((row, index) => {
    for (const item of signals)
      if (
        item.sources.some((s) =>
          evidence(row).some((source) => source.url === s.url),
        ) ||
        item.images.some((i) =>
          row.images.some((image) => image.url === i.originalUrl),
        )
      )
        duplicates.push({
          row: index + 1,
          existingItemId: item.id,
          message: `Shared image or source with “${item.name}”. A shared lineup page is a weak signal; review before creating another product.`,
        });
  });
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(duplicates.map((row) => JSON.stringify(row)).sort()))
    .digest("hex");
  return { ...refs, issues, clean, duplicates, fingerprint };
}

export function createAssistedImportService(
  database: PrismaClient,
  authorize: Authorize,
  secret: string,
  fetchPage: (url: string) => Promise<{ url: string; html: string }> = (
    url: string,
  ) => downloadPublic(url, "html"),
) {
  const tokens = reviewTokens(secret);
  return {
    options: () =>
      withInternalTransaction(database, authorize, async (tx) => {
        const franchises = await tx.franchise.findMany({
          where: { archivedAt: null },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        });
        const lineups = await tx.lineup.findMany({
          where: { archivedAt: null, franchise: { archivedAt: null } },
          select: { id: true, name: true, franchiseId: true },
          orderBy: { name: "asc" },
        });
        return { franchises, lineups };
      }),
    extract: async (input: unknown) => {
      const actor = await assertInternalAccount(
        database,
        (await authorize()).id,
      );
      const data = z
        .object({
          franchiseId: z.uuid(),
          lineupId: z.uuid(),
          provider: z.string().trim().min(1).max(200),
          sourceType: z.enum(SourceType),
          url: z.string().max(2048),
        })
        .strict()
        .parse(input);
      outboundUrl(data.url);
      await withInternalTransaction(
        database,
        async () => actor,
        (tx) => context(tx, data.franchiseId, data.lineupId),
      );
      const page = await fetchPage(data.url);
      const extracted = extractSource({
        html: page.html,
        url: page.url,
        provider: data.provider,
        sourceType: data.sourceType,
      });
      if (!extracted.candidates.length)
        throw new DomainError(
          "NO_PRODUCTS",
          "No product candidates were found. The page may require JavaScript or a provider adapter. Try a product detail page, or use manual/CSV entry.",
        );
      return withInternalTransaction(
        database,
        async () => actor,
        async (tx) => {
          const refs = await context(tx, data.franchiseId, data.lineupId);
          const candidates = extracted.candidates.map((row) =>
            matchReferences(
              candidateSchema.parse({
                ...row,
                sources: [
                  ...row.sources,
                  ...(row.sources.some((s) => s.url === data.url)
                    ? []
                    : [
                        {
                          provider: data.provider,
                          sourceType: data.sourceType,
                          url: data.url,
                        },
                      ]),
                ],
              }),
              refs,
            ),
          );
          const snapshot: ReviewSnapshot = {
            stage: "extracted",
            actorId: actor.id,
            franchiseId: data.franchiseId,
            lineupId: data.lineupId,
            expires: Date.now() + 30 * 60000,
            original: candidates,
            rows: candidates,
            duplicateFingerprint: "",
          };
          const checked = await inspect(tx, snapshot, candidates);
          return {
            token: tokens.sign(snapshot),
            candidates,
            adapter: extracted.adapter,
            categories: refs.categories,
            characters: refs.characters,
            duplicates: checked.duplicates,
            issues: checked.issues,
          };
        },
      );
    },
    review: async (input: unknown) => {
      const actor = await assertInternalAccount(
        database,
        (await authorize()).id,
      );
      const data = z
        .object({
          token: z.string(),
          rows: z.array(candidateSchema).min(1).max(50),
        })
        .strict()
        .parse(input);
      const snapshot = tokens.verify(data.token, actor.id);
      if (
        snapshot.stage !== "extracted" ||
        new Set(data.rows.map((row) => row.key)).size !== data.rows.length ||
        data.rows.some(
          (row) =>
            !snapshot.original.some((original) => original.key === row.key),
        )
      )
        throw new DomainError(
          "IMPORT_SELECTION",
          "Select candidates from this extraction only.",
        );
      return withInternalTransaction(
        database,
        async () => actor,
        async (tx) => {
          const checked = await inspect(tx, snapshot, data.rows);
          return {
            issues: checked.issues,
            duplicates: checked.duplicates,
            token: checked.issues.length
              ? null
              : tokens.sign({
                  ...snapshot,
                  stage: "reviewed",
                  rows: data.rows,
                  duplicateFingerprint: checked.fingerprint,
                }),
          };
        },
      );
    },
    commit: async (input: unknown) => {
      const actor = await assertInternalAccount(
        database,
        (await authorize()).id,
      );
      const data = z
        .object({
          token: z.string(),
          confirmed: z.literal(true),
          acknowledgeDuplicates: z.boolean(),
        })
        .strict()
        .parse(input);
      const snapshot = tokens.verify(data.token, actor.id);
      if (snapshot.stage !== "reviewed" || !snapshot.rows.length)
        throw new DomainError(
          "IMPORT_REVIEW",
          "Validate your selected candidates before importing.",
        );
      return withInternalTransaction(
        database,
        async () => actor,
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM lineups WHERE id = ${snapshot.lineupId}::uuid FOR UPDATE`;
          await context(tx, snapshot.franchiseId, snapshot.lineupId);
          const prior = await tx.merchandiseItem.count({
            where: { id: { in: snapshot.rows.map((row) => row.key) } },
          });
          if (prior === snapshot.rows.length)
            return { created: 0, skipped: prior, lineupId: snapshot.lineupId };
          if (prior)
            throw new DomainError(
              "IMPORT_RETRY",
              "Some candidates were already imported. Extract and review again; no additional items were created.",
            );
          const checked = await inspect(tx, snapshot, snapshot.rows);
          if (checked.issues.length)
            throw new DomainError(
              "IMPORT_FIELDS",
              checked.issues
                .map((issue) => `Row ${issue.row}: ${issue.message}`)
                .join("; "),
            );
          if (checked.fingerprint !== snapshot.duplicateFingerprint)
            throw new DomainError(
              "IMPORT_CHANGED",
              "Duplicate matches changed since review. Validate your selection again before importing.",
            );
          if (checked.duplicates.length && !data.acknowledgeDuplicates)
            throw new DomainError(
              "IMPORT_DUPLICATES",
              "Confirm that you reviewed the duplicate warnings.",
            );
          const skus = await allocateInternalSkus(
            tx,
            checked.lineup,
            checked.clean.length,
          );
          for (const [index, row] of snapshot.rows.entries()) {
            const original = snapshot.original.find((o) => o.key === row.key)!;
            const created = await createValidatedCatalogItem(
              tx,
              snapshot.lineupId,
              checked.clean[index].value,
              skus[index],
              row.key,
            );
            // Preserve original extraction provenance even if editable source fields were changed in review.
            const sources = [...row.sources, ...original.sources];
            const unique = new Map(
              sources.map((source) => [source.url, source]),
            );
            for (const source of unique.values()) {
              const current = await tx.itemSource.findFirst({
                where: { merchandiseItemId: created.id, url: source.url },
                select: { id: true },
              });
              const sourceData = {
                ...source,
                notes: `Administrator-reviewed extraction. Original Japanese name: ${original.japaneseName || "Not supplied"}`,
              };
              if (current)
                await tx.itemSource.update({
                  where: { id: current.id },
                  data: sourceData,
                });
              else
                await tx.itemSource.create({
                  data: { merchandiseItemId: created.id, ...sourceData },
                });
            }
            // All image metadata is explicit and all images remain unapproved for public use.
            for (const [imageIndex, image] of row.images.entries()) {
              const current = await tx.itemImage.findFirst({
                where: { merchandiseItemId: created.id, storageKey: image.url },
                select: { id: true },
              });
              const imageData = {
                originalUrl: image.url,
                sourceUrl: image.sourceUrl,
                sourceProvider: image.provider,
                approvedForPublicUse: false,
              };
              if (current)
                await tx.itemImage.update({
                  where: { id: current.id },
                  data: imageData,
                });
              else
                await tx.itemImage.create({
                  data: {
                    merchandiseItemId: created.id,
                    storageKey: image.url,
                    imageRole: imageIndex === 0 ? "PRIMARY" : "PRODUCT",
                    displayOrder: imageIndex,
                    ...imageData,
                  },
                });
            }
          }
          return {
            created: snapshot.rows.length,
            skipped: 0,
            lineupId: snapshot.lineupId,
          };
        },
        { timeout: 20000 },
      );
    },
  };
}
export type Extraction = Awaited<
  ReturnType<ReturnType<typeof createAssistedImportService>["extract"]>
>;
export type ImportReview = Awaited<
  ReturnType<ReturnType<typeof createAssistedImportService>["review"]>
>;
