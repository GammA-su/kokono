import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createCatalogQueries } from "../src/modules/catalog/queries";
import { createLocationService } from "../src/modules/locations/service";
import {
  applyInventoryOperation,
  getOwnedQuantity,
  reconcileInventory,
} from "../src/modules/inventory/operations";
import { createShipmentService } from "../src/modules/shipments/service";
import { createShipmentQueries } from "../src/modules/shipments/queries";
import { shipmentNumber } from "../src/modules/shipments/validation";
const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string, receiverId: string;
const authorize = async () => ({ id: actorId });
const catalog = createCatalogService(db, authorize),
  locations = createLocationService(db, authorize),
  service = createShipmentService(db, authorize),
  queries = createShipmentQueries(db, authorize);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        name: "Shipper",
        email: `${randomUUID()}@example.test`,
        isInternal: true,
      },
    })
  ).id;
  receiverId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        name: "Receiver",
        email: `${randomUUID()}@example.test`,
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
      name: "Shipment test",
      slug: key,
    }),
    category = await catalog.createCategory({ name: "Stand", slug: key });
  const lineup = await catalog.createLineup({
    name: "Marine",
    slug: key,
    franchiseId: franchise.id,
  });
  const japan = await locations.create({
      code: `JP-${key}`,
      name: "Warehouse",
      type: "JAPAN_WAREHOUSE",
    }),
    transit = await locations.create({
      code: `TRANSIT-${key}`,
      name: "Transit",
      type: "IN_TRANSIT",
    }),
    france = await locations.create({
      code: `FR-${key}`,
      name: "Home",
      type: "FRANCE_HOME",
      fulfillmentEnabled: true,
    });
  const box = await locations.create({
    code: `BOX-${key}`,
    name: "Box A2",
    type: "BOX",
    parentId: france.id,
    fulfillmentEnabled: true,
  });
  const items = [];
  for (const name of ["Rem", "Ram"]) {
    const item = await catalog.createItem({
      name,
      japaneseName: name === "Rem" ? "レム" : "ラム",
      slug: `${name.toLowerCase()}-${key}`,
      internalSku: `${name}-${key}`,
      lineupId: lineup.id,
      categoryId: category.id,
    });
    items.push(item);
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: item.id,
        movementType: "PURCHASE",
        quantityDelta: 10,
        destinationLocationId: japan.id,
        operationKey: randomUUID(),
        acquisitionUnitCostAmount: 1000,
        acquisitionUnitCostCurrency: "JPY",
      },
      actorId,
    );
  }
  const input = {
    id: randomUUID(),
    originLocationId: japan.id,
    destinationLocationId: france.id,
    transitParentId: transit.id,
    carrier: "Japan Post",
    carrierService: "EMS",
    trackingNumber: `tracking-${key}`,
    packageCount: 2,
    totalWeight: "4.250",
    weightUnit: "KG",
    shippingCostAmount: 5000,
    shippingCurrency: "JPY",
    insuranceCostAmount: 300,
    notes: "Private shipment notes",
    items: items.map((item, index) => ({
      merchandiseItemId: item.id,
      quantity: index + 3,
    })),
  };
  const ship = (id: string) => service.ship({ id, shipmentDate: "2026-09-01" });
  const deliver = (id: string) =>
    service.deliver({
      id,
      arrivalDate: "2026-09-08",
      destinationLocationId: box.id,
    });
  return { items, japan, transit, france, box, input, ship, deliver };
}
async function quantity(item: string, location: string) {
  return (
    (
      await db.inventoryBalance.findUnique({
        where: {
          merchandiseItemId_storageLocationId: {
            merchandiseItemId: item,
            storageLocationId: location,
          },
        },
      })
    )?.quantity || 0
  );
}
describe("international shipment consolidation", () => {
  it("creates a numbered draft with multiple lines without moving or reserving stock", async () => {
    const f = await fixture(),
      shipment = await service.create(f.input);
    expect(shipment.status).toBe("DRAFT");
    expect(shipment.items).toHaveLength(2);
    expect(shipment.transitLocationId).toBeNull();
    expect(shipmentNumber(shipment.number)).toMatch(/^JP-\d{5,}$/);
    expect(await quantity(f.items[0].id, f.japan.id)).toBe(10);
    expect(
      await db.inventoryMovement.count({
        where: {
          referenceType: "SHIPMENT_ITEM",
          referenceId: { in: shipment.items.map((item) => item.id) },
        },
      }),
    ).toBe(0);
    const listed = await queries.list({
      q: shipmentNumber(shipment.number),
      status: "DRAFT",
    });
    expect(listed.total).toBe(1);
    expect((await queries.detail(shipment.id))?.totalWeight).toBe("4.25");
  });
  it("rejects insufficient JP stock, duplicate merchandise and invalid location configuration", async () => {
    const f = await fixture();
    await expect(
      service.create({
        ...f.input,
        items: [{ merchandiseItemId: f.items[0].id, quantity: 11 }],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    await expect(
      service.create({
        ...f.input,
        items: [f.input.items[0], f.input.items[0]],
      }),
    ).rejects.toThrow();
    await expect(
      service.create({
        ...f.input,
        originLocationId: f.france.id,
        destinationLocationId: f.japan.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ORIGIN" });
    await expect(
      service.create({ ...f.input, transitParentId: f.box.id }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSIT" });
    expect(await db.shipment.count({ where: { id: f.input.id } })).toBe(0);
  });
  it("dispatches Japan stock to dedicated transit with immutable transfer links", async () => {
    const f = await fixture(),
      shipment = await service.create(f.input);
    await service.setStatus(shipment.id, "PACKING");
    await service.setStatus(shipment.id, "READY");
    expect((await f.ship(shipment.id)).replayed).toBe(false);
    const detail = (await queries.detail(shipment.id))!;
    expect(detail.status).toBe("SHIPPED");
    expect(detail.shipmentDate?.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(await quantity(f.items[0].id, f.japan.id)).toBe(7);
    expect(await quantity(f.items[0].id, detail.transitLocationId!)).toBe(3);
    expect(await quantity(f.items[0].id, f.transit.id)).toBe(0);
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(10);
    expect(
      detail.items.every(
        (item) =>
          item.dispatchMovement?.movementType === "TRANSFER" &&
          item.dispatchMovement.actorUserId === actorId &&
          item.dispatchMovement.referenceId === item.id,
      ),
    ).toBe(true);
    const transit = await db.storageLocation.findUniqueOrThrow({
      where: { id: detail.transitLocationId! },
    });
    expect(transit.parentId).toBe(f.transit.id);
    expect(transit.fulfillmentEnabled).toBe(false);
    const card = (
      await createCatalogQueries(db, authorize).selected([f.items[0].id])
    )[0];
    expect(card.stock.total).toBe(10);
    expect(card.stock.fulfillable).toBe(0);
    expect(card.stock.countries.JP).toBe(7);
  });
  it("delivers from transit into France box, preserving totals and acquisition history", async () => {
    const f = await fixture(),
      shipment = await service.create(f.input);
    await f.ship(shipment.id);
    await service.setStatus(shipment.id, "IN_TRANSIT");
    await service.setStatus(shipment.id, "CUSTOMS");
    await f.deliver(shipment.id);
    const detail = (await queries.detail(shipment.id))!;
    expect(detail.status).toBe("DELIVERED");
    expect(detail.destinationLocationId).toBe(f.box.id);
    expect(detail.arrivalDate?.toISOString().slice(0, 10)).toBe("2026-09-08");
    for (const item of detail.items) {
      expect(
        await quantity(item.merchandiseItemId, detail.transitLocationId!),
      ).toBe(0);
      expect(await quantity(item.merchandiseItemId, f.box.id)).toBe(
        item.quantity,
      );
      expect(await getOwnedQuantity(db, item.merchandiseItemId)).toBe(10);
      expect(await reconcileInventory(db, item.merchandiseItemId)).toEqual([]);
      expect(item.deliveryMovement).toMatchObject({
        movementType: "TRANSFER",
        referenceType: "SHIPMENT_ITEM",
        referenceId: item.id,
        acquisitionUnitCostAmount: null,
      });
    }
    const card = (
      await createCatalogQueries(db, authorize).selected([f.items[0].id])
    )[0];
    expect(card.stock.fulfillable).toBe(3);
    expect(card.stock.countries.FR).toBe(3);
  });
  it("cancels before dispatch and rejects cancellation or direct delivered status after dispatch", async () => {
    const f = await fixture(),
      cancelled = await service.create(f.input);
    await service.setStatus(cancelled.id, "CANCELLED");
    await expect(f.ship(cancelled.id)).rejects.toMatchObject({
      code: "INVALID_STATUS",
    });
    expect(await quantity(f.items[0].id, f.japan.id)).toBe(10);
    const shipment = await service.create({ ...f.input, id: randomUUID() });
    await expect(
      service.setStatus(shipment.id, "SHIPPED"),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    await expect(f.deliver(shipment.id)).rejects.toMatchObject({
      code: "INVALID_STATUS",
    });
    await f.ship(shipment.id);
    await expect(
      service.setStatus(shipment.id, "CANCELLED"),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    await expect(
      service.setStatus(shipment.id, "DELIVERED"),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });
  it("deduplicates creation, concurrent dispatch and concurrent delivery across actors", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([
      service.create(f.input),
      service.create(f.input),
    ]);
    expect(a.id).toBe(b.id);
    const other = createShipmentService(db, async () => ({ id: receiverId }));
    const shipped = await Promise.all([
      f.ship(a.id),
      other.ship({ id: a.id, shipmentDate: "2026-09-01" }),
    ]);
    expect(shipped.filter((result) => result.replayed)).toHaveLength(1);
    const delivered = await Promise.all([
      f.deliver(a.id),
      other.deliver({
        id: a.id,
        arrivalDate: "2026-09-08",
        destinationLocationId: f.box.id,
      }),
    ]);
    expect(delivered.filter((result) => result.replayed)).toHaveLength(1);
    expect(await quantity(f.items[0].id, f.japan.id)).toBe(7);
    expect(await quantity(f.items[0].id, f.box.id)).toBe(3);
    expect(
      await db.inventoryMovement.count({
        where: {
          referenceType: "SHIPMENT_ITEM",
          referenceId: { in: a.items.map((item) => item.id) },
        },
      }),
    ).toBe(4);
    await expect(
      service.ship({ id: a.id, shipmentDate: "2026-09-02" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      service.deliver({
        id: a.id,
        arrivalDate: "2026-09-08",
        destinationLocationId: f.france.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("rechecks stock at dispatch and rolls back all lines and transit creation on failure", async () => {
    const f = await fixture(),
      shipment = await service.create(f.input);
    const later = [...shipment.items].sort((a, b) =>
      a.merchandiseItemId.localeCompare(b.merchandiseItemId),
    )[1];
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: later.merchandiseItemId,
        movementType: "LOST",
        quantityDelta: -10,
        sourceLocationId: f.japan.id,
        operationKey: randomUUID(),
      },
      actorId,
    );
    await expect(f.ship(shipment.id)).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });
    const detail = (await queries.detail(shipment.id))!;
    expect(detail.status).toBe("DRAFT");
    expect(detail.transitLocationId).toBeNull();
    expect(detail.items.every((item) => !item.dispatchMovementId)).toBe(true);
    expect(
      await db.storageLocation.count({
        where: { code: `SHIPMENT-${shipment.id}` },
      }),
    ).toBe(0);
    expect(
      await quantity(
        shipment.items.find((item) => item.id !== later.id)!.merchandiseItemId,
        f.japan.id,
      ),
    ).toBe(10);
  });
  it("two shipments cannot overdraw the same origin stock", async () => {
    const f = await fixture(),
      input = {
        ...f.input,
        items: [{ merchandiseItemId: f.items[0].id, quantity: 8 }],
      };
    const a = await service.create(input),
      b = await service.create({ ...input, id: randomUUID() });
    const results = await Promise.allSettled([f.ship(a.id), f.ship(b.id)]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await quantity(f.items[0].id, f.japan.id)).toBe(2);
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(10);
  });
  it("cannot deliver another consignment's transit stock when this shipment has shortages", async () => {
    const f = await fixture(),
      a = await service.create(f.input),
      b = await service.create({ ...f.input, id: randomUUID() });
    await f.ship(a.id);
    await f.ship(b.id);
    const detailA = (await queries.detail(a.id))!,
      detailB = (await queries.detail(b.id))!;
    expect(detailA.transitLocationId).not.toBe(detailB.transitLocationId);
    const later = [...a.items].sort((x, y) =>
      x.merchandiseItemId.localeCompare(y.merchandiseItemId),
    )[1];
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: later.merchandiseItemId,
        movementType: "DAMAGED",
        quantityDelta: -later.quantity,
        sourceLocationId: detailA.transitLocationId,
        operationKey: randomUUID(),
      },
      actorId,
    );
    await expect(f.deliver(a.id)).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });
    expect(
      (await queries.detail(a.id))?.items.every(
        (item) => !item.deliveryMovementId,
      ),
    ).toBe(true);
    expect(
      await quantity(later.merchandiseItemId, detailB.transitLocationId!),
    ).toBe(later.quantity);
    await f.deliver(b.id);
  });
  it("supports editable tracking and customs after dispatch while freezing contents", async () => {
    const f = await fixture(),
      shipment = await service.create(f.input);
    await f.ship(shipment.id);
    const detail = (await queries.detail(shipment.id))!;
    const updated = await service.update(
      {
        ...f.input,
        carrier: "DHL",
        trackingNumber: "NEW-TRACKING",
        customsDutyAmount: 400,
        importVatAmount: 1200,
        carrierCustomsFeeAmount: 500,
        otherImportFeesAmount: 0,
        importCurrency: "EUR",
      },
      detail.updatedAt.toISOString(),
    );
    expect(updated.importVatAmount).toBe(1200);
    expect(updated.otherShippingFeesAmount).toBeNull();
    await expect(
      service.update(f.input, detail.updatedAt.toISOString()),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      service.update(
        { ...f.input, items: [{ ...f.input.items[0], quantity: 1 }] },
        updated.updatedAt.toISOString(),
      ),
    ).rejects.toMatchObject({ code: "LOCKED" });
    await expect(
      db.shipmentItem.delete({ where: { id: shipment.items[0].id } }),
    ).rejects.toThrow();
    await expect(
      db.shipmentItem.update({
        where: { id: shipment.items[0].id },
        data: { quantity: 1 },
      }),
    ).rejects.toThrow();
  });
  it("edits preparation quantities and validates unknown costs and weight precisely", async () => {
    const f = await fixture(),
      shipment = await service.create(f.input);
    const updated = await service.update(
      {
        ...f.input,
        items: [{ merchandiseItemId: f.items[0].id, quantity: 9 }],
      },
      shipment.updatedAt.toISOString(),
    );
    expect((await queries.detail(shipment.id))?.items).toHaveLength(1);
    expect(updated.shippingCostAmount).toBe(5000);
    await expect(
      service.create({ ...f.input, id: randomUUID(), totalWeight: "1.2345" }),
    ).rejects.toThrow();
    await expect(
      service.create({ ...f.input, id: randomUUID(), shippingCurrency: null }),
    ).rejects.toThrow();
    await expect(
      service.create({ ...f.input, id: randomUUID(), importVatAmount: -1 }),
    ).rejects.toThrow();
  });
  it("rejects invalid arrival dates and inactive destination ancestry", async () => {
    const f = await fixture(),
      shipment = await service.create(f.input);
    await f.ship(shipment.id);
    await expect(
      service.deliver({
        id: shipment.id,
        arrivalDate: "2026-08-01",
        destinationLocationId: f.box.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DATE" });
    await db.storageLocation.update({
      where: { id: f.france.id },
      data: { active: false },
    });
    await expect(f.deliver(shipment.id)).rejects.toMatchObject({
      code: "INVALID_DESTINATION",
    });
    expect((await queries.detail(shipment.id))?.status).toBe("SHIPPED");
  });
  it("requires internal authorization for queries and all commands", async () => {
    const f = await fixture(),
      shipment = await service.create(f.input);
    const customer = await db.user.create({
        data: {
          id: randomUUID(),
          name: "Customer",
          email: `${randomUUID()}@example.test`,
        },
      }),
      denied = async () => ({ id: customer.id });
    const bad = createShipmentService(db, denied),
      reads = createShipmentQueries(db, denied);
    for (const operation of [
      () => bad.create(f.input),
      () => bad.update(f.input, shipment.updatedAt.toISOString()),
      () => bad.setStatus(shipment.id, "CANCELLED"),
      () => bad.ship({ id: shipment.id, shipmentDate: "2026-09-01" }),
      () =>
        bad.deliver({
          id: shipment.id,
          arrivalDate: "2026-09-08",
          destinationLocationId: f.box.id,
        }),
      () => reads.list({}),
      () => reads.detail(shipment.id),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
