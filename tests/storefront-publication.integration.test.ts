import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { createPublicationService } from "../src/modules/publication/service";
import { createPublicationQueries } from "../src/modules/publication/admin-queries";
import {
  getPublicListing,
  getPublishedListings,
  getPublicImage,
  getPublicFacets,
  resolvePublicListings,
  fulfillableLocationIds,
} from "../src/modules/publication/queries";
import {
  applyInventoryOperation,
  getOwnedQuantity,
} from "../src/modules/inventory/operations";
import { createBulkManagementService } from "../src/modules/bulk-management/service";
import { makePublicationReady, pngBytes } from "./publication-fixture";
import { guardPgQueryConcurrency } from "./pg-query-guard";
guardPgQueryConcurrency();
const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = async () => ({ id: actorId }),
  catalog = createCatalogService(db, authorize),
  publication = createPublicationService(db, authorize),
  reads = createPublicationQueries(db, authorize),
  locations = createLocationService(db, authorize);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Publication reviewer",
        isInternal: true,
      },
    })
  ).id;
});
afterAll(async () => {
  await db.$disconnect();
});
async function fixture(ready = true) {
  const key = randomUUID(),
    franchise = await catalog.createFranchise({ name: "Re:Zero", slug: key });
  const lineup = await catalog.createLineup({
    name: "Marine",
    slug: key,
    franchiseId: franchise.id,
    releaseDate: "2026-11",
  });
  const category = await catalog.createCategory({
    name: "Acrylic Stand",
    slug: key,
  });
  const character = await catalog.createCharacter({
    name: "Rem",
    japaneseName: "レム",
    franchiseId: franchise.id,
  });
  const item = await catalog.createItem({
    name: "Rem Stand",
    japaneseName: "レム アクリルスタンド",
    slug: key,
    internalSku: key,
    categoryId: category.id,
    lineupId: lineup.id,
    characterIds: [character.id],
    privateNotes: "PRIVATE_IDENTITY_NOTES",
    officialMsrpAmount: 1650,
    officialMsrpCurrency: "JPY",
  });
  const image = ready ? await makePublicationReady(db, item.id) : null;
  return { item, image, category, character, lineup, franchise };
}
async function command(id: string, patch: Record<string, unknown> = {}) {
  const item = await db.merchandiseItem.findUniqueOrThrow({
    where: { id },
    include: {
      saleListing: {
        include: { images: { orderBy: { displayOrder: "asc" } } },
      },
      images: true,
    },
  });
  return {
    expectedItemUpdatedAt: item.updatedAt.toISOString(),
    expectedListingUpdatedAt: item.saleListing?.updatedAt.toISOString() ?? null,
    listing: {
      merchandiseItemId: id,
      slug: item.saleListing?.slug ?? item.slug,
      publicTitle: item.saleListing?.publicTitle ?? item.name,
      sellingPriceAmount: 2490,
      sellingPriceCurrency: "EUR",
      imageIds: item.images
        .filter((image) => image.approvedForPublicUse)
        .map((image) => image.id),
      ...patch,
    },
  };
}
async function stock(id: string, location: string, quantity: number) {
  await applyInventoryOperation(
    db,
    {
      merchandiseItemId: id,
      destinationLocationId: location,
      quantityDelta: quantity,
      movementType: "PURCHASE",
      operationKey: randomUUID(),
    },
    actorId,
  );
}
describe("storefront publication contract", () => {
  it("searches only public text with NFKC and reports visible franchise counts", async () => {
    const f = await fixture();
    await db.merchandiseItem.update({
      where: { id: f.item.id },
      data: {
        japaneseName: "SECRET_CATALOG_NAME",
        privateNotes: "SECRET_SOURCING_NOTE",
      },
    });
    const listing = await publication.publishReviewed(
      await command(f.item.id, {
        publicTitle: "Public acrylic",
        publicDescription: "Visible seaside edition",
      }),
    );
    for (const q of ["SECRET_CATALOG_NAME", "SECRET_SOURCING_NOTE"])
      expect(
        (await getPublishedListings(db, { franchise: f.franchise.id, q }))
          .items,
      ).toHaveLength(0);
    for (const q of ["seaside", "Ａｃｒｙｌｉｃ", "ﾚﾑ"])
      expect(
        (
          await getPublishedListings(db, { franchise: f.franchise.id, q })
        ).items.map((item) => item.listingId),
      ).toContain(listing.id);
    expect(
      (await getPublicListing(db, listing.slug))?.merchandiseCategory.name,
    ).toBe("Acrylic Stand");
    expect(
      (await getPublicFacets(db)).franchises.find(
        (row) => row.id === f.franchise.id,
      )?.count,
    ).toBe(1);
    await publication.setPublished({
      merchandiseItemId: f.item.id,
      published: false,
    });
    expect(
      (await getPublicFacets(db)).franchises.find(
        (row) => row.id === f.franchise.id,
      ),
    ).toBeUndefined();
  });
  it("serializes concurrent first publication and rolls back a duplicate slug", async () => {
    const f = await fixture(),
      other = await fixture(),
      review = await command(f.item.id);
    const results = await Promise.allSettled([
      publication.publishReviewed(review),
      publication.publishReviewed(review),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "REVIEW_STALE" } });
    await expect(
      publication.publishReviewed(
        await command(other.item.id, { slug: f.item.slug }),
      ),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(
      await db.saleListing.count({
        where: { merchandiseItemId: other.item.id },
      }),
    ).toBe(0);
    expect(
      await db.saleListing.count({ where: { merchandiseItemId: f.item.id } }),
    ).toBe(1);
  });
  it("publishes first listing, preserves edited fields and stable identity, rejects stale review and slug changes", async () => {
    const f = await fixture(),
      first = await command(f.item.id, {
        publicTitle: "Edited public title",
        publicSubtitle: "Acrylic, 15 cm",
        publicDescription: "Public description",
        seoTitle: "Public SEO",
        seoDescription: "Public summary",
        featured: true,
      });
    const listing = await publication.publishReviewed(first);
    const next = await command(f.item.id, { sellingPriceAmount: 2990 });
    // Missing optional fields preserve previously edited content.
    const updated = await publication.publishReviewed(next);
    expect(updated).toMatchObject({
      id: listing.id,
      publicTitle: "Edited public title",
      publicSubtitle: "Acrylic, 15 cm",
      publicDescription: "Public description",
      seoTitle: "Public SEO",
      featured: true,
      sellingPriceAmount: 2990,
    });
    expect(
      await db.saleListing.count({ where: { merchandiseItemId: f.item.id } }),
    ).toBe(1);
    await expect(publication.publishReviewed(first)).rejects.toMatchObject({
      code: "REVIEW_STALE",
    });
    await expect(
      publication.publishReviewed(
        await command(f.item.id, { slug: "changed-url" }),
      ),
    ).rejects.toMatchObject({ code: "SLUG_LOCKED" });
    await publication.setPublished({
      merchandiseItemId: f.item.id,
      published: false,
    });
    await expect(
      publication.saveListing({
        merchandiseItemId: f.item.id,
        slug: "changed-after-unpublish",
        sellingPriceAmount: 100,
        sellingPriceCurrency: "EUR",
      }),
    ).rejects.toMatchObject({ code: "SLUG_LOCKED" });
    expect(await getOwnedQuantity(db, f.item.id)).toBe(0);
  });
  it("validates titles, price, currency, slug, image ownership, approval and deliverability with rollback", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const patch of [
      { publicTitle: " " },
      { sellingPriceAmount: -1 },
      { sellingPriceAmount: undefined },
      { sellingPriceCurrency: "XYZ" },
      { slug: "invalid slug" },
      { imageIds: [] },
      { imageIds: [other.image!.id] },
    ]) {
      await expect(
        publication.publishReviewed(await command(f.item.id, patch)),
      ).rejects.toThrow();
      expect(
        await db.saleListing.count({ where: { merchandiseItemId: f.item.id } }),
      ).toBe(0);
    }
    await db.itemImage.update({
      where: { id: f.image!.id },
      data: { approvedForPublicUse: false },
    });
    await expect(
      publication.publishReviewed(
        await command(f.item.id, { imageIds: [f.image!.id] }),
      ),
    ).rejects.toThrow("not approved");
    await db.itemImage.update({
      where: { id: f.image!.id },
      data: {
        approvedForPublicUse: true,
        storageKey: "https://example.test/remote.jpg",
      },
    });
    await expect(
      publication.publishReviewed(await command(f.item.id)),
    ).rejects.toThrow("deliverable");
    await db.itemImage.update({
      where: { id: f.image!.id },
      data: { storageKey: `admin-media/${randomUUID()}.png` },
    });
    await expect(
      publication.publishReviewed(await command(f.item.id)),
    ).rejects.toThrow("deliverable");
    await expect(
      publication.setSellingPrice({
        merchandiseItemId: other.item.id,
        sellingPriceAmount: 100,
        sellingPriceCurrency: "XXX",
      }),
    ).rejects.toThrow();
  });
  it("resolves explicit category override before default, handles unmapped and inactive categories deliberately", async () => {
    const f = await fixture();
    await publication.mapCategory({
      categoryId: f.category.id,
      expectedPublicCategoryId: "af100000-0000-4000-8000-000000000004",
      publicCategoryId: null,
    });
    await expect(
      publication.publishReviewed(await command(f.item.id)),
    ).rejects.toThrow("public category");
    const override = await db.publicCategory.create({
      data: { name: "Special collection", slug: randomUUID() },
    });
    const listing = await publication.publishReviewed(
      await command(f.item.id, { publicCategoryId: override.id }),
    );
    expect((await getPublicListing(db, listing.slug))?.category.id).toBe(
      override.id,
    );
    await publication.mapCategory({
      categoryId: f.category.id,
      expectedPublicCategoryId: null,
      publicCategoryId: "af100000-0000-4000-8000-000000000004",
    });
    await expect(
      publication.mapCategory({
        categoryId: f.category.id,
        expectedPublicCategoryId: null,
        publicCategoryId: override.id,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_STALE" });
    await db.publicCategory.update({
      where: { id: override.id },
      data: { active: false },
    });
    expect(await getPublicListing(db, listing.slug)).toBeNull();
    expect(await getPublicImage(db, f.image!.id)).toBeNull();
  });
  it("selects and orders existing managed images, grants no approval, revokes delivery immediately", async () => {
    const f = await fixture(),
      image2 = await makePublicationReady(db, f.item.id);
    const listing = await publication.publishReviewed(
      await command(f.item.id, { imageIds: [image2.id, f.image!.id] }),
    );
    expect(
      (await getPublicListing(db, listing.slug))?.images.map(
        (image) => image.id,
      ),
    ).toEqual([image2.id, f.image!.id]);
    expect((await getPublicImage(db, image2.id))?.bytes).toEqual(pngBytes);
    await db.itemImage.update({
      where: { id: image2.id },
      data: { approvedForPublicUse: false },
    });
    expect(await getPublicImage(db, image2.id)).toBeNull();
    expect(
      (await getPublicListing(db, listing.slug))?.images.map(
        (image) => image.id,
      ),
    ).toEqual([f.image!.id]);
    await db.itemImage.update({
      where: { id: f.image!.id },
      data: { approvedForPublicUse: false },
    });
    expect(await getPublicListing(db, listing.slug)).toBeNull();
    expect(
      (await db.saleListing.findUniqueOrThrow({ where: { id: listing.id } }))
        .published,
    ).toBe(true);
    const unrelated = await fixture();
    await expect(
      db.saleListingImage.create({
        data: {
          listingId: listing.id,
          itemImageId: unrelated.image!.id,
          displayOrder: 2,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.itemImage.update({
        where: { id: f.image!.id },
        data: { merchandiseItemId: unrelated.item.id },
      }),
    ).rejects.toThrow();
  });
  it("counts only verified French direct balances, excluding Japan, foreign overrides, unknown roots and transit", async () => {
    const f = await fixture(),
      listing = await publication.publishReviewed(await command(f.item.id));
    const jp = await locations.create({
      code: randomUUID(),
      name: "Japan",
      type: "JAPAN_WAREHOUSE",
      fulfillmentEnabled: true,
    });
    const falseFrance = await locations.create({
      code: randomUUID(),
      name: "Mislabeled child",
      type: "BOX",
      parentId: jp.id,
      countryCode: "FR",
      fulfillmentEnabled: true,
    });
    const fr = await locations.create({
      code: randomUUID(),
      name: "Home",
      type: "FRANCE_HOME",
      fulfillmentEnabled: true,
    });
    const box = await locations.create({
      code: randomUUID(),
      name: "Box",
      type: "BOX",
      parentId: fr.id,
      fulfillmentEnabled: true,
    });
    const transit = await locations.create({
      code: randomUUID(),
      name: "Transit",
      type: "IN_TRANSIT",
    });
    const transitBox = await locations.create({
      code: randomUUID(),
      name: "Transit box",
      type: "BOX",
      parentId: transit.id,
      countryCode: "FR",
      fulfillmentEnabled: true,
    });
    const unknown = await locations.create({
      code: `FR-${randomUUID()}`,
      name: "Unknown country",
      type: "WAREHOUSE",
      fulfillmentEnabled: true,
    });
    await stock(f.item.id, jp.id, 15);
    await stock(f.item.id, fr.id, 1);
    await stock(f.item.id, box.id, 2);
    await stock(f.item.id, transitBox.id, 2);
    await stock(f.item.id, falseFrance.id, 4);
    await stock(f.item.id, unknown.id, 7);
    expect((await getPublicListing(db, listing.slug))?.availability).toEqual({
      status: "IN_STOCK",
      availableQuantity: 3,
    });
    expect(await getOwnedQuantity(db, f.item.id)).toBe(31);
    expect(await fulfillableLocationIds(db)).toContain(jp.id);
    expect(await fulfillableLocationIds(db, "FRANCE")).not.toContain(
      falseFrance.id,
    );
    await db.storageLocation.update({
      where: { id: fr.id },
      data: { active: false },
    });
    expect((await getPublicListing(db, listing.slug))?.availability).toEqual({
      status: "OUT_OF_STOCK",
      availableQuantity: 0,
    });
    await db.storageLocation.update({
      where: { id: fr.id },
      data: { active: true, fulfillmentEnabled: false },
    });
    expect(
      (await getPublicListing(db, listing.slug))?.availability
        .availableQuantity,
    ).toBe(2);
    await locations.reparent({ id: box.id, parentId: jp.id });
    expect(
      (await getPublicListing(db, listing.slug))?.availability
        .availableQuantity,
    ).toBe(0);
  });
  it("serves zero stock, preserves precision and isolates the public DTO, metadata and facets", async () => {
    const f = await fixture();
    await catalog.savePurchaseWatch({
      merchandiseItemId: f.item.id,
      notes: "PRIVATE_WATCH",
      maxUnitPriceAmount: 300,
    });
    const listing = await publication.publishReviewed(
      await command(f.item.id, { seoDescription: "Public SEO summary" }),
    );
    const dto = await getPublicListing(db, listing.slug);
    expect(dto).toMatchObject({
      listingId: listing.id,
      release: { value: "2026-11", precision: "MONTH" },
      price: { amount: 2490, currency: "EUR" },
      availability: { status: "OUT_OF_STOCK", availableQuantity: 0 },
      seo: { description: "Public SEO summary" },
    });
    expect(dto?.characters[0].japaneseName).toBe("レム");
    const serialized = JSON.stringify(dto);
    for (const secret of [
      "PRIVATE",
      "storageKey",
      "originalUrl",
      "sourceProvider",
      "purchaseWatch",
      "acquisition",
      "inventoryBalance",
      "location",
      "actor",
      f.image!.storageKey,
      "officialMsrp",
    ])
      expect(serialized).not.toContain(secret);
    const page = await getPublishedListings(db, {
      franchise: f.franchise.id,
      q: "レム",
      category: "goods",
      character: f.character.id,
      availability: "OUT_OF_STOCK",
      currency: "EUR",
      minPrice: 2400,
      maxPrice: 2500,
      sort: "price-asc",
      size: 1,
    });
    expect(page.items[0].listingId).toBe(listing.id);
    expect(page.pageInfo).toMatchObject({ total: 1, hasNextPage: false });
    expect((await getPublishedListings(db, { franchise: f.franchise.id, page: 100, size: 1 })).pageInfo)
      .toMatchObject({ total: 1, pageCount: 1, hasNextPage: false });
    expect(
      (
        await getPublishedListings(db, {
          franchise: f.franchise.id,
          page: 2,
          size: 1,
        })
      ).items,
    ).toEqual([]);
    expect(
      (await getPublicFacets(db)).franchises.some(
        (entry) => entry.id === f.franchise.id,
      ),
    ).toBe(true);
    await publication.setPublished({
      merchandiseItemId: f.item.id,
      published: false,
    });
    expect(await getPublicListing(db, listing.slug)).toBeNull();
    expect(await getPublicImage(db, f.image!.id)).toBeNull();
    expect(
      (await getPublicFacets(db)).franchises.some(
        (entry) => entry.id === f.franchise.id,
      ),
    ).toBe(false);
  });
  it("batch resolves stable listing IDs, reports unavailable IDs and rejects malformed/unbounded requests", async () => {
    const f = await fixture(),
      hidden = await fixture(),
      unknown = randomUUID();
    const live = await publication.publishReviewed(await command(f.item.id)),
      draft = await publication.publishReviewed({
        ...(await command(hidden.item.id)),
        published: false,
      });
    const result = await resolvePublicListings(db, {
      listingIds: [live.id, draft.id, unknown, live.id],
    });
    expect(result.items.map((item) => item.listingId)).toEqual([live.id]);
    expect(result.unavailableListingIds).toEqual([draft.id, unknown]);
    await expect(
      resolvePublicListings(db, {
        listingIds: Array.from({ length: 101 }, () => live.id),
      }),
    ).rejects.toThrow();
    await expect(
      resolvePublicListings(db, { listingIds: ["not-a-uuid"] }),
    ).rejects.toThrow();
    await expect(
      getPublishedListings(db, { sort: "price-asc" }),
    ).rejects.toThrow();
    await catalog.archiveItem(f.item.id);
    expect(
      (await resolvePublicListings(db, { listingIds: [live.id] }))
        .unavailableListingIds,
    ).toEqual([live.id]);
    expect(await getPublicImage(db, f.image!.id)).toBeNull();
  });
  it("keeps incomplete legacy records intact and reports them for remediation", async () => {
    const f = await fixture(false);
    const legacy = await db.saleListing.create({
      data: {
        merchandiseItemId: f.item.id,
        slug: f.item.slug,
        sellingPriceAmount: 1234,
        sellingPriceCurrency: "EUR",
        published: true,
        publishedAt: new Date(),
      },
    });
    expect(await getPublicListing(db, legacy.slug)).toBeNull();
    const report = await reads.review([f.item.id]);
    expect(report.items[0].issues.join(" ")).toContain("public category");
    expect(report.items[0].issues.join(" ")).toContain("approved");
    expect(
      await db.saleListing.findUniqueOrThrow({ where: { id: legacy.id } }),
    ).toMatchObject({ published: true, sellingPriceAmount: 1234 });
  });
  it("keeps existing signed bulk review and per-item partial results with France review stock", async () => {
    const good = await fixture(),
      invalid = await fixture(false),
      bulk = createBulkManagementService(
        db,
        authorize,
        "publication-tests-secret-long-enough-for-signing",
      );
    const review = await bulk.prepare({
      action: "publish",
      selection: { mode: "explicit", ids: [good.item.id, invalid.item.id] },
      filters: {},
    });
    expect(
      review.items.find((item) => item.id === good.item.id)?.publication
        ?.selectedImageIds,
    ).toEqual([good.image!.id]);
    const result = await bulk.execute({
      token: review.token,
      confirmed: true,
      rows: [good, invalid].map((f) => ({
        id: f.item.id,
        values: {
          publicTitle: f.item.name,
          slug: f.item.slug,
          sellingPrice: "24.90",
          sellingCurrency: "EUR",
          imageIds: f.image ? [f.image.id] : [],
          publicSubtitle: "Public subtitle",
        },
      })),
    });
    expect(result).toMatchObject({ updated: 1, failed: 1 });
    expect(
      result.results.find((row) => row.status === "failed")?.reason,
    ).toContain("public category");
    expect((await getPublicListing(db, good.item.slug))?.subtitle).toBe(
      "Public subtitle",
    );
  });
  it("rejects anonymous/internal-outsider mutations and protected publication reports", async () => {
    const f = await fixture(),
      input = await command(f.item.id),
      denied = async () => ({ id: "" }),
      commands = createPublicationService(db, denied);
    for (const call of [
      () => commands.publishReviewed(input),
      () => commands.saveListing(input.listing),
      () =>
        commands.setPublished({
          merchandiseItemId: f.item.id,
          published: true,
        }),
      () =>
        commands.setFeatured({ merchandiseItemId: f.item.id, featured: true }),
      () => commands.mapCategory({}),
      () => createPublicationQueries(db, denied).report({}),
    ])
      await expect(call()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(
      await db.saleListing.count({ where: { merchandiseItemId: f.item.id } }),
    ).toBe(0);
  });
});
