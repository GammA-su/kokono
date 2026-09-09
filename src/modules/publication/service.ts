import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { entityId, moneyAmount } from "../shared/validation";
import { DomainError } from "../shared/errors";
import {
  listingSchema,
  reviewedListingSchema,
  storefrontCurrency,
} from "./validation";
import {
  assertPublicationIssues,
  listingPolicyIssues,
  publicationItemInclude,
} from "./policy";
import { isDeliverableImage } from "./media";

export function publicationIssues(item: {
  archived: boolean;
  saleListing: unknown;
}) {
  return [
    ...(item.archived ? ["The item, lineup or franchise is archived."] : []),
    ...(!item.saleListing
      ? ["A listing slug and selling price are required."]
      : []),
  ];
}
async function lockItem(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM merchandise_items WHERE id = ${id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM sale_listings WHERE merchandise_item_id = ${id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM item_images WHERE merchandise_item_id = ${id}::uuid FOR SHARE`;
  const item = await tx.merchandiseItem.findUnique({
    where: { id },
    include: publicationItemInclude,
  });
  if (!item)
    throw new DomainError("ITEM_UNAVAILABLE", "Merchandise no longer exists.");
  return item;
}
async function saveInTransaction(
  tx: Prisma.TransactionClient,
  input: unknown,
  review?: {
    expectedItemUpdatedAt: string;
    expectedListingUpdatedAt: string | null;
    published: boolean;
  },
) {
  const parsed = listingSchema.parse(input);
  const item = await lockItem(tx, parsed.merchandiseItemId),
    existing = item.saleListing;
  if (
    review &&
    (item.updatedAt.toISOString() !== review.expectedItemUpdatedAt ||
      (existing?.updatedAt.toISOString() ?? null) !==
        review.expectedListingUpdatedAt)
  )
    throw new DomainError(
      "REVIEW_STALE",
      "Item or listing changed. Open a new publication review.",
    );
  if (existing?.publishedAt && parsed.slug !== existing.slug)
    throw new DomainError(
      "SLUG_LOCKED",
      "Previously published URL slugs are fixed. Keep the existing slug.",
    );
  const { imageIds: requestedImages, ...fields } = parsed;
  const explicit = Object.fromEntries(
    Object.entries(fields).filter(([key]) =>
      Object.hasOwn(input as object, key),
    ),
  ) as Omit<typeof parsed, "imageIds">;
  const defaults: string[] = [];
  if (!existing && requestedImages === undefined)
    for (const image of item.images) {
      if (
        defaults.length < 20 &&
        image.approvedForPublicUse &&
        (await isDeliverableImage(image.storageKey))
      )
        defaults.push(image.id);
    }
  const imageIds =
    requestedImages ??
    existing?.images.map((image) => image.itemImageId) ??
    defaults;
  for (const id of imageIds)
    if (!item.images.some((image) => image.id === id))
      throw new DomainError(
        "IMAGE_OWNERSHIP",
        "Selected images must belong to this merchandise item.",
      );
  const published = review?.published ?? existing?.published ?? false;
  if (published) {
    if (
      item.archivedAt ||
      item.lineup.archivedAt ||
      item.lineup.franchise.archivedAt
    )
      throw new DomainError(
        "ITEM_UNAVAILABLE",
        "Archived merchandise cannot be published.",
      );
    assertPublicationIssues(
      await listingPolicyIssues(
        tx,
        item,
        { ...existing, ...explicit },
        imageIds,
      ),
    );
  } else if (
    requestedImages?.some(
      (id) =>
        !item.images.find((image) => image.id === id)?.approvedForPublicUse,
    )
  ) {
    throw new DomainError(
      "IMAGE_NOT_APPROVED",
      "Selected images must already be approved for public use.",
    );
  }
  const data = {
    ...explicit,
    published,
    ...(published ? { publishedAt: existing?.publishedAt ?? new Date() } : {}),
  };
  const listing = existing
    ? await tx.saleListing.update({ where: { id: existing.id }, data })
    : await tx.saleListing.create({ data });
  if (requestedImages !== undefined || !existing) {
    await tx.saleListingImage.deleteMany({ where: { listingId: listing.id } });
    if (imageIds.length)
      await tx.saleListingImage.createMany({
        data: imageIds.map((itemImageId, displayOrder) => ({
          listingId: listing.id,
          itemImageId,
          displayOrder,
        })),
      });
  }
  return listing;
}
export function createPublicationService(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    publishReviewed: (input: unknown) =>
      withInternalTransaction(
        database,
        authorize,
        async (tx) => {
          const review = reviewedListingSchema.parse(input);
          return saveInTransaction(tx, review.listing, review);
        },
        { timeout: 30000 },
      ),
    saveListing: (input: unknown) =>
      withInternalTransaction(
        database,
        authorize,
        (tx) => saveInTransaction(tx, input),
        { timeout: 30000 },
      ),
    setSellingPrice: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const { merchandiseItemId, ...data } = z
          .object({
            merchandiseItemId: entityId,
            sellingPriceAmount: moneyAmount,
            sellingPriceCurrency: storefrontCurrency,
          })
          .strict()
          .parse(input);
        return tx.saleListing.updateMany({
          where: { merchandiseItemId },
          data,
        });
      }),
    setFeatured: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) => {
        const { merchandiseItemId, featured } = z
          .object({ merchandiseItemId: entityId, featured: z.boolean() })
          .strict()
          .parse(input);
        return tx.saleListing.updateMany({
          where: { merchandiseItemId },
          data: { featured },
        });
      }),
    setPublished: (input: unknown) =>
      withInternalTransaction(
        database,
        authorize,
        async (tx) => {
          const { merchandiseItemId, published } = z
            .object({ merchandiseItemId: entityId, published: z.boolean() })
            .strict()
            .parse(input);
          const item = await lockItem(tx, merchandiseItemId);
          if (published) {
            if (
              item.archivedAt ||
              item.lineup.archivedAt ||
              item.lineup.franchise.archivedAt
            )
              throw new DomainError(
                "ITEM_UNAVAILABLE",
                "Archived merchandise cannot be published.",
              );
            if (!item.saleListing)
              throw new DomainError(
                "PUBLICATION_INVALID",
                "Create a listing through publication review first.",
              );
            assertPublicationIssues(
              await listingPolicyIssues(
                tx,
                item,
                item.saleListing,
                item.saleListing.images.map((image) => image.itemImageId),
              ),
            );
          }
          return tx.saleListing.update({
            where: { merchandiseItemId },
            data: {
              published,
              ...(published
                ? { publishedAt: item.saleListing?.publishedAt ?? new Date() }
                : {}),
            },
          });
        },
        { timeout: 30000 },
      ),
    mapCategory: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const data = z
          .object({
            categoryId: entityId,
            publicCategoryId: entityId.nullable(),
            expectedPublicCategoryId: entityId.nullable(),
          })
          .strict()
          .parse(input);
        await tx.$queryRaw`SELECT id FROM categories WHERE id = ${data.categoryId}::uuid FOR UPDATE`;
        const current = await tx.category.findUniqueOrThrow({
          where: { id: data.categoryId },
        });
        if (current.publicCategoryId !== data.expectedPublicCategoryId)
          throw new DomainError(
            "REVIEW_STALE",
            "Category mapping changed. Reload before saving.",
          );
        if (
          data.publicCategoryId &&
          !(await tx.publicCategory.findFirst({
            where: { id: data.publicCategoryId, active: true },
          }))
        )
          throw new DomainError(
            "INVALID_CATEGORY",
            "Choose an active public category.",
          );
        return tx.category.update({
          where: { id: current.id },
          data: { publicCategoryId: data.publicCategoryId },
        });
      }),
  };
}
