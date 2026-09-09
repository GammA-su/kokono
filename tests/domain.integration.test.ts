import { makePublicationReady } from "./publication-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createAuth } from "../src/lib/auth-config";
import { assertInternalAccount } from "../src/modules/auth/authorization";
import { provisionInternalUser } from "../src/modules/auth/provision";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { applyInventoryOperation, getOwnedQuantity, reconcileInventory } from "../src/modules/inventory/operations";
import { createPublicationService } from "../src/modules/publication/service";
import { getPublicListing, listPublicListings } from "../src/modules/publication/queries";

const database = createDatabaseClient(inject("testDatabaseUrl"));
let internalId: string;
const authorize = async () => assertInternalAccount(database, internalId);
const catalog = createCatalogService(database, authorize);
const publication = createPublicationService(database, authorize);
const locations = createLocationService(database, authorize);

beforeAll(async () => {
  const user = await database.user.create({ data: { id: randomUUID(), name: "Test operator", email: `operator-${randomUUID()}@example.test`, isInternal: true } });
  internalId = user.id;
});
afterAll(async () => { await database.$disconnect(); });

async function fixture() {
  const suffix = randomUUID();
  const franchise = await catalog.createFranchise({ name: "Re:Zero", japaneseName: "リゼロ", slug: `re-zero-${suffix}` });
  const lineup = await catalog.createLineup({ franchiseId: franchise.id, name: "Marine Ver. 2026", slug: `marine-${suffix}`, releaseDate: "2026-11" });
  const category = await catalog.createCategory({ name: "Acrylic Stand", slug: `acrylic-stand-${suffix}` });
  const item = await catalog.createItem({
    name: "Rem Marine Ver. Acrylic Stand", lineupId: lineup.id, categoryId: category.id,
    internalSku: suffix, slug: `rem-${suffix}`, officialMsrpAmount: 1650, officialMsrpCurrency: "JPY",
    privateNotes: "PRIVATE_CATALOG_NOTES",
  });
  const japan = await locations.create({ code: `JP-${suffix}`, name: "Japan Warehouse", type: "JAPAN_WAREHOUSE" });
  const france = await locations.create({ code: `FR-${suffix}`, name: "France Home", type: "FRANCE_HOME", fulfillmentEnabled: true });
  return { franchise, lineup, category, item, japan, france };
}

async function purchase(itemId: string, locationId: string, quantity = 5, operationKey = randomUUID()) {
  return applyInventoryOperation(database, {
    merchandiseItemId: itemId, movementType: "PURCHASE", quantityDelta: quantity, destinationLocationId: locationId,
    operationKey, acquisitionUnitCostAmount: 1000, acquisitionUnitCostCurrency: "JPY",
  }, internalId);
}

async function listing(itemId: string) {
  await makePublicationReady(database, itemId);
  const saved = await publication.saveListing({ merchandiseItemId: itemId, slug: `listing-${randomUUID()}`, sellingPriceAmount: 2500, sellingPriceCurrency: "EUR" });
  await publication.setPublished({ merchandiseItemId: itemId, published: true });
  return saved;
}

describe("independent merchandise concepts", () => {
  it("creates catalog merchandise with no inventory, watch, or SaleListing", async () => {
    const { item } = await fixture();
    const stored = await database.merchandiseItem.findUniqueOrThrow({ where: { id: item.id }, include: { inventoryBalances: true, purchaseWatch: true, saleListing: true } });
    expect(stored.inventoryBalances).toEqual([]);
    expect(stored.purchaseWatch).toBeNull();
    expect(stored.saleListing).toBeNull();
    expect(await getOwnedQuantity(database, item.id)).toBe(0);
  });
  it("watches an unowned item without creating inventory or a listing", async () => {
    const { item } = await fixture();
    const watch = await catalog.savePurchaseWatch({ merchandiseItemId: item.id, targetQuantity: 5, maxUnitPriceAmount: 1000, priority: "HIGH" });
    expect(watch.maxUnitPriceCurrency).toBe("JPY");
    expect(watch.enabled).toBe(true);
    expect(await getOwnedQuantity(database, item.id)).toBe(0);
    expect(await database.saleListing.count({ where: { merchandiseItemId: item.id } })).toBe(0);
    const disabled = await catalog.savePurchaseWatch({ merchandiseItemId: item.id, enabled: false });
    expect(disabled.id).toBe(watch.id);
    expect(await database.purchaseWatch.count({ where: { merchandiseItemId: item.id } })).toBe(1);
  });
  it("keeps MSRP, purchase cost and sale price independent", async () => {
    const { item, france } = await fixture();
    const { movement } = await purchase(item.id, france.id);
    const savedListing = await listing(item.id);
    await publication.saveListing({ merchandiseItemId: item.id, slug: savedListing.slug, sellingPriceAmount: 3000, sellingPriceCurrency: "EUR" });
    const stored = await database.merchandiseItem.findUniqueOrThrow({ where: { id: item.id }, include: { saleListing: true } });
    expect([stored.officialMsrpAmount, stored.officialMsrpCurrency]).toEqual([1650, "JPY"]);
    expect([movement.acquisitionUnitCostAmount, movement.acquisitionUnitCostCurrency]).toEqual([1000, "JPY"]);
    expect([stored.saleListing?.sellingPriceAmount, stored.saleListing?.sellingPriceCurrency]).toEqual([3000, "EUR"]);
  });
  it("supports multiple characters without making names or JAN unique", async () => {
    const { item, lineup, franchise, category } = await fixture();
    const rem = await catalog.createCharacter({ franchiseId: franchise.id, name: "Rem" });
    const emilia = await catalog.createCharacter({ franchiseId: franchise.id, name: "Emilia" });
    const create = () => catalog.createItem({
      name: item.name, lineupId: lineup.id, categoryId: category.id, internalSku: randomUUID(), slug: `item-${randomUUID()}`,
      janCode: "4901234567894", characterIds: [rem.id, emilia.id],
    });
    const first = await create();
    const second = await create();
    expect(first.janCode).toBe(second.janCode);
    expect(await database.itemCharacter.count({ where: { merchandiseItemId: first.id } })).toBe(2);
    await expect(database.itemCharacter.create({ data: { merchandiseItemId: first.id, characterId: rem.id } })).rejects.toThrow();
  });
  it("supports multiple sources and privately stored image provenance", async () => {
    const { item } = await fixture();
    await catalog.addSource({ merchandiseItemId: item.id, provider: "KADOKAWA", sourceType: "MANUFACTURER", url: "https://example.com/source-one" });
    await catalog.addSource({ merchandiseItemId: item.id, provider: "Animate", sourceType: "RETAILER", url: "https://example.com/source-two" });
    const image = await catalog.addImage({ merchandiseItemId: item.id, storageKey: "catalog/rem.webp", sourceProvider: "PRIVATE_PROVIDER" });
    expect(image.approvedForPublicUse).toBe(false);
    expect(await database.itemSource.count({ where: { merchandiseItemId: item.id } })).toBe(2);
  });
});

describe("location-aware atomic inventory", () => {
  it("tracks the same item in multiple locations", async () => {
    const { item, japan, france } = await fixture();
    await purchase(item.id, japan.id, 3);
    await purchase(item.id, france.id, 2);
    expect(await getOwnedQuantity(database, item.id)).toBe(5);
    expect(await database.inventoryBalance.count({ where: { merchandiseItemId: item.id } })).toBe(2);
    expect(await reconcileInventory(database, item.id)).toEqual([]);
  });
  it("rejects negative stock in the operation and in a direct database write", async () => {
    const { item, france } = await fixture();
    await purchase(item.id, france.id, 2);
    await expect(applyInventoryOperation(database, {
      merchandiseItemId: item.id, movementType: "SALE", quantityDelta: -3, sourceLocationId: france.id, operationKey: randomUUID(),
    }, internalId)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    await expect(database.inventoryBalance.update({ where: { merchandiseItemId_storageLocationId: { merchandiseItemId: item.id, storageLocationId: france.id } }, data: { quantity: -1 } })).rejects.toThrow();
    expect(await getOwnedQuantity(database, item.id)).toBe(2);
    expect(await database.inventoryMovement.count({ where: { merchandiseItemId: item.id } })).toBe(1);
  });
  it("transfers through transit without changing ownership or double-counting hierarchy parents", async () => {
    const { item, japan, france } = await fixture();
    const transit = await locations.create({ code: `TRANSIT-${randomUUID()}`, name: "In Transit", type: "IN_TRANSIT" });
    const box = await locations.create({ code: `BOX-${randomUUID()}`, name: "Box A1", type: "BOX", parentId: france.id, fulfillmentEnabled: true });
    await purchase(item.id, japan.id, 5);
    for (const [source, destination] of [[japan.id, transit.id], [transit.id, box.id]]) {
      await applyInventoryOperation(database, { merchandiseItemId: item.id, movementType: "TRANSFER", quantityDelta: 5,
        sourceLocationId: source, destinationLocationId: destination, operationKey: randomUUID() }, internalId);
      expect(await getOwnedQuantity(database, item.id)).toBe(5);
    }
    expect(await database.inventoryBalance.findUnique({ where: { merchandiseItemId_storageLocationId: { merchandiseItemId: item.id, storageLocationId: france.id } } })).toBeNull();
    expect(await reconcileInventory(database, item.id)).toEqual([]);
  });
  it("does not apply duplicate operation keys twice, including simultaneous retries", async () => {
    const { item, france } = await fixture();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => purchase(item.id, france.id, 5, key)));
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.movement.id)).size).toBe(1);
    expect(await getOwnedQuantity(database, item.id)).toBe(5);
    expect(await database.inventoryMovement.count({ where: { operationKey: key } })).toBe(1);
    await expect(purchase(item.id, france.id, 6, key)).rejects.toMatchObject({ code: "OPERATION_KEY_CONFLICT" });
    expect(await getOwnedQuantity(database, item.id)).toBe(5);
  });
  it("serializes competing removals so only available units leave", async () => {
    const { item, france } = await fixture();
    await purchase(item.id, france.id, 1);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => applyInventoryOperation(database, {
      merchandiseItemId: item.id, movementType: "SALE", quantityDelta: -1, sourceLocationId: france.id, operationKey: randomUUID(),
    }, internalId)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    expect(await getOwnedQuantity(database, item.id)).toBe(0);
    expect(await reconcileInventory(database, item.id)).toEqual([]);
  });
  it("rejects concurrent reuse of a global operation key for different items", async () => {
    const first = await fixture();
    const second = await fixture();
    const key = randomUUID();
    const results = await Promise.allSettled([
      purchase(first.item.id, first.france.id, 1, key),
      purchase(second.item.id, second.france.id, 1, key),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.status === "rejected" && failure.reason).toMatchObject({ code: "OPERATION_KEY_CONFLICT" });
    expect(await getOwnedQuantity(database, first.item.id) + await getOwnedQuantity(database, second.item.id)).toBe(1);
  });
  it("serializes independent receipts to a previously missing balance", async () => {
    const { item, france } = await fixture();
    await Promise.all(Array.from({ length: 5 }, () => purchase(item.id, france.id, 1)));
    expect(await getOwnedQuantity(database, item.id)).toBe(5);
    expect(await reconcileInventory(database, item.id)).toEqual([]);
  });
  it("rolls back both sides and the ledger when a destination balance overflows", async () => {
    const { item, france, japan } = await fixture();
    await purchase(item.id, france.id, 2_147_483_647);
    await purchase(item.id, japan.id, 1);
    const key = randomUUID();
    await expect(applyInventoryOperation(database, { merchandiseItemId: item.id, movementType: "TRANSFER", quantityDelta: 1,
      sourceLocationId: japan.id, destinationLocationId: france.id, operationKey: key }, internalId)).rejects.toThrow();
    const origin = await database.inventoryBalance.findUniqueOrThrow({ where: { merchandiseItemId_storageLocationId: { merchandiseItemId: item.id, storageLocationId: japan.id } } });
    expect(origin.quantity).toBe(1);
    expect(await database.inventoryMovement.findUnique({ where: { operationKey: key } })).toBeNull();
    expect(await reconcileInventory(database, item.id)).toEqual([]);
  });
  it("corrects stock with a compensating movement while preserving prior movements", async () => {
    const { item, france } = await fixture();
    const original = await purchase(item.id, france.id, 5);
    await applyInventoryOperation(database, {
      merchandiseItemId: item.id, movementType: "ADJUSTMENT", quantityDelta: -1, sourceLocationId: france.id,
      operationKey: randomUUID(), notes: "Receipt counted one unit twice.", referenceType: "InventoryMovement", referenceId: original.movement.id,
    }, internalId);
    expect((await database.inventoryMovement.findUniqueOrThrow({ where: { id: original.movement.id } })).quantityDelta).toBe(5);
    expect(await getOwnedQuantity(database, item.id)).toBe(4);
    expect(await reconcileInventory(database, item.id)).toEqual([]);
  });
  it("requires explanation, correct signs and endpoints, and rejects forged actor input", async () => {
    const { item, france } = await fixture();
    const base = { merchandiseItemId: item.id, movementType: "PURCHASE", quantityDelta: 1, destinationLocationId: france.id, operationKey: randomUUID() };
    for (const invalid of [
      { ...base, quantityDelta: 0 }, { ...base, quantityDelta: 1.5 }, { ...base, movementType: "SALE" },
      { ...base, movementType: "TRANSFER", sourceLocationId: france.id }, { ...base, movementType: "ADJUSTMENT" },
      { ...base, actorUserId: internalId }, { ...base, acquisitionUnitCostAmount: 100 },
    ]) await expect(applyInventoryOperation(database, invalid, internalId)).rejects.toThrow();
    expect(await getOwnedQuantity(database, item.id)).toBe(0);
  });
});

describe("history and database constraints", () => {
  it("archives merchandise without losing stock or history and blocks destructive history operations", async () => {
    const { item, france } = await fixture();
    const { movement } = await purchase(item.id, france.id);
    await catalog.archiveItem(item.id);
    expect(await getOwnedQuantity(database, item.id)).toBe(5);
    expect(await database.inventoryMovement.count({ where: { merchandiseItemId: item.id } })).toBe(1);
    await expect(database.merchandiseItem.delete({ where: { id: item.id } })).rejects.toThrow();
    await expect(database.inventoryMovement.update({ where: { id: movement.id }, data: { notes: "Rewrite" } })).rejects.toThrow();
    await expect(database.inventoryMovement.delete({ where: { id: movement.id } })).rejects.toThrow();
    await expect(database.$executeRaw`TRUNCATE inventory_movements`).rejects.toThrow();
    await expect(database.user.delete({ where: { id: internalId } })).rejects.toThrow();
    await expect(database.storageLocation.delete({ where: { id: france.id } })).rejects.toThrow();
  });
  it("enforces precision/date pairs and normalized date anchors in PostgreSQL", async () => {
    const { lineup } = await fixture();
    expect(lineup.releaseDatePrecision).toBe("MONTH");
    expect(lineup.releaseDate?.toISOString().slice(0, 10)).toBe("2026-11-01");
    await expect(database.lineup.update({ where: { id: lineup.id }, data: { releaseDatePrecision: null } })).rejects.toThrow();
    await expect(database.lineup.update({ where: { id: lineup.id }, data: { releaseDate: new Date("2026-11-14T00:00:00Z") } })).rejects.toThrow();
    await expect(database.lineup.update({ where: { id: lineup.id }, data: { announcedDatePrecision: "YEAR" } })).rejects.toThrow();
  });
  it("enforces money, watch quantity, unique SKU, and location/ledger shape constraints", async () => {
    const { item, france } = await fixture();
    await expect(database.merchandiseItem.update({ where: { id: item.id }, data: { officialMsrpCurrency: null } })).rejects.toThrow();
    await expect(database.merchandiseItem.update({ where: { id: item.id }, data: { officialMsrpAmount: -1 } })).rejects.toThrow();
    await expect(database.purchaseWatch.create({ data: { merchandiseItemId: item.id, targetQuantity: 0 } })).rejects.toThrow();
    await expect(database.merchandiseItem.create({ data: { name: item.name, internalSku: item.internalSku, slug: randomUUID(), lineupId: item.lineupId, categoryId: item.categoryId } })).rejects.toThrow();
    await expect(database.inventoryMovement.create({ data: { merchandiseItemId: item.id, movementType: "TRANSFER", quantityDelta: 1,
      sourceLocationId: france.id, destinationLocationId: france.id, operationKey: randomUUID(), requestFingerprint: "a".repeat(64) } })).rejects.toThrow();
    await expect(database.saleListing.create({ data: { merchandiseItemId: item.id, slug: randomUUID(), sellingPriceAmount: 10, sellingPriceCurrency: "eur" } })).rejects.toThrow();
  });
  it("rejects cycles in storage and category hierarchies", async () => {
    const { france, category } = await fixture();
    const shelf = await locations.create({ code: randomUUID(), name: "Shelf A", type: "SHELF", parentId: france.id });
    const box = await locations.create({ code: randomUUID(), name: "Box A1", type: "BOX", parentId: shelf.id });
    await expect(locations.reparent({ id: france.id, parentId: box.id })).rejects.toThrow();
    const child = await catalog.createCategory({ name: "Child", slug: `child-${randomUUID()}`, parentId: category.id });
    await expect(database.category.update({ where: { id: category.id }, data: { parentId: child.id } })).rejects.toThrow();
  });
  it("prevents simultaneous hierarchy changes from forming a cycle", async () => {
    const first = await locations.create({ code: randomUUID(), name: "First", type: "BOX" });
    const second = await locations.create({ code: randomUUID(), name: "Second", type: "BOX" });
    const results = await Promise.allSettled([
      locations.reparent({ id: first.id, parentId: second.id }),
      locations.reparent({ id: second.id, parentId: first.id }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const stored = await database.storageLocation.findMany({ where: { id: { in: [first.id, second.id] } } });
    expect(stored.filter((location) => location.parentId === null)).toHaveLength(1);
  });
  it("retains ownership in inactive locations, rejects receipts there, and allows moving stock out", async () => {
    const { item, france, japan } = await fixture();
    await purchase(item.id, france.id, 2);
    await database.storageLocation.update({ where: { id: france.id }, data: { active: false } });
    expect(await getOwnedQuantity(database, item.id)).toBe(2);
    await expect(purchase(item.id, france.id, 1)).rejects.toMatchObject({ code: "INACTIVE_LOCATION" });
    await applyInventoryOperation(database, { merchandiseItemId: item.id, movementType: "TRANSFER", quantityDelta: 2,
      sourceLocationId: france.id, destinationLocationId: japan.id, operationKey: randomUUID() }, internalId);
    expect(await getOwnedQuantity(database, item.id)).toBe(2);
  });
});

describe("public publication boundaries", () => {
  it("keeps a published item visible when the last physical unit is sold", async () => {
    const { item, france } = await fixture();
    await purchase(item.id, france.id, 1);
    const saleListing = await listing(item.id);
    expect((await getPublicListing(database, saleListing.slug))?.availability.status).toBe("IN_STOCK");
    await applyInventoryOperation(database, { merchandiseItemId: item.id, movementType: "SALE", quantityDelta: -1, sourceLocationId: france.id, operationKey: randomUUID() }, internalId);
    expect((await database.saleListing.findUniqueOrThrow({ where: { id: saleListing.id } })).published).toBe(true);
    expect((await getPublicListing(database, saleListing.slug))?.availability.status).toBe("OUT_OF_STOCK");
  });
  it("publishes an unowned item and never clears its purchase watch", async () => {
    const { item } = await fixture();
    await catalog.savePurchaseWatch({ merchandiseItemId: item.id });
    const saleListing = await listing(item.id);
    expect((await getPublicListing(database, saleListing.slug))?.availability.status).toBe("OUT_OF_STOCK");
    expect((await database.purchaseWatch.findUniqueOrThrow({ where: { merchandiseItemId: item.id } })).enabled).toBe(true);
  });
  it("returns only public fields and approved images, including in list queries", async () => {
    const { item, france } = await fixture();
    await purchase(item.id, france.id);
    await catalog.savePurchaseWatch({ merchandiseItemId: item.id, notes: "PRIVATE_WATCH" });
    await catalog.addSource({ merchandiseItemId: item.id, provider: "PRIVATE_SOURCE", url: "https://example.com/private-source" });
    await catalog.addImage({ merchandiseItemId: item.id, storageKey: "private.webp", sourceProvider: "PRIVATE_PROVIDER" });
    await catalog.addImage({ merchandiseItemId: item.id, storageKey: "public.webp", approvedForPublicUse: true, sourceUrl: "https://example.com/private-image-source" });
    const saleListing = await listing(item.id);
    const detail = await getPublicListing(database, saleListing.slug);
    expect(detail?.images).toHaveLength(1);
    expect(detail?.images[0]).toMatchObject({ id: expect.any(String), url: expect.stringMatching(/^\/api\/storefront\/v1\/images\//), alt: "Approved product image" });
    const results = await listPublicListings(database, { take: 100 });
    expect(results.some((result) => result.slug === saleListing.slug)).toBe(true);
    for (const response of [detail, results]) {
      const json = JSON.stringify(response);
      for (const secret of ["PRIVATE_", "private.webp", "private-image-source", "acquisitionUnitCost", "privateNotes", "purchaseWatch", "inventoryMovements", "sourceUrl", "sourceProvider", "inventoryBalances"]) expect(json).not.toContain(secret);
    }
  });
  it("hides unpublished and archived merchandise even at a known listing URL", async () => {
    const { item, franchise, lineup } = await fixture();
    const saleListing = await listing(item.id);
    await publication.setPublished({ merchandiseItemId: item.id, published: false });
    expect(await getPublicListing(database, saleListing.slug)).toBeNull();
    await publication.setPublished({ merchandiseItemId: item.id, published: true });
    await database.franchise.update({ where: { id: franchise.id }, data: { archivedAt: new Date() } });
    expect(await getPublicListing(database, saleListing.slug)).toBeNull();
    await database.franchise.update({ where: { id: franchise.id }, data: { archivedAt: null } });
    await database.lineup.update({ where: { id: lineup.id }, data: { archivedAt: new Date() } });
    expect(await getPublicListing(database, saleListing.slug)).toBeNull();
    await database.lineup.update({ where: { id: lineup.id }, data: { archivedAt: null } });
    await catalog.archiveItem(item.id);
    expect(await getPublicListing(database, saleListing.slug)).toBeNull();
    await expect(publication.setPublished({ merchandiseItemId: item.id, published: true })).rejects.toMatchObject({ code: "ITEM_UNAVAILABLE" });
  });
  it("excludes non-fulfilling, transit, and disabled ancestors from public availability", async () => {
    const { item, japan, france } = await fixture();
    const box = await locations.create({ code: randomUUID(), name: "Box", type: "BOX", parentId: france.id, fulfillmentEnabled: true });
    await purchase(item.id, japan.id, 3);
    const saleListing = await listing(item.id);
    expect((await getPublicListing(database, saleListing.slug))?.availability.status).toBe("OUT_OF_STOCK");
    await purchase(item.id, box.id, 1);
    expect((await getPublicListing(database, saleListing.slug))?.availability.status).toBe("IN_STOCK");
    await database.storageLocation.update({ where: { id: france.id }, data: { active: false } });
    expect((await getPublicListing(database, saleListing.slug))?.availability.status).toBe("OUT_OF_STOCK");
    await expect(purchase(item.id, box.id, 1)).rejects.toMatchObject({ code: "INACTIVE_LOCATION" });
    await database.storageLocation.update({ where: { id: france.id }, data: { active: true, fulfillmentEnabled: false, type: "IN_TRANSIT" } });
    expect((await getPublicListing(database, saleListing.slug))?.availability.status).toBe("OUT_OF_STOCK");
    expect(await getOwnedQuantity(database, item.id)).toBe(4);
  });
});

describe("Better Auth and internal authorization", () => {
  it("rejects unauthenticated and noninternal mutations before writing data", async () => {
    const outsider = await database.user.create({ data: { id: randomUUID(), name: "External", email: `${randomUUID()}@example.test` } });
    for (const userId of [undefined, outsider.id]) {
      const denied = async () => assertInternalAccount(database, userId);
      await expect(createCatalogService(database, denied).createFranchise({ name: "Denied", slug: `denied-${randomUUID()}` })).rejects.toThrow();
      await expect(createPublicationService(database, denied).setPublished({ merchandiseItemId: randomUUID(), published: true })).rejects.toThrow();
      await expect(createLocationService(database, denied).create({ code: randomUUID(), name: "Denied", type: "OTHER" })).rejects.toThrow();
    }
    const { item, france } = await fixture();
    await expect(applyInventoryOperation(database, { merchandiseItemId: item.id, movementType: "PURCHASE", quantityDelta: 1,
      destinationLocationId: france.id, operationKey: randomUUID() }, outsider.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await getOwnedQuantity(database, item.id)).toBe(0);
  });
  it("provisions a real credential account, signs in, records the actor, and revokes internal access immediately", async () => {
    const password = `Test-only-${randomUUID()}`;
    const user = await provisionInternalUser(database, { name: "Internal operator", email: `auth-${randomUUID()}@example.test`, password });
    const auth = createAuth(database, { baseURL: "http://localhost:3000", secret: randomUUID() + randomUUID() });
    const signedIn = await auth.api.signInEmail({ body: { email: user.email, password }, asResponse: true });
    expect(signedIn.status).toBe(200);
    const setCookies = signedIn.headers.getSetCookie();
    const cookie = setCookies.map((value) => value.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.id).toBe(user.id);
    expect((await assertInternalAccount(database, session?.user.id)).id).toBe(user.id);
    const { item, france } = await fixture();
    const operation = await applyInventoryOperation(database, { merchandiseItemId: item.id, movementType: "PURCHASE", quantityDelta: 1,
      destinationLocationId: france.id, operationKey: randomUUID() }, user.id);
    expect(operation.movement.actorUserId).toBe(user.id);
    await database.user.update({ where: { id: user.id }, data: { active: false } });
    await expect(assertInternalAccount(database, session?.user.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await auth.handler(new Request("http://localhost:3000/api/auth/update-user", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", cookie },
      body: JSON.stringify({ name: "Changed display name", active: true, isInternal: true }),
    }));
    expect((await database.user.findUniqueOrThrow({ where: { id: user.id } })).active).toBe(false);
  });
  it("disables public signup including attempts to supply internal membership", async () => {
    const auth = createAuth(database, { baseURL: "http://localhost:3000", secret: randomUUID() + randomUUID() });
    const email = `signup-${randomUUID()}@example.test`;
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "External", email, password: `Test-only-${randomUUID()}`, isInternal: true }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
    expect(await database.user.findUnique({ where: { email } })).toBeNull();
  });
});
