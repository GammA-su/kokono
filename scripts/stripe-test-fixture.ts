/**
 * Prepares a publicly visible product with eligible France stock for the Stripe TEST
 * qualification, using the real domain services rather than raw inserts, so the resulting
 * listing is visible for the same reasons a real one would be.
 *
 * Development database only. It refuses to run against anything else.
 *
 *   npx tsx --env-file=.env scripts/stripe-test-fixture.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createPublicationService } from "../src/modules/publication/service";
import { applyInventoryOperation } from "../src/modules/inventory/operations";
import { saveImage } from "../src/modules/media/storage";

const url = new URL(process.env.DATABASE_URL ?? "");
if (!url.pathname.endsWith("_dev"))
  throw new Error("Refusing to build fixtures outside the development database.");

const db = createDatabaseClient(process.env.DATABASE_URL!);
try {
  const actor = await db.user.findFirst({ where: { isInternal: true, active: true } });
  if (!actor) throw new Error("No internal user exists; run auth:provision first.");
  const authorize = async () => ({ id: actor.id });
  const catalog = createCatalogService(db, authorize);
  const publication = createPublicationService(db, authorize);

  const tag = `stripe-test-${randomUUID().slice(0, 8)}`;
  const franchise = await db.franchise.findFirst({ where: { archivedAt: null } });
  if (!franchise) throw new Error("No active franchise.");
  const lineup = await db.lineup.findFirst({
    where: { archivedAt: null, franchiseId: franchise.id },
  });
  if (!lineup) throw new Error("No active lineup.");
  // Public visibility requires the merchandise category to resolve to an active public
  // category. Nothing in this development database was mapped, so map one through the real
  // admin operation rather than writing the column directly.
  let category = await db.category.findFirst({ where: { publicCategoryId: { not: null } } });
  if (!category) {
    const target = await db.category.findFirstOrThrow({ where: { slug: "scale-figure" } });
    const publicCategory = await db.publicCategory.findFirstOrThrow({
      where: { slug: "figures", active: true },
    });
    await publication.mapCategory({
      categoryId: target.id,
      publicCategoryId: publicCategory.id,
      expectedPublicCategoryId: target.publicCategoryId,
    });
    category = await db.category.findUniqueOrThrow({ where: { id: target.id } });
    console.error(`Mapped category ${target.slug} -> ${publicCategory.slug}`);
  }

  const item = await catalog.createItem({
    lineupId: lineup.id,
    categoryId: category.id,
    name: `Stripe qualification figure ${tag}`,
    slug: tag,
    internalSku: tag,
  });

  // Real ingestion through the strict decoder, so the image is genuinely deliverable.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNwWPX/PwgzwBgAY44LoVZSKggAAAAASUVORK5CYII=",
    "base64",
  );
  const storageKey = await saveImage(new File([png], `${tag}.png`));
  const image = await db.itemImage.create({
    data: {
      merchandiseItemId: item.id,
      storageKey,
      approvedForPublicUse: true,
      imageRole: "PRODUCT",
      caption: "Stripe qualification fixture",
    },
  });

  const fresh = await db.merchandiseItem.findUniqueOrThrow({ where: { id: item.id } });
  const listing = await publication.publishReviewed({
    listing: {
      merchandiseItemId: item.id,
      slug: tag,
      publicTitle: `Stripe qualification figure ${tag}`,
      sellingPriceAmount: 2500,
      sellingPriceCurrency: "EUR",
      sellingPriceTaxInclusion: "INCLUDED",
      imageIds: [image.id],
    },
    expectedListingUpdatedAt: null,
    expectedItemUpdatedAt: fresh.updatedAt.toISOString(),
    published: true,
  });

  // Eligible France stock through the real ledger, not a balance write.
  const france = await db.storageLocation.findFirstOrThrow({
    where: { code: "FR-HOME", active: true, fulfillmentEnabled: true },
  });
  await applyInventoryOperation(
    db,
    {
      merchandiseItemId: item.id,
      destinationLocationId: france.id,
      movementType: "PURCHASE",
      quantityDelta: 5,
      operationKey: `${tag}:seed`,
      acquisitionUnitCostAmount: 900,
      acquisitionUnitCostCurrency: "EUR",
    },
    actor.id,
  );

  console.log(
    JSON.stringify(
      {
        tag,
        itemId: item.id,
        listingId: listing.id ?? null,
        slug: tag,
        priceAmount: 2500,
        currency: "EUR",
        franceLocationId: france.id,
        stocked: 5,
      },
      null,
      2,
    ),
  );
} finally {
  await db.$disconnect();
}
