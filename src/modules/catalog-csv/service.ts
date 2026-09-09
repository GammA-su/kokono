import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { DomainError } from "../shared/errors";
import { catalogDuplicateSignals } from "../catalog/duplicates";
import { createValidatedCatalogItem } from "../catalog/bulk-entry";
import { allocateInternalSkus } from "../catalog/sku";
import { MAX_IMPORT_ROWS, parseCatalogCsv, type CsvRow } from "./format";
import {
  existingInclude,
  present,
  validateCsvRow,
  type ExistingItem,
} from "./validation";
import {
  importTokenCodec,
  importPolicySchema,
  type ImportPolicy,
} from "./token";

function revision(item: ExistingItem) {
  return createHash("sha256").update(JSON.stringify(item)).digest("hex");
}
export function csvFailure(error: unknown) {
  if (error instanceof DomainError) return error.message;
  if (error instanceof z.ZodError)
    return error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
  if ((error as { code?: string })?.code === "P2002")
    return "A hard unique constraint conflicts with another record (usually internal SKU). Re-review this CSV.";
  if ((error as { code?: string })?.code === "P2003")
    return "A referenced category or character changed. Re-review the CSV.";
  return "This row could not be imported. Its transaction was rolled back; review and retry.";
}
async function references(tx: Prisma.TransactionClient, franchiseId: string) {
  const categories = await tx.category.findMany({
    select: { id: true, name: true, slug: true },
  });
  const characters = await tx.character.findMany({
    where: { franchiseId },
    select: { id: true, name: true, japaneseName: true },
  });
  return { categories, characters };
}
async function activeLineup(tx: Prisma.TransactionClient, id: string) {
  const lineup = await tx.lineup.findFirst({
    where: { id, archivedAt: null, franchise: { archivedAt: null } },
    select: { id: true, name: true, slug: true, franchiseId: true },
  });
  if (!lineup)
    throw new DomainError(
      "CSV_LINEUP",
      "CSV imports require an active lineup and franchise.",
    );
  return lineup;
}
function identity(row: CsvRow, lineupId: string) {
  return {
    lineupId,
    internalSku: row.internal_sku?.trim(),
    janCode: row.jan_code?.trim(),
    name: row.name?.trim(),
    japaneseName: row.japanese_name?.trim(),
  };
}
function checkLineup(row: CsvRow, lineupId: string) {
  if (present(row, "lineup_id") && row.lineup_id!.trim() !== lineupId)
    throw new DomainError(
      "CSV_LINEUP",
      "This row's lineup_id differs from the destination. Split a multi-lineup export, or deliberately remove its lineup_id column before copying catalog data.",
    );
}
const watchFields = {
  watch_enabled: "enabled",
  watch_target_quantity: "targetQuantity",
  watch_max_price_amount: "maxUnitPriceAmount",
  watch_max_price_currency: "maxUnitPriceCurrency",
  watch_priority: "priority",
  watch_condition: "conditionPreference",
  marketplace_search_query: "marketplaceSearchQuery",
} as const;
const watchConfigured = (row: CsvRow) =>
  Object.keys(watchFields).some((key) => present(row, key as keyof CsvRow));

async function updateCatalogRow(
  tx: Prisma.TransactionClient,
  current: ExistingItem,
  raw: CsvRow,
  parsed: ReturnType<typeof validateCsvRow>,
  policy: ImportPolicy,
) {
  const row = parsed.value;
  const fields = {
    internal_sku: "internalSku",
    name: "name",
    japanese_name: "japaneseName",
    category: "categoryId",
    jan_code: "janCode",
    manufacturer: "manufacturer",
  } as const;
  const patch: Prisma.MerchandiseItemUncheckedUpdateInput = {};
  for (const [column, property] of Object.entries(fields))
    if (present(raw, column as keyof CsvRow))
      Object.assign(patch, {
        [property]: row[property as (typeof fields)[keyof typeof fields]],
      });
  if (
    [
      "official_msrp_amount",
      "official_msrp_currency",
      "official_msrp_tax_state",
    ].some((key) => present(raw, key as keyof CsvRow))
  )
    Object.assign(patch, {
      officialMsrpAmount: row.officialMsrpAmount,
      officialMsrpCurrency: row.officialMsrpCurrency,
      officialMsrpTaxInclusion: row.officialMsrpTaxInclusion,
    });
  if (present(raw, "release_date"))
    Object.assign(patch, {
      releaseDate: row.releaseDate?.date,
      releaseDatePrecision: row.releaseDate?.precision,
    });
  if (policy.updatePrivateNotes && present(raw, "private_notes"))
    patch.privateNotes = row.privateNotes;
  if (Object.keys(patch).length)
    await tx.merchandiseItem.update({ where: { id: current.id }, data: patch });
  if (present(raw, "characters")) {
    await tx.itemCharacter.deleteMany({
      where: {
        merchandiseItemId: current.id,
        characterId: { notIn: row.characterIds },
      },
    });
    await tx.itemCharacter.createMany({
      data: row.characterIds.map((characterId) => ({
        merchandiseItemId: current.id,
        characterId,
      })),
      skipDuplicates: true,
    });
  }
  if (policy.updateWatch && watchConfigured(raw)) {
    const update = Object.fromEntries(
      Object.entries(watchFields)
        .filter(([column]) => present(raw, column as keyof CsvRow))
        .map(([, property]) => [property, row.watch[property]]),
    );
    await tx.purchaseWatch.upsert({
      where: { merchandiseItemId: current.id },
      create: { merchandiseItemId: current.id, ...row.watch },
      update,
    });
  }
  // Evidence and media are additive. Matching URLs/keys preserve their manual metadata and approval.
  await appendEvidence(tx, current.id, current, parsed);
}
async function appendEvidence(
  tx: Prisma.TransactionClient,
  id: string,
  current: Pick<ExistingItem, "sources" | "images">,
  parsed: ReturnType<typeof validateCsvRow>,
) {
  for (const source of parsed.sources)
    if (!current.sources.some((existing) => existing.url === source.url))
      await tx.itemSource.create({
        data: { merchandiseItemId: id, ...source },
      });
  const image = parsed.value.image;
  if (
    image &&
    !current.images.some((existing) => existing.storageKey === image)
  )
    await tx.itemImage.create({
      data: {
        merchandiseItemId: id,
        storageKey: image,
        originalUrl: /^https?:\/\//.test(image) ? image : null,
        imageRole: current.images.length ? "PRODUCT" : "PRIMARY",
        displayOrder: current.images.length,
        approvedForPublicUse: false,
      },
    });
}
export type CsvImportResult = {
  row: number;
  status: "created" | "updated" | "skipped" | "failed";
  name: string;
  itemId?: string;
  message: string;
};

export function createCatalogCsvService(
  database: PrismaClient,
  authorize: Authorize,
  secret: string,
) {
  const codec = importTokenCodec(secret);
  return {
    preview: async (input: unknown) => {
      const user = await assertInternalAccount(
        database,
        (await authorize()).id,
      );
      const data = z
        .object({
          lineupId: z.uuid(),
          csv: z.string(),
          policy: importPolicySchema,
        })
        .strict()
        .parse(input);
      const parsed = parseCatalogCsv(data.csv);
      return withInternalTransaction(
        database,
        async () => user,
        async (tx) => {
          const lineup = await activeLineup(tx, data.lineupId);
          const refs = await references(tx, lineup.franchiseId);
          const identities = parsed.rows.map((row) => identity(row, lineup.id));
          const existing = await tx.merchandiseItem.findMany({
            where: {
              OR: [
                { lineupId: lineup.id },
                {
                  internalSku: {
                    in: identities.flatMap((row) =>
                      row.internalSku ? [row.internalSku] : [],
                    ),
                  },
                },
                {
                  janCode: {
                    in: identities.flatMap((row) =>
                      row.janCode ? [row.janCode] : [],
                    ),
                  },
                },
              ],
            },
            include: existingInclude,
          });
          const snapshots: {
            createId: string;
            candidates: { id: string; revision: string }[];
          }[] = [];
          const rows = parsed.rows.map((raw, index) => {
            const matches = existing
              .map((item) => ({
                item,
                signals: catalogDuplicateSignals(identities[index], item),
              }))
              .filter((match) => match.signals.length);
            const candidates = matches.slice(0, 100);
            snapshots.push({
              createId: randomUUID(),
              candidates: candidates.map(({ item }) => ({
                id: item.id,
                revision: revision(item),
              })),
            });
            const warnings = identities
              .slice(0, index)
              .flatMap((earlier, number) => {
                const signals = catalogDuplicateSignals(
                  identities[index],
                  earlier,
                );
                return signals.length
                  ? [
                      `Also matches CSV record ${number + 2}: ${signals.join(", ")}.`,
                    ]
                  : [];
              });
            const errors: string[] = [];
            const createBlocked: string[] = [];
            if (matches.some((match) => match.signals.includes("SKU")))
              createBlocked.push(
                "This internal SKU already exists and is globally unique.",
              );
            if (
              identities
                .slice(0, index)
                .some(
                  (earlier) =>
                    identities[index].internalSku &&
                    earlier.internalSku === identities[index].internalSku,
                )
            )
              createBlocked.push(
                "An earlier CSV row already uses this SKU. Change the file or skip this row.",
              );
            if (!present(raw, "name") || !present(raw, "category"))
              createBlocked.push(
                "Creating requires a name and category in the CSV.",
              );
            const fallback =
              candidates.find(
                (match) =>
                  match.signals.includes("SKU") &&
                  match.item.lineupId === lineup.id,
              )?.item ??
              candidates.find((match) => match.item.lineupId === lineup.id)
                ?.item ??
              null;
            try {
              checkLineup(raw, lineup.id);
              validateCsvRow(raw, refs, fallback);
            } catch (error) {
              errors.push(csvFailure(error));
            }
            if (matches.length > 100)
              errors.push(
                "More than 100 possible matches. Refine the row using an internal SKU.",
              );
            return {
              row: index + 2,
              name:
                raw.name || fallback?.name || raw.internal_sku || "Unnamed row",
              values: raw,
              errors,
              warnings,
              createBlocked,
              candidates: candidates.map(({ item, signals }) => ({
                id: item.id,
                name: item.name,
                internalSku: item.internalSku,
                signals,
                canUpdate:
                  item.lineupId === lineup.id &&
                  !item.archivedAt &&
                  !matches.some(
                    (match) =>
                      match.signals.includes("SKU") &&
                      match.item.id !== item.id,
                  ),
              })),
            };
          });
          const token = codec.sign({
            actorId: user.id,
            nonce: randomUUID(),
            lineupId: lineup.id,
            expires: Date.now() + 30 * 60_000,
            csv: data.csv,
            policy: data.policy,
            rows: snapshots,
          });
          return {
            token,
            lineupId: lineup.id,
            lineupName: lineup.name,
            headers: parsed.headers,
            rows,
            policy: data.policy,
          };
        },
      );
    },
    execute: async (input: unknown) => {
      const user = await assertInternalAccount(
        database,
        (await authorize()).id,
      );
      const data = z
        .object({
          token: z.string(),
          confirmed: z.literal(true),
          decisions: z
            .array(
              z
                .object({
                  row: z.number().int().min(2),
                  decision: z.enum(["skip", "create", "update"]),
                  targetId: z.uuid().optional(),
                })
                .strict(),
            )
            .max(MAX_IMPORT_ROWS),
        })
        .strict()
        .parse(input);
      const snapshot = codec.verify(data.token, user.id);
      const parsed = parseCatalogCsv(snapshot.csv);
      if (
        snapshot.rows.length !== parsed.rows.length ||
        data.decisions.length !== parsed.rows.length ||
        new Set(data.decisions.map((row) => row.row)).size !==
          parsed.rows.length ||
        data.decisions.some((row) => row.row > parsed.rows.length + 1)
      )
        throw new DomainError(
          "CSV_DECISIONS",
          "Choose exactly one decision for every reviewed CSV row.",
        );
      const decisions = new Map(data.decisions.map((row) => [row.row, row]));
      const results: CsvImportResult[] = [];
      for (let index = 0; index < parsed.rows.length; index++) {
        const raw = parsed.rows[index],
          choice = decisions.get(index + 2)!,
          reviewed = snapshot.rows[index];
        const result: CsvImportResult = {
          row: index + 2,
          name: raw.name || raw.internal_sku || "Unnamed row",
          status: "skipped",
          message: "Skipped by your review decision.",
        };
        try {
          await assertInternalAccount(database, user.id);
          if (choice.decision !== "skip")
            Object.assign(
              result,
              await withInternalTransaction(
                database,
                async () => user,
                async (tx) => {
                  // Same lineup lock as grid entry/SKU allocation. Each row commits all its catalog relations atomically.
                  await tx.$queryRaw`SELECT id FROM lineups WHERE id = ${snapshot.lineupId}::uuid FOR UPDATE`;
                  const lineup = await activeLineup(tx, snapshot.lineupId);
                  checkLineup(raw, lineup.id);
                  const refs = await references(tx, lineup.franchiseId);
                  if (choice.decision === "create") {
                    const previous = await tx.merchandiseItem.findUnique({
                      where: { id: reviewed.createId },
                    });
                    if (previous)
                      return {
                        status: "skipped" as const,
                        itemId: previous.id,
                        message:
                          "This reviewed row was already created; no duplicate was added.",
                      };
                    const row = validateCsvRow(raw, refs, null);
                    const sku =
                      row.value.internalSku ??
                      (
                        await allocateInternalSkus(
                          tx,
                          lineup,
                          1,
                          parsed.rows.flatMap((row) =>
                            row.internal_sku ? [row.internal_sku] : [],
                          ),
                        )
                      )[0];
                    const created = await createValidatedCatalogItem(
                      tx,
                      lineup.id,
                      row.value,
                      sku,
                      reviewed.createId,
                      watchConfigured(raw),
                    );
                    const stored = await tx.merchandiseItem.findUniqueOrThrow({
                      where: { id: created.id },
                      include: existingInclude,
                    });
                    await appendEvidence(tx, created.id, stored, row);
                    return {
                      status: "created" as const,
                      itemId: created.id,
                      name: created.name,
                      message: `Created ${created.internalSku}.`,
                    };
                  }
                  const expected = reviewed.candidates.find(
                    (candidate) => candidate.id === choice.targetId,
                  );
                  if (!expected)
                    throw new DomainError(
                      "CSV_TARGET",
                      "Update target was not part of the reviewed duplicate matches.",
                    );
                  await tx.$queryRaw`SELECT id FROM merchandise_items WHERE id = ${expected.id}::uuid FOR UPDATE`;
                  await tx.$queryRaw`SELECT id FROM purchase_watches WHERE merchandise_item_id = ${expected.id}::uuid FOR UPDATE`;
                  const current = await tx.merchandiseItem.findUnique({
                    where: { id: expected.id },
                    include: existingInclude,
                  });
                  if (
                    !current ||
                    current.lineupId !== lineup.id ||
                    current.archivedAt
                  )
                    throw new DomainError(
                      "CSV_TARGET",
                      "Update target must be an active item in this lineup.",
                    );
                  if (revision(current) !== expected.revision)
                    throw new DomainError(
                      "CSV_STALE",
                      "This item or its sourcing data changed after preview (or this row was already applied). Re-review before updating.",
                    );
                  const row = validateCsvRow(raw, refs, current);
                  await updateCatalogRow(
                    tx,
                    current,
                    raw,
                    row,
                    snapshot.policy,
                  );
                  return {
                    status: "updated" as const,
                    itemId: current.id,
                    name: row.value.name,
                    message:
                      "Only represented, nonblank fields allowed by the import policy were updated; sources/images were added without replacing existing metadata.",
                  };
                },
              ),
            );
        } catch (error) {
          result.status = "failed";
          result.message = csvFailure(error);
        }
        results.push(result);
      }
      return {
        results,
        created: results.filter((row) => row.status === "created").length,
        updated: results.filter((row) => row.status === "updated").length,
        skipped: results.filter((row) => row.status === "skipped").length,
        failed: results.filter((row) => row.status === "failed").length,
      };
    },
  };
}
export type CsvPreview = Awaited<
  ReturnType<ReturnType<typeof createCatalogCsvService>["preview"]>
>;
export type CsvSummary = Awaited<
  ReturnType<ReturnType<typeof createCatalogCsvService>["execute"]>
>;
