import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createCatalogQueries } from "../src/modules/catalog/queries";
import { createLocationService } from "../src/modules/locations/service";
import { applyInventoryOperation, getOwnedQuantity, reconcileInventory } from "../src/modules/inventory/operations";
import { createPublicationService } from "../src/modules/publication/service";
import { getPublicListing } from "../src/modules/publication/queries";
import { createCommerceService } from "../src/modules/commerce/service";
import { createCommerceHandler } from "../src/modules/commerce/http";
import { createDashboardQueries } from "../src/modules/dashboard/queries";
import { createGachaService } from "../src/modules/gacha/service";
import { makePublicationReady } from "./publication-fixture";
import { guardPgQueryConcurrency } from "./pg-query-guard";

guardPgQueryConcurrency();
const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = async () => ({ id: actorId });
const catalog = createCatalogService(db, authorize);
const locations = createLocationService(db, authorize);
beforeAll(async () => {
  actorId = randomUUID();
  await db.user.create({ data: { id: actorId, name: "Audit", email: `${actorId}@example.test`, isInternal: true } });
});
afterAll(async () => { vi.unstubAllEnvs(); await db.$disconnect(); });

async function fixture() {
  const key = randomUUID();
  const franchise = await catalog.createFranchise({ name: "Audit", slug: key });
  const lineup = await catalog.createLineup({ name: "Audit release", slug: key, franchiseId: franchise.id, releaseDate: "2026-11" });
  const category = await catalog.createCategory({ name: "Acrylic", slug: key });
  const item = await catalog.createItem({ name: "Audit merchandise", internalSku: key, slug: key, lineupId: lineup.id, categoryId: category.id });
  const fr = await locations.create({ name: "France", code: key, type: "FRANCE_HOME", fulfillmentEnabled: true });
  return { item, fr, franchise, lineup };
}
async function receive(item: string, location: string, quantity: number) {
  return applyInventoryOperation(db, { merchandiseItemId: item, destinationLocationId: location, movementType: "PURCHASE", quantityDelta: quantity, operationKey: randomUUID() }, actorId);
}

it("matches preserved compatibility Japanese text through catalog browsing and bulk selection", async () => {
  const f = await fixture();
  const japaneseName = "ﾚﾑ Ｍａｒｉｎｅ ２０２６";
  await db.merchandiseItem.update({ where: { id: f.item.id }, data: { japaneseName, aliases: ["Ａｃｒｙｌｉｃ１００％"] } });
  const queries = createCatalogQueries(db, authorize);
  for (const q of ["レム", "Marine 2026", "Acrylic100%"] ) {
    const filters = { franchise: f.franchise.id, q };
    expect((await queries.list(filters)).items.map((item) => item.id)).toEqual([f.item.id]);
    expect(await queries.matchingIds(filters, 10)).toEqual([f.item.id]);
  }
  expect((await db.merchandiseItem.findUniqueOrThrow({ where: { id: f.item.id } })).japaneseName).toBe(japaneseName);
});

it("rejects transfer and removal acquisition costs at the shared ledger boundary without changing stock", async () => {
  const f = await fixture();
  const to = await locations.create({ name: "Other box", code: randomUUID(), type: "BOX", parentId: f.fr.id });
  await receive(f.item.id, f.fr.id, 3);
  for (const movementType of ["TRANSFER", "DAMAGED"] as const) {
    await expect(applyInventoryOperation(db, {
      merchandiseItemId: f.item.id, sourceLocationId: f.fr.id,
      destinationLocationId: movementType === "TRANSFER" ? to.id : null,
      movementType, quantityDelta: movementType === "TRANSFER" ? 1 : -1,
      operationKey: randomUUID(), acquisitionUnitCostAmount: 999, acquisitionUnitCostCurrency: "EUR",
    }, actorId)).rejects.toThrow(/acquisition|receiving/i);
  }
  expect(await getOwnedQuantity(db, f.item.id)).toBe(3);
  expect(await db.inventoryMovement.count({ where: { merchandiseItemId: f.item.id } })).toBe(1);
  expect(await reconcileInventory(db, f.item.id)).toEqual([]);
});

it("dashboard distinguishes physically owned stock from public availability after checkout holds", async () => {
  const f = await fixture();
  await receive(f.item.id, f.fr.id, 8);
  const image = await makePublicationReady(db, f.item.id);
  const fresh = await db.merchandiseItem.findUniqueOrThrow({ where: { id: f.item.id } });
  const listing = await createPublicationService(db, authorize).publishReviewed({
    expectedItemUpdatedAt: fresh.updatedAt.toISOString(), expectedListingUpdatedAt: null,
    listing: { merchandiseItemId: f.item.id, slug: f.item.slug, publicTitle: f.item.name,
      sellingPriceAmount: 1500, sellingPriceCurrency: "EUR", sellingPriceTaxInclusion: "INCLUDED", imageIds: [image.id] },
  });
  const dashboard = createDashboardQueries(db, authorize);
  const before = await dashboard.overview();
  const commerce = createCommerceService(db);
  const token = randomBytes(32).toString("base64url");
  const quote = await commerce.quote(token, { lines: [{ listingId: listing.id, quantity: 8 }],
    contact: { email: "audit@example.test" }, shippingAddress: { name: "Audit", line1: "1 rue Test", city: "Paris", postalCode: "75001", country: "FR" } });
  const outcome = await commerce.checkout(token, { quoteId: quote.id, operationKey: randomUUID(), accepted: true });
  expect(outcome.kind).toBe("order");
  const after = await dashboard.overview();
  expect(after.metrics.owned).toBe(before.metrics.owned);
  expect(after.metrics.fulfillable).toBe(before.metrics.fulfillable);
  expect((await getPublicListing(db, listing.slug))?.availability.availableQuantity).toBe(0);
  expect(after.metrics.outOfStock).toBe(before.metrics.outOfStock + 1n);
  // The shared test database may contain more than eight equally depleted listings.
  // The aggregate must include this item; the bounded attention queue need not.
  expect(after.lowStock.length).toBeGreaterThan(0);
  expect(after.lowStock.every((item) => item.availableQuantity <= 3)).toBe(true);
  if (outcome.kind === "order") await commerce.cancel(token, outcome.order.id);
});

it("commerce gateway fails closed on a short configured shared secret", async () => {
  vi.stubEnv("COMMERCE_GATEWAY_SECRET", "short");
  try {
    const response = await createCommerceHandler(db)(new Request("http://localhost/api/commerce/v1/config", {
      headers: { "x-commerce-gateway-key": "short" },
    }), ["config"]);
    expect(response.status).toBe(401);
  } finally { vi.unstubAllEnvs(); }
});

it("checkout and a gacha pool compete for the same final unit without double reservation", async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await fixture();
    await receive(f.item.id, f.fr.id, 1);
    await makePublicationReady(db, f.item.id);
    const publication = createPublicationService(db, authorize);
    const listing = await publication.saveListing({ merchandiseItemId: f.item.id, slug: f.item.slug,
      sellingPriceAmount: 1500, sellingPriceCurrency: "EUR", sellingPriceTaxInclusion: "INCLUDED" });
    await publication.setPublished({ merchandiseItemId: f.item.id, published: true });
    const commerce = createCommerceService(db);
    const token = randomBytes(32).toString("base64url");
    const quote = await commerce.quote(token, { lines: [{ listingId: listing.id, quantity: 1 }],
      contact: { email: "audit@example.test" }, shippingAddress: { name: "Audit", line1: "1 rue Test", city: "Paris", postalCode: "75001", country: "FR" } });
    const results = await Promise.allSettled([
      commerce.checkout(token, { quoteId: quote.id, operationKey: randomUUID(), accepted: true }),
      createGachaService(db, authorize).configure({ name: "Audit pool", slug: randomUUID(), active: true,
        terms: "Audit no-charge grant", termsVersion: "audit-v1",
        prizes: [{ merchandiseItemId: f.item.id, tier: "COMMON", weight: 1, allocation: 1, displayName: f.item.name }] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const reservations = await db.inventoryReservation.findMany({ where: { merchandiseItemId: f.item.id, status: { in: ["HELD", "CONFIRMED"] } } });
    expect(reservations.reduce((n, r) => n + r.quantity, 0)).toBe(1);
    expect(await getOwnedQuantity(db, f.item.id)).toBe(1);
    expect(await reconcileInventory(db, f.item.id)).toEqual([]);
  }
});
