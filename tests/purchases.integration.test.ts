import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createCatalogQueries } from "../src/modules/catalog/queries";
import { createLocationService } from "../src/modules/locations/service";
import { createPurchaseService } from "../src/modules/purchases/service";
import { createPurchaseQueries } from "../src/modules/purchases/queries";
import {
  purchaseInput,
  purchaseTotals,
} from "../src/modules/purchases/validation";
import {
  getOwnedQuantity,
  reconcileInventory,
} from "../src/modules/inventory/operations";
import { quantityNeeded } from "../src/modules/watchlist/filters";

const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string, otherActorId: string;
const authorize = async () => ({ id: actorId });
const catalog = createCatalogService(db, authorize),
  locations = createLocationService(db, authorize);
const service = createPurchaseService(db, authorize),
  queries = createPurchaseQueries(db, authorize);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Buyer",
        isInternal: true,
      },
    })
  ).id;
  otherActorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Receiver",
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
    name: "Purchase test",
    slug: key,
  });
  const lineup = await catalog.createLineup({
    name: "Marine",
    slug: key,
    franchiseId: franchise.id,
  });
  const category = await catalog.createCategory({ name: "Stand", slug: key });
  const items = [];
  for (const name of ["Rem", "Ram"])
    items.push(
      await catalog.createItem({
        name,
        japaneseName: name === "Rem" ? "レム" : "ラム",
        lineupId: lineup.id,
        categoryId: category.id,
        slug: `${name.toLowerCase()}-${key}`,
        internalSku: `${name}-${key}`,
      }),
    );
  const japan = await locations.create({
    code: `JP-${key}`,
    name: "Warehouse",
    type: "JAPAN_WAREHOUSE",
    countryCode: "JP",
  });
  const box = await locations.create({
    code: `BOX-${key}`,
    name: "Box",
    type: "BOX",
    parentId: japan.id,
  });
  const france = await locations.create({
    code: `FR-${key}`,
    name: "Home",
    type: "FRANCE_HOME",
    countryCode: "FR",
    fulfillmentEnabled: true,
  });
  const input = {
    id: randomUUID(),
    supplier: `Seller ${key}`,
    marketplace: "Mercari",
    externalReference: `order-${key}`,
    purchaseDate: "2026-09-08",
    currency: "JPY",
    status: "PAID" as const,
    domesticShippingAmount: 300,
    feesAmount: 50,
    taxesAmount: 0,
    notes: "Private order notes",
    items: items.map((item, index) => ({
      merchandiseItemId: item.id,
      quantity: index + 2,
      unitPriceAmount: 1000 + index * 500,
      condition: "Unopened",
      sellerListingUrl: "https://example.test/listing",
      notes: "Japanese packaging",
    })),
  };
  return { items, japan, box, france, input };
}
describe("purchasing records", () => {
  it("creates multiple commercial lines with exact totals and no inventory or listings", async () => {
    const f = await fixture(),
      purchase = await service.create(f.input);
    expect(purchase.subtotalAmount).toBe(6500);
    expect(purchase.items).toHaveLength(2);
    expect(purchase.createdByUserId).toBe(actorId);
    expect(purchase.purchaseDate.toISOString()).toBe(
      "2026-09-08T00:00:00.000Z",
    );
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(0);
    expect(
      await db.saleListing.count({
        where: { merchandiseItemId: { in: f.items.map((item) => item.id) } },
      }),
    ).toBe(0);
    const detail = await queries.detail(purchase.id);
    expect(detail?.items[0].merchandiseItem.japaneseName).toBe("レム");
    const list = await queries.list({
      q: f.input.externalReference,
      status: "PAID",
    });
    expect(list.total).toBe(1);
    expect(list.items[0].id).toBe(purchase.id);
  });
  it("deduplicates creation retries and rejects reused identity with changed data", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([
      service.create(f.input),
      service.create(f.input),
    ]);
    expect(a.id).toBe(b.id);
    expect(await db.purchaseItem.count({ where: { purchaseId: a.id } })).toBe(
      2,
    );
    await expect(
      service.create({ ...f.input, supplier: "Different" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("receives into inherited Japan location using ledger costs and actor, updating watch gap without disabling", async () => {
    const f = await fixture();
    await catalog.savePurchaseWatch({
      merchandiseItemId: f.items[0].id,
      enabled: true,
      targetQuantity: 2,
    });
    const purchase = await service.create(f.input),
      catalogQueries = createCatalogQueries(db, authorize);
    let card = (await catalogQueries.selected([f.items[0].id]))[0];
    expect(
      quantityNeeded(card.purchaseWatch!.targetQuantity, card.stock.total),
    ).toBe(2);
    expect(
      await service.receive({
        purchaseId: purchase.id,
        itemIds: purchase.items.map((item) => item.id),
        destinationLocationId: f.box.id,
        notes: "Arrived intact",
      }),
    ).toEqual({ received: 2, skipped: 0 });
    const detail = await queries.detail(purchase.id);
    expect(detail?.status).toBe("RECEIVED_JAPAN");
    const line = detail!.items[0];
    expect(line.receivedCountryCode).toBe("JP");
    expect(line.receivedMovement).toMatchObject({
      movementType: "PURCHASE",
      quantityDelta: 2,
      acquisitionUnitCostAmount: 1000,
      acquisitionUnitCostCurrency: "JPY",
      actorUserId: actorId,
      referenceType: "PURCHASE_ITEM",
      referenceId: line.id,
      notes: "Arrived intact",
    });
    card = (await catalogQueries.selected([f.items[0].id]))[0];
    expect(card.stock.total).toBe(2);
    expect(card.stock.fulfillable).toBe(0);
    expect(
      quantityNeeded(card.purchaseWatch!.targetQuantity, card.stock.total),
    ).toBe(0);
    expect(card.purchaseWatch!.enabled).toBe(true);
    expect(await reconcileInventory(db, f.items[0].id)).toEqual([]);
  });
  it("prevents concurrent and later duplicate receipts, even by another authorized actor", async () => {
    const f = await fixture(),
      purchase = await service.create(f.input);
    const command = {
      purchaseId: purchase.id,
      itemIds: purchase.items.map((item) => item.id),
      destinationLocationId: f.japan.id,
    };
    const results = await Promise.all([
      service.receive(command),
      createPurchaseService(db, async () => ({ id: otherActorId })).receive(
        command,
      ),
    ]);
    expect(results.map((result) => result.received).sort()).toEqual([0, 2]);
    expect(await service.receive(command)).toEqual({ received: 0, skipped: 2 });
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(2);
    expect(
      await db.inventoryMovement.count({
        where: {
          referenceType: "PURCHASE_ITEM",
          referenceId: { in: command.itemIds },
        },
      }),
    ).toBe(2);
    await expect(
      service.receive({ ...command, destinationLocationId: f.france.id }),
    ).rejects.toMatchObject({ code: "RECEIPT_CONFLICT" });
  });
  it("receives subsets once, permits different destinations and does not infer Japan from names", async () => {
    const f = await fixture(),
      purchase = await service.create(f.input);
    await service.receive({
      purchaseId: purchase.id,
      itemIds: [purchase.items[0].id],
      destinationLocationId: f.box.id,
    });
    expect((await queries.detail(purchase.id))?.status).toBe("PAID");
    await service.receive({
      purchaseId: purchase.id,
      itemIds: [purchase.items[1].id],
      destinationLocationId: f.france.id,
    });
    const detail = await queries.detail(purchase.id);
    expect(detail?.status).toBe("PAID");
    expect(detail?.items.every((item) => item.receivedAt)).toBe(true);
    const card = (
      await createCatalogQueries(db, authorize).selected([f.items[1].id])
    )[0];
    expect(card.stock.fulfillable).toBe(3);
  });
  it("blocks draft, cancelled and refunded receiving and manual received status", async () => {
    const f = await fixture(),
      purchase = await service.create({ ...f.input, status: "DRAFT" });
    const command = {
      purchaseId: purchase.id,
      itemIds: purchase.items.map((item) => item.id),
      destinationLocationId: f.japan.id,
    };
    await expect(service.receive(command)).rejects.toMatchObject({
      code: "NOT_RECEIVABLE",
    });
    await expect(
      service.setStatus(purchase.id, "RECEIVED_JAPAN"),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    await service.setStatus(purchase.id, "CANCELLED");
    await expect(service.receive(command)).rejects.toMatchObject({
      code: "NOT_RECEIVABLE",
    });
    const paid = await service.create({ ...f.input, id: randomUUID() });
    await service.setStatus(paid.id, "REFUNDED");
    await expect(
      service.receive({
        ...command,
        purchaseId: paid.id,
        itemIds: paid.items.map((item) => item.id),
      }),
    ).rejects.toMatchObject({ code: "NOT_RECEIVABLE" });
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(0);
  });
  it("prevents cancellation after receipt; refund preserves actual inventory", async () => {
    const f = await fixture(),
      purchase = await service.create(f.input);
    await service.receive({
      purchaseId: purchase.id,
      itemIds: [purchase.items[0].id],
      destinationLocationId: f.box.id,
    });
    await expect(
      service.setStatus(purchase.id, "CANCELLED"),
    ).rejects.toMatchObject({ code: "ALREADY_RECEIVED" });
    await service.setStatus(purchase.id, "REFUNDED");
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(2);
  });
  it("edits drafts with optimistic concurrency and locks commercial details when ordered", async () => {
    const f = await fixture(),
      input = { ...f.input, status: "DRAFT" as const },
      purchase = await service.create(input);
    const updated = await service.updateDraft(
      { ...input, supplier: "Updated seller" },
      purchase.updatedAt.toISOString(),
    );
    expect(updated.supplier).toBe("Updated seller");
    await expect(
      service.updateDraft(input, purchase.updatedAt.toISOString()),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await service.setStatus(purchase.id, "ORDERED");
    await expect(
      service.updateDraft(input, updated.updatedAt.toISOString()),
    ).rejects.toMatchObject({ code: "LOCKED" });
  });
  it("rejects foreign lines and inactive destination ancestors without partial receipts", async () => {
    const f = await fixture(),
      purchase = await service.create(f.input);
    await expect(
      service.receive({
        purchaseId: purchase.id,
        itemIds: [purchase.items[0].id, randomUUID()],
        destinationLocationId: f.box.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ITEM" });
    await db.storageLocation.update({
      where: { id: f.japan.id },
      data: { active: false },
    });
    await expect(
      service.receive({
        purchaseId: purchase.id,
        itemIds: purchase.items.map((item) => item.id),
        destinationLocationId: f.box.id,
      }),
    ).rejects.toMatchObject({ code: "INACTIVE_LOCATION" });
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(0);
    expect(
      (await queries.detail(purchase.id))?.items.every(
        (item) => !item.receivedMovementId,
      ),
    ).toBe(true);
  });
  it("rolls back earlier lines if a later ledger operation fails", async () => {
    const f = await fixture(),
      purchase = await service.create(f.input);
    const sorted = [...purchase.items].sort((a, b) =>
      a.merchandiseItemId.localeCompare(b.merchandiseItemId),
    );
    // A pre-existing balance at the PostgreSQL integer limit forces an overflow on the second line.
    const { applyInventoryOperation } =
      await import("../src/modules/inventory/operations");
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: sorted[1].merchandiseItemId,
        movementType: "PURCHASE",
        quantityDelta: 2147483647,
        destinationLocationId: f.japan.id,
        operationKey: randomUUID(),
      },
      actorId,
    );
    await expect(
      service.receive({
        purchaseId: purchase.id,
        itemIds: purchase.items.map((item) => item.id),
        destinationLocationId: f.japan.id,
      }),
    ).rejects.toThrow();
    expect(await getOwnedQuantity(db, sorted[0].merchandiseItemId)).toBe(0);
    expect(
      (await queries.detail(purchase.id))?.items.every(
        (item) => !item.receivedMovementId,
      ),
    ).toBe(true);
  });
  it("protects received lines from destructive edits at database level", async () => {
    const f = await fixture(),
      purchase = await service.create(f.input);
    await service.receive({
      purchaseId: purchase.id,
      itemIds: [purchase.items[0].id],
      destinationLocationId: f.japan.id,
    });
    await expect(
      db.purchaseItem.delete({ where: { id: purchase.items[0].id } }),
    ).rejects.toThrow();
    await expect(
      db.purchaseItem.update({
        where: { id: purchase.items[0].id },
        data: { quantity: 99 },
      }),
    ).rejects.toThrow();
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(2);
  });
  it("requires authorization on reads and every mutation", async () => {
    const f = await fixture(),
      purchase = await service.create(f.input);
    const outsider = await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Public customer",
      },
    });
    const denied = async () => ({ id: outsider.id }),
      commands = createPurchaseService(db, denied),
      reads = createPurchaseQueries(db, denied);
    for (const operation of [
      () => commands.create(f.input),
      () => commands.updateDraft(f.input, purchase.updatedAt.toISOString()),
      () => commands.setStatus(purchase.id, "CANCELLED"),
      () =>
        commands.receive({
          purchaseId: purchase.id,
          itemIds: [purchase.items[0].id],
          destinationLocationId: f.box.id,
        }),
      () => reads.list({}),
      () => reads.detail(purchase.id),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      createPurchaseQueries(db, async () => ({ id: "" })).list({}),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("validates prices, quantities, dates, URLs and overflow before writes", async () => {
    const f = await fixture();
    for (const patch of [
      { quantity: 0 },
      { quantity: 1.5 },
      { unitPriceAmount: -1 },
      { sellerListingUrl: "javascript:alert(1)" },
    ])
      await expect(
        service.create({
          ...f.input,
          items: [{ ...f.input.items[0], ...patch }],
        }),
      ).rejects.toThrow();
    await expect(
      service.create({ ...f.input, purchaseDate: "2026-02-30" }),
    ).rejects.toThrow();
    await expect(
      service.create({
        ...f.input,
        items: [{ ...f.input.items[0], unitPriceAmount: 2147483647 }],
      }),
    ).rejects.toThrow("Purchase total");
    expect(await db.purchase.count({ where: { id: f.input.id } })).toBe(0);
    expect(
      purchaseTotals(
        purchaseInput.parse({
          ...f.input,
          currency: "EUR",
          items: [{ ...f.input.items[0], quantity: 3, unitPriceAmount: 123 }],
        }),
      ),
    ).toEqual({ subtotalAmount: 369, totalAmount: 719 });
  });
});
