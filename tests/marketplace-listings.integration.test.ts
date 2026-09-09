import { makePublicationReady } from "./publication-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { createMarketplaceListingService } from "../src/modules/marketplace-listings/service";
import { createMarketplaceListingQueries } from "../src/modules/marketplace-listings/queries";
import { createPurchaseService } from "../src/modules/purchases/service";
import { getOwnedQuantity } from "../src/modules/inventory/operations";
import { getPublicListing } from "../src/modules/publication/queries";

const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = async () => ({ id: actorId });
const catalog = createCatalogService(db, authorize),
  service = createMarketplaceListingService(db, authorize),
  queries = createMarketplaceListingQueries(db, authorize),
  purchases = createPurchaseService(db, authorize);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Sourcing operator",
        isInternal: true,
      },
    })
  ).id;
});
afterAll(async () => {
  await db.$disconnect();
});
async function fixture() {
  const key = randomUUID();
  const franchise = await catalog.createFranchise({
    name: "Re:Zero",
    slug: key,
  });
  const lineup = await catalog.createLineup({
    name: "Marine",
    franchiseId: franchise.id,
    slug: key,
  });
  const category = await catalog.createCategory({ name: "Stand", slug: key });
  const item = await catalog.createItem({
    name: "Rem Stand",
    japaneseName: "レム アクリルスタンド",
    lineupId: lineup.id,
    categoryId: category.id,
    slug: key,
    internalSku: key,
    officialMsrpAmount: 1650,
    officialMsrpCurrency: "JPY",
  });
  await catalog.savePurchaseWatch({
    merchandiseItemId: item.id,
    targetQuantity: 3,
    maxUnitPriceAmount: 1000,
    maxUnitPriceCurrency: "JPY",
  });
  const input = {
    id: randomUUID(),
    merchandiseItemId: item.id,
    marketplace: "Mercari",
    url: "https://jp.mercari.com/item/m12345?utm_source=share",
    sellerName: "Private seller",
    itemPriceAmount: 700,
    currency: "JPY",
    domesticShippingAmount: null,
    condition: "未開封",
    status: "AVAILABLE",
    notes: "Private sourcing notes",
  };
  return { item, input };
}
function conversion(row: { id: string; updatedAt: Date }) {
  return {
    id: row.id,
    version: row.updatedAt.toISOString(),
    supplier: "Private seller",
    externalReference: "ORDER-123",
    purchaseDate: "2026-09-08",
    status: "PAID",
    quantity: 3,
    unitPriceAmount: 700,
    domesticShippingAmount: 200,
    feesAmount: 50,
    taxesAmount: 0,
    notes: "Private order notes",
    confirmed: true,
  };
}
describe("marketplace candidate workflow", () => {
  it("records many offers per item, preserving unknown shipping, provenance and Japanese text", async () => {
    const f = await fixture();
    const a = await service.save(f.input),
      b = await service.save({
        ...f.input,
        id: randomUUID(),
        url: "https://paypayfleamarket.yahoo.co.jp/item/z678",
        itemPriceAmount: 900,
        domesticShippingAmount: 0,
      });
    const result = await queries.list({ item: f.item.id });
    expect(result.total).toBe(2);
    expect(a).toMatchObject({
      marketplace: "Mercari Japan",
      externalListingId: "m12345",
      url: "https://jp.mercari.com/item/m12345",
      domesticShippingAmount: null,
      lastCheckedAt: null,
      createdByUserId: actorId,
      condition: "未開封",
    });
    expect(b.domesticShippingAmount).toBe(0);
    expect(a.discoveredAt).toBeInstanceOf(Date);
    expect(
      (
        await queries.list({
          item: f.item.id,
          q: "Yahoo",
          status: "AVAILABLE",
          page: 99,
        })
      ).filters.page,
    ).toBe(1);
    expect((await queries.list({ item: f.item.id, q: "Yahoo" })).total).toBe(1);
    expect(await getOwnedQuantity(db, f.item.id)).toBe(0);
  });
  it("deduplicates retries and rejects the same URL or external identity under new creation keys", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([
      service.save(f.input),
      service.save(f.input),
    ]);
    expect(a.id).toBe(b.id);
    await expect(
      service.save({
        ...f.input,
        id: randomUUID(),
        url: "https://jp.mercari.com/item/m12345?utm_campaign=other",
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(
      service.save({ ...f.input, itemPriceAmount: 800 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      service.save({
        ...f.input,
        id: randomUUID(),
        marketplace: "Mercari Japan",
        url: "https://example.test/offer",
        externalListingId: "m12345",
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE" });
    expect((await queries.list({ item: f.item.id })).total).toBe(1);
  });
  it("edits offers and statuses with stale-update rejection, while checked dates stay explicit", async () => {
    const f = await fixture(),
      row = await service.save(f.input);
    let current = await service.save(
      { ...f.input, itemPriceAmount: 600 },
      row.updatedAt.toISOString(),
    );
    expect(current.itemPriceAmount).toBe(600);
    expect(current.lastCheckedAt).toBeNull();
    await expect(
      service.setStatus({
        id: row.id,
        version: row.updatedAt.toISOString(),
        status: "SOLD",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    for (const status of [
      "SOLD",
      "EXPIRED",
      "REJECTED",
      "UNKNOWN",
      "AVAILABLE",
    ])
      current = await service.setStatus({
        id: row.id,
        version: current.updatedAt.toISOString(),
        status,
      });
    const checked = await service.markChecked(row.id);
    expect(checked.lastCheckedAt).toBeInstanceOf(Date);
    expect(checked.discoveredAt).toEqual(row.discoveredAt);
    expect(
      (
        await db.purchaseWatch.findUniqueOrThrow({
          where: { merchandiseItemId: f.item.id },
        })
      ).lastCheckedAt,
    ).toBeNull();
    await expect(
      service.setStatus({
        id: row.id,
        version: checked.updatedAt.toISOString(),
        status: "PURCHASED",
      }),
    ).rejects.toThrow();
  });
  it("converts atomically into the existing purchase model and receives only through its domain service", async () => {
    const f = await fixture(),
      row = await service.save(f.input);
    const purchase = await service.convert(conversion(row));
    expect(purchase).toMatchObject({
      status: "PAID",
      supplier: "Private seller",
      marketplace: "Mercari Japan",
      currency: "JPY",
      subtotalAmount: 2100,
      domesticShippingAmount: 200,
      feesAmount: 50,
    });
    expect(purchase.items).toHaveLength(1);
    expect(purchase.items[0]).toMatchObject({
      merchandiseItemId: f.item.id,
      quantity: 3,
      unitPriceAmount: 700,
      condition: "未開封",
      sellerListingUrl: row.url,
      receivedMovementId: null,
    });
    const detail = await queries.detail(row.id);
    expect(detail?.status).toBe("PURCHASED");
    expect(detail?.purchaseItem?.purchaseId).toBe(purchase.id);
    expect(await getOwnedQuantity(db, f.item.id)).toBe(0);
    expect(
      await db.inventoryMovement.count({
        where: { merchandiseItemId: f.item.id },
      }),
    ).toBe(0);
    const jp = await createLocationService(db, authorize).create({
      name: "Japan",
      code: randomUUID(),
      type: "JAPAN_WAREHOUSE",
      countryCode: "JP",
    });
    await purchases.receive({
      purchaseId: purchase.id,
      itemIds: [purchase.items[0].id],
      destinationLocationId: jp.id,
    });
    expect(await getOwnedQuantity(db, f.item.id)).toBe(3);
    expect(
      (
        await db.purchaseWatch.findUniqueOrThrow({
          where: { merchandiseItemId: f.item.id },
        })
      ).enabled,
    ).toBe(true);
  });
  it("serializes concurrent conversions, returns the same purchase on retry, rejects changed retry data", async () => {
    const f = await fixture(),
      row = await service.save(f.input),
      command = conversion(row);
    const [a, b] = await Promise.all([
      service.convert(command),
      service.convert(command),
    ]);
    expect(a.id).toBe(b.id);
    expect((await service.convert(command)).id).toBe(a.id);
    await expect(
      service.convert({ ...command, quantity: 5 }),
    ).rejects.toMatchObject({ code: "CONVERTED" });
    expect(
      await db.purchaseItem.count({ where: { merchandiseItemId: f.item.id } }),
    ).toBe(1);
    expect(await getOwnedQuantity(db, f.item.id)).toBe(0);
  });
  it("preserves converted sources after cancellation and rejects destructive or commercial source changes", async () => {
    const f = await fixture(),
      row = await service.save(f.input),
      command = { ...conversion(row), status: "ORDERED" };
    const purchase = await service.convert(command);
    await purchases.setStatus(purchase.id, "CANCELLED");
    expect((await queries.detail(row.id))?.purchaseItem?.purchase.status).toBe(
      "CANCELLED",
    );
    expect((await service.convert(command)).id).toBe(purchase.id);
    await expect(
      service.save(f.input, row.updatedAt.toISOString()),
    ).rejects.toMatchObject({ code: "CONVERTED" });
    await expect(
      service.setStatus({
        id: row.id,
        version: row.updatedAt.toISOString(),
        status: "AVAILABLE",
      }),
    ).rejects.toMatchObject({ code: "CONVERTED" });
    await expect(
      db.marketplaceListing.delete({ where: { id: row.id } }),
    ).rejects.toThrow();
    await expect(
      db.marketplaceListing.update({
        where: { id: row.id },
        data: { itemPriceAmount: 10 },
      }),
    ).rejects.toThrow();
    await service.markChecked(row.id);
    expect(await getOwnedQuantity(db, f.item.id)).toBe(0);
  });
  it("rolls back conversion on purchase validation failure and blocks unavailable or stale candidates", async () => {
    const f = await fixture(),
      row = await service.save(f.input),
      command = conversion(row);
    await expect(
      service.convert({ ...command, unitPriceAmount: 2147483647 }),
    ).rejects.toMatchObject({ code: "AMOUNT_TOO_LARGE" });
    expect((await queries.detail(row.id))?.purchaseItemId).toBeNull();
    expect(
      await db.purchaseItem.count({ where: { merchandiseItemId: f.item.id } }),
    ).toBe(0);
    const sold = await service.setStatus({
      id: row.id,
      version: row.updatedAt.toISOString(),
      status: "SOLD",
    });
    await expect(service.convert(command)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(service.convert(conversion(sold))).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
    });
  });
  it("requires explicit shipping and confirmation; rejects invalid money, URLs and archived merchandise", async () => {
    const f = await fixture(),
      row = await service.save(f.input),
      command = conversion(row);
    for (const patch of [
      { domesticShippingAmount: undefined },
      { confirmed: false },
      { quantity: 0 },
      { unitPriceAmount: -1 },
    ])
      await expect(service.convert({ ...command, ...patch })).rejects.toThrow();
    for (const patch of [
      { itemPriceAmount: -1 },
      { domesticShippingAmount: -1 },
      { url: "javascript:alert(1)" },
    ])
      await expect(
        service.save({ ...f.input, id: randomUUID(), ...patch }),
      ).rejects.toThrow();
    await db.merchandiseItem.update({
      where: { id: f.item.id },
      data: { archivedAt: new Date() },
    });
    await expect(service.convert(command)).rejects.toMatchObject({
      code: "INVALID_ITEM",
    });
    await expect(
      service.save({ ...f.input, id: randomUUID() }),
    ).rejects.toMatchObject({ code: "INVALID_ITEM" });
    expect((await queries.detail(row.id))?.status).toBe("AVAILABLE");
  });
  it("authorizes reads and every mutation, and excludes sourcing data from public selectors", async () => {
    const f = await fixture(),
      row = await service.save(f.input);
    const outsider = await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Customer",
      },
    });
    const denied = async () => ({ id: outsider.id }),
      commands = createMarketplaceListingService(db, denied),
      reads = createMarketplaceListingQueries(db, denied);
    for (const call of [
      () => commands.save(f.input),
      () => commands.save(f.input, row.updatedAt.toISOString()),
      () =>
        commands.setStatus({
          id: row.id,
          version: row.updatedAt.toISOString(),
          status: "SOLD",
        }),
      () => commands.markChecked(row.id),
      () => commands.convert(conversion(row)),
      () => reads.list({}),
      () => reads.detail(row.id),
    ])
      await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      createMarketplaceListingQueries(db, async () => ({ id: "" })).list({}),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await db.saleListing.create({
      data: {
        merchandiseItemId: f.item.id,
        slug: f.item.slug,
        publicTitle: f.item.name,
        sellingPriceAmount: 2000,
        sellingPriceCurrency: "EUR",
        published: true,
        publishedAt: new Date(),
      },
    });
    await makePublicationReady(db, f.item.id);
    const publicListing = await getPublicListing(db, f.item.slug);
    expect(publicListing).not.toBeNull();
    const serialized = JSON.stringify(publicListing);
    for (const secret of [
      row.id,
      row.url,
      "Private seller",
      "Private sourcing notes",
      "marketplaceListing",
      "purchaseWatch",
    ])
      expect(serialized).not.toContain(secret);
  });
});
