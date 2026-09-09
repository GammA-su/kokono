import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import { createCatalogQueries, catalogFilterSchema } from "../catalog/queries";
import { createCatalogService } from "../catalog/service";
import {
  createPublicationService,
  publicationIssues,
} from "../publication/service";
import { applyInventoryOperation } from "../inventory/operations";
import { currencyCode } from "../shared/validation";
import { DomainError } from "../shared/errors";
import { parseMoneyInput } from "../shared/money";
import { selectionSchema, bulkActionSchema, MAX_BULK_ITEMS } from "./selection";
import { snapshotCodec } from "./snapshot";
import { exportCatalogSelection } from "./export";
import { createLandedCostQueries } from "../landed-costs/queries";
import { createPublicationQueries } from "../publication/admin-queries";

export type BulkItemResult = {
  id: string;
  name: string;
  status: "updated" | "skipped" | "failed";
  reason?: string;
};
export type BulkResult = {
  updated: number;
  skipped: number;
  failed: number;
  results: BulkItemResult[];
  csv?: string;
};
function reason(error: unknown) {
  if (error instanceof DomainError) return error.message;
  if (error instanceof z.ZodError)
    return error.issues
      .map((i) => `${i.path.join(".") || "Input"}: ${i.message}`)
      .join("; ");
  const code = (error as { code?: string })?.code;
  if (code === "P2002")
    return "A listing slug or other unique value is already in use.";
  if (code === "P2025") return "The item or listing no longer exists.";
  if (code === "P2003") return "A referenced record no longer exists.";
  return "The operation failed. Retry or check the server logs.";
}
function price(value: unknown, currency: unknown) {
  const code = currencyCode.parse(currency);
  const text = z.string().min(1, "A price is required.").parse(value);
  try {
    return { amount: parseMoneyInput(text, code), currency: code };
  } catch (error) {
    throw new DomainError("INVALID_PRICE", (error as Error).message);
  }
}
const inputRow = z.record(z.string(), z.unknown());
const executionSchema = z
  .object({
    token: z.string(),
    defaults: inputRow.default({}),
    rows: z
      .array(z.object({ id: z.uuid(), values: inputRow }).strict())
      .max(MAX_BULK_ITEMS)
      .default([]),
    confirmed: z.boolean().default(false),
  })
  .strict();

export function createBulkManagementService(
  database: PrismaClient,
  authorize: Authorize,
  secret: string,
) {
  const queries = createCatalogQueries(database, authorize);
  const catalog = createCatalogService(database, authorize);
  const publication = createPublicationService(database, authorize);
  const codec = snapshotCodec(secret);
  const actor = async () =>
    assertInternalAccount(database, (await authorize()).id);
  return {
    prepare: async (input: unknown) => {
      const user = await actor();
      const { selection, filters, action } = z
        .object({
          selection: selectionSchema,
          filters: catalogFilterSchema,
          action: bulkActionSchema,
        })
        .strict()
        .parse(input);
      let ids = await queries.matchingIds(
        selection.mode === "lineup"
          ? { lineup: selection.lineupId, archived: "true" }
          : filters,
        MAX_BULK_ITEMS + 1,
        selection.mode === "explicit" ? [...new Set(selection.ids)] : undefined,
      );
      if (ids.length > MAX_BULK_ITEMS)
        throw new DomainError(
          "BATCH_TOO_LARGE",
          `Select at most ${MAX_BULK_ITEMS} items per batch. Use visible-page selection for larger lineups.`,
        );
      if (selection.mode === "lineup")
        ids = ids.filter((id) => !selection.excludedIds.includes(id));
      if (!ids.length)
        throw new DomainError(
          "EMPTY_SELECTION",
          "No selected items still match this view. Refresh and select again.",
        );
      const items = await queries.selected(ids);
      if (!items.length)
        throw new DomainError(
          "EMPTY_SELECTION",
          "The selected items no longer exist.",
        );
      const facets = await queries.facets(filters);
      const estimates = new Map(
        (action === "publish" || action === "price"
          ? await createLandedCostQueries(database, authorize).estimates(ids)
          : []
        ).map((row) => [row.itemId, row]),
      );
      const token = codec.sign({
        actorId: user.id,
        action,
        nonce: randomUUID(),
        expires: Date.now() + 20 * 60_000,
        items: items.map((item) => ({
          id: item.id,
          updatedAt: item.updatedAt.toISOString(),
          listingUpdatedAt: item.saleListing?.updatedAt.toISOString() ?? null,
        })),
      });
      const publicReview =
        action === "publish"
          ? await createPublicationQueries(database, authorize).review(ids)
          : null;
      const publicItems = new Map(
        publicReview?.items.map((item) => [item.itemId, item]),
      );
      const franceLocations = new Set(publicReview?.franceLocations);
      return {
        token,
        action,
        selectionMode: selection.mode,
        omitted:
          selection.mode === "explicit"
            ? new Set(selection.ids).size - items.length
            : 0,
        items: items.map((item) => ({
          ...item,
          publicationIssues: publicationIssues(item),
          landedEstimate: estimates.get(item.id) ?? null,
          publication: publicItems.get(item.id) ?? null,
          franceQuantity: item.stock.locations
            .filter((location) => franceLocations.has(location.locationId))
            .reduce((sum, location) => sum + location.quantity, 0),
        })),
        locations: facets.locations,
        categories: facets.categories,
        publicCategories: publicReview?.categories ?? [],
      };
    },
    execute: async (input: unknown): Promise<BulkResult> => {
      const user = await actor();
      const data = executionSchema.parse(input);
      const snapshot = codec.verify(data.token, user.id);
      if (["archive", "publish"].includes(snapshot.action) && !data.confirmed)
        throw new DomainError(
          "CONFIRM_REQUIRED",
          "Confirm this reviewed operation before continuing.",
        );
      const selected = new Set(snapshot.items.map((item) => item.id));
      const overrides = new Map<string, Record<string, unknown>>();
      for (const row of data.rows) {
        if (!selected.has(row.id) || overrides.has(row.id))
          throw new DomainError(
            "INVALID_ROWS",
            "Rows must be unique and belong to the reviewed selection.",
          );
        overrides.set(row.id, row.values);
      }
      const current = await queries.selected([...selected]);
      const byId = new Map(current.map((item) => [item.id, item]));
      const results: BulkItemResult[] = [];
      for (const reviewed of snapshot.items) {
        const item = byId.get(reviewed.id);
        const entry: BulkItemResult = {
          id: reviewed.id,
          name: item?.name ?? reviewed.id,
          status: "updated",
        };
        const values = { ...data.defaults, ...overrides.get(reviewed.id) };
        try {
          // Revocation stops subsequent mutations even during a long-running batch.
          await assertInternalAccount(database, user.id);
          if (!item) {
            entry.status = "skipped";
            entry.reason = "Item no longer exists.";
          } else if (values.skip === true) {
            entry.status = "skipped";
            entry.reason = "Excluded during review.";
          } else
            switch (snapshot.action) {
              case "receive":
              case "transfer":
              case "adjust": {
                const quantity = z
                  .number()
                  .int()
                  .min(-2_147_483_647)
                  .max(2_147_483_647)
                  .parse(values.quantity);
                const adjustment = snapshot.action === "adjust";
                if (!adjustment && quantity <= 0)
                  throw new DomainError(
                    "INVALID_QUANTITY",
                    "Enter a positive quantity for this item.",
                  );
                const cost =
                  snapshot.action === "receive" &&
                  values.cost !== undefined &&
                  values.cost !== ""
                    ? price(values.cost, values.costCurrency)
                    : null;
                const note =
                  typeof values.note === "string" ? values.note.trim() : "";
                const reference =
                  typeof values.reference === "string"
                    ? values.reference.trim()
                    : "";
                const outcome = await applyInventoryOperation(
                  database,
                  {
                    merchandiseItemId: item.id,
                    movementType: adjustment
                      ? "ADJUSTMENT"
                      : snapshot.action === "transfer"
                        ? "TRANSFER"
                        : "PURCHASE",
                    quantityDelta: quantity,
                    sourceLocationId:
                      snapshot.action === "transfer"
                        ? values.sourceLocationId
                        : adjustment && quantity < 0
                          ? values.locationId
                          : null,
                    destinationLocationId: adjustment
                      ? quantity > 0
                        ? values.locationId
                        : null
                      : values.destinationLocationId,
                    operationKey: `bulk:${snapshot.nonce}:${item.id}`,
                    notes: note || null,
                    acquisitionUnitCostAmount: cost?.amount ?? null,
                    acquisitionUnitCostCurrency: cost?.currency ?? null,
                    referenceType: reference ? "PURCHASE" : null,
                    referenceId: reference || null,
                  },
                  user.id,
                );
                if (outcome.replayed) {
                  entry.status = "skipped";
                  entry.reason =
                    "Already applied; no duplicate movement created.";
                }
                break;
              }
              case "watch": {
                const maximum =
                  values.maximumPrice !== undefined &&
                  values.maximumPrice !== ""
                    ? price(values.maximumPrice, values.watchCurrency)
                    : null;
                await catalog.savePurchaseWatch({
                  merchandiseItemId: item.id,
                  enabled: values.enabled ?? true,
                  priority: values.priority ?? "NORMAL",
                  targetQuantity: values.targetQuantity ?? null,
                  maxUnitPriceAmount: maximum?.amount ?? null,
                  maxUnitPriceCurrency: maximum?.currency ?? "JPY",
                  conditionPreference: values.conditionPreference ?? null,
                });
                break;
              }
              case "disable-watch": {
                const result = await catalog.disablePurchaseWatch(item.id);
                if (!result.count) {
                  entry.status = "skipped";
                  entry.reason = "No enabled purchase watch.";
                }
                break;
              }
              case "publish": {
                const selling = price(
                  values.sellingPrice,
                  values.sellingCurrency,
                );
                await publication.publishReviewed({
                  expectedItemUpdatedAt: reviewed.updatedAt,
                  expectedListingUpdatedAt: reviewed.listingUpdatedAt,
                  published: values.published ?? true,
                  listing: {
                    merchandiseItemId: item.id,
                    slug: values.slug,
                    publicTitle: values.publicTitle ?? null,
                    publicDescription:
                      values.publicDescription ??
                      item.saleListing?.publicDescription ??
                      null,
                    publicSubtitle: values.publicSubtitle,
                    seoTitle: values.seoTitle,
                    seoDescription: values.seoDescription,
                    publicCategoryId: values.publicCategoryId,
                    imageIds: values.imageIds,
                    sellingPriceTaxInclusion: values.sellingPriceTaxInclusion,
                    sellingPriceAmount: selling.amount,
                    sellingPriceCurrency: selling.currency,
                    featured:
                      values.featured ?? item.saleListing?.featured ?? false,
                  },
                });
                break;
              }
              case "unpublish":
                if (!item.saleListing?.published) {
                  entry.status = "skipped";
                  entry.reason = "No published listing.";
                } else
                  await publication.setPublished({
                    merchandiseItemId: item.id,
                    published: false,
                  });
                break;
              case "price": {
                const selling = price(
                  values.sellingPrice,
                  values.sellingCurrency,
                );
                const result = await publication.setSellingPrice({
                  merchandiseItemId: item.id,
                  sellingPriceAmount: selling.amount,
                  sellingPriceCurrency: selling.currency,
                });
                if (!result.count) {
                  entry.status = "skipped";
                  entry.reason =
                    "No listing. Create one through publication review first.";
                }
                break;
              }
              case "category":
                await catalog.setCategory({
                  merchandiseItemId: item.id,
                  categoryId: values.categoryId,
                });
                break;
              case "feature":
              case "unfeature": {
                const result = await publication.setFeatured({
                  merchandiseItemId: item.id,
                  featured: snapshot.action === "feature",
                });
                if (!result.count) {
                  entry.status = "skipped";
                  entry.reason = "No listing to feature.";
                }
                break;
              }
              case "archive":
                if (item.archivedAt) {
                  entry.status = "skipped";
                  entry.reason = "Already archived.";
                } else await catalog.archiveItem(item.id);
                break;
              case "export":
                break;
            }
        } catch (error) {
          if (
            error instanceof DomainError &&
            ["FORBIDDEN", "UNAUTHENTICATED"].includes(error.code)
          ) {
            // Return completed outcomes, with every unprocessed record explicitly failed.
            for (const remaining of snapshot.items.slice(results.length))
              results.push({
                id: remaining.id,
                name: byId.get(remaining.id)?.name ?? remaining.id,
                status: "failed",
                reason: error.message,
              });
            return summarize(results);
          }
          entry.status = "failed";
          entry.reason = reason(error);
        }
        results.push(entry);
      }
      return {
        ...summarize(results),
        ...(snapshot.action === "export"
          ? {
              csv: exportCatalogSelection(
                await queries.exportRecords(
                  current
                    .filter((item) =>
                      results.some(
                        (r) => r.id === item.id && r.status === "updated",
                      ),
                    )
                    .map((item) => item.id),
                ),
              ),
            }
          : {}),
      };
    },
  };
}
function summarize(results: BulkItemResult[]): BulkResult {
  return {
    results,
    updated: results.filter((r) => r.status === "updated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
}
export type BulkReview = Awaited<
  ReturnType<ReturnType<typeof createBulkManagementService>["prepare"]>
>;
