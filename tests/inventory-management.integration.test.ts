import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createCatalogQueries } from "../src/modules/catalog/queries";
import { createLocationService } from "../src/modules/locations/service";
import { createLocationQueries } from "../src/modules/locations/queries";
import {
  createInventoryCommands,
  parseInventoryCommand,
} from "../src/modules/inventory/commands";
import { createInventoryQueries } from "../src/modules/inventory/queries";
import {
  getOwnedQuantity,
  reconcileInventory,
} from "../src/modules/inventory/operations";
import { formatMoney } from "../src/modules/shared/money";

const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = async () => ({ id: actorId });
const catalog = createCatalogService(db, authorize);
const locations = createLocationService(db, authorize);
const commands = createInventoryCommands(db, authorize);
const queries = createCatalogQueries(db, authorize);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Inventory operator",
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
    name: "Inventory test",
    slug: key,
  });
  const lineup = await catalog.createLineup({
    name: "Marine",
    slug: key,
    franchiseId: franchise.id,
  });
  const category = await catalog.createCategory({ name: "Stand", slug: key });
  const item = await catalog.createItem({
    name: "Rem",
    japaneseName: "レム",
    internalSku: key,
    slug: key,
    lineupId: lineup.id,
    categoryId: category.id,
  });
  const jp = await locations.create({
    code: `JP-${key}`,
    name: "Japan",
    type: "JAPAN_WAREHOUSE",
  });
  const transit = await locations.create({
    code: `TRANSIT-${key}`,
    name: "Transit",
    type: "IN_TRANSIT",
  });
  const fr = await locations.create({
    code: `FR-${key}`,
    name: "France",
    type: "FRANCE_HOME",
    fulfillmentEnabled: true,
  });
  const shelf = await locations.create({
    code: `SHELF-${key}`,
    name: "Shelf A",
    type: "SHELF",
    parentId: fr.id,
  });
  const box = await locations.create({
    code: `BOX-${key}`,
    name: "Box A1",
    type: "BOX",
    parentId: shelf.id,
    fulfillmentEnabled: true,
  });
  const command = (values: Record<string, unknown>) =>
    commands.execute({
      merchandiseItemId: item.id,
      operationKey: randomUUID(),
      ...values,
    });
  return { item, jp, transit, fr, shelf, box, command };
}
function locationValues(
  row: Awaited<ReturnType<typeof locations.create>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    code: row.code,
    name: row.name,
    type: row.type,
    parentId: row.parentId,
    active: row.active,
    fulfillmentEnabled: row.fulfillmentEnabled,
    notes: row.notes,
    ...overrides,
  };
}

describe("inventory management commands and physical lookup", () => {
  it("receives exact purchase cost with actor/reference and resolves physical paths across locations", async () => {
    const { item, jp, fr, box, command } = await fixture();
    const result = await command({
      movementType: "PURCHASE",
      quantity: "15",
      locationId: jp.id,
      unitCost: "1650",
      currency: "JPY",
      reference: "Receipt 123",
      note: "Factory sealed",
    });
    await command({
      movementType: "PURCHASE",
      quantity: "3",
      locationId: box.id,
      unitCost: "12.50",
      currency: "EUR",
    });
    expect(result.movement).toMatchObject({
      quantityDelta: 15,
      acquisitionUnitCostAmount: 1650,
      actorUserId: actorId,
      referenceId: "Receipt 123",
      notes: "Factory sealed",
    });
    const detail = await queries.detail(item.id);
    expect(detail?.stock).toMatchObject({ total: 18, fulfillable: 3 });
    expect(
      detail?.stock.locations.find((row) => row.locationId === box.id)?.path,
    ).toBe(`${fr.code} / Shelf A / Box A1`);
    const overview = await createInventoryQueries(db, authorize).overview({
      q: item.internalSku,
    });
    expect(overview.items[0]).toMatchObject({
      acquisition: { amount: 1250, currency: "EUR" },
      estimatedValue: { amount: 22500n, currency: "EUR" },
    });
    expect(await reconcileInventory(db, item.id)).toEqual([]);
  });

  it("moves JP → Transit → France without changing ownership or inventing acquisition costs", async () => {
    const { item, jp, transit, box, command } = await fixture();
    await command({
      movementType: "PURCHASE",
      quantity: 15,
      locationId: jp.id,
    });
    await command({
      movementType: "TRANSFER",
      quantity: 15,
      sourceLocationId: jp.id,
      destinationLocationId: transit.id,
    });
    expect((await queries.detail(item.id))?.stock).toMatchObject({
      total: 15,
      fulfillable: 0,
    });
    await command({
      movementType: "TRANSFER",
      quantity: 15,
      sourceLocationId: transit.id,
      destinationLocationId: box.id,
    });
    expect((await queries.detail(item.id))?.stock).toMatchObject({
      total: 15,
      fulfillable: 15,
    });
    const result = await createInventoryQueries(db, authorize).overview({
      q: item.internalSku,
    });
    expect(result.items[0].estimatedValue).toBeNull();
    expect(await reconcileInventory(db, item.id)).toEqual([]);
  });

  it("rejects insufficient transfers and identical endpoints atomically", async () => {
    const { item, jp, fr, command } = await fixture();
    await command({ movementType: "PURCHASE", quantity: 2, locationId: jp.id });
    await expect(
      command({
        movementType: "TRANSFER",
        quantity: 3,
        sourceLocationId: jp.id,
        destinationLocationId: fr.id,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    await expect(
      command({
        movementType: "TRANSFER",
        quantity: 1,
        sourceLocationId: jp.id,
        destinationLocationId: jp.id,
      }),
    ).rejects.toThrow();
    expect(await getOwnedQuantity(db, item.id)).toBe(2);
    expect(
      await db.inventoryMovement.count({
        where: { merchandiseItemId: item.id },
      }),
    ).toBe(1);
  });

  it("replays simultaneous identical operation keys and rejects changed payloads", async () => {
    const { item, jp, command } = await fixture();
    const payload = {
      movementType: "PURCHASE",
      quantity: 4,
      locationId: jp.id,
      operationKey: randomUUID(),
    };
    const results = await Promise.all([command(payload), command(payload)]);
    expect(results.map((row) => row.replayed).sort()).toEqual([false, true]);
    await expect(command({ ...payload, quantity: 5 })).rejects.toMatchObject({
      code: "OPERATION_KEY_CONFLICT",
    });
    expect(await getOwnedQuantity(db, item.id)).toBe(4);
  });

  it("serializes concurrent last-unit deductions without negative stock", async () => {
    const { item, fr, command } = await fixture();
    await command({ movementType: "PURCHASE", quantity: 1, locationId: fr.id });
    const results = await Promise.allSettled([
      command({ movementType: "SALE", quantity: 1, locationId: fr.id }),
      command({ movementType: "LOST", quantity: 1, locationId: fr.id }),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect(await getOwnedQuantity(db, item.id)).toBe(0);
    expect(await reconcileInventory(db, item.id)).toEqual([]);
  });

  it("records damaged, lost, gift, gacha, return, other and reasoned signed corrections", async () => {
    const { item, fr, command } = await fixture();
    await command({
      movementType: "PURCHASE",
      quantity: 10,
      locationId: fr.id,
    });
    for (const movementType of [
      "DAMAGED",
      "LOST",
      "GIFT",
      "GACHA",
      "RETURN",
      "OTHER",
    ])
      await command({
        movementType,
        quantity: 1,
        direction: "out",
        locationId: fr.id,
      });
    const result = await command({
      movementType: "ADJUSTMENT",
      quantity: -1,
      locationId: fr.id,
      reason: "Count mismatch",
      note: "Verified box twice",
    });
    expect(result.movement.notes).toBe(
      "Reason: Count mismatch\nNote: Verified box twice",
    );
    await command({
      movementType: "RETURN",
      quantity: 2,
      direction: "in",
      locationId: fr.id,
    });
    await command({
      movementType: "GACHA",
      quantity: 1,
      direction: "in",
      locationId: fr.id,
    });
    expect(await getOwnedQuantity(db, item.id)).toBe(6);
    await expect(
      command({
        movementType: "ADJUSTMENT",
        quantity: 1,
        locationId: fr.id,
        note: "No reason",
      }),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(
      command({
        movementType: "ADJUSTMENT",
        quantity: 1,
        locationId: fr.id,
        reason: "No note",
      }),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    expect(await reconcileInventory(db, item.id)).toEqual([]);
  });

  it("deactivates ancestors while preserving stock/history and allows stock to leave", async () => {
    const { item, fr, box, jp, command } = await fixture();
    await command({
      movementType: "PURCHASE",
      quantity: 5,
      locationId: box.id,
    });
    await locations.update({
      id: fr.id,
      updatedAt: fr.updatedAt.toISOString(),
      values: locationValues(fr, { active: false }),
    });
    expect((await queries.detail(item.id))?.stock).toMatchObject({
      total: 5,
      fulfillable: 0,
    });
    await expect(
      command({ movementType: "PURCHASE", quantity: 1, locationId: box.id }),
    ).rejects.toMatchObject({ code: "INACTIVE_LOCATION" });
    await command({
      movementType: "TRANSFER",
      quantity: 5,
      sourceLocationId: box.id,
      destinationLocationId: jp.id,
    });
    expect(await getOwnedQuantity(db, item.id)).toBe(5);
    expect(
      (await createLocationQueries(db, authorize).tree()).find(
        (row) => row.id === box.id,
      ),
    ).toMatchObject({ effectiveActive: false, fulfillable: false, units: 0 });
  });

  it("rejects circular hierarchy edits, duplicate codes and stale saves", async () => {
    const { fr, shelf, box } = await fixture();
    await expect(
      locations.update({
        id: fr.id,
        updatedAt: fr.updatedAt.toISOString(),
        values: locationValues(fr, { parentId: box.id }),
      }),
    ).rejects.toMatchObject({ code: "LOCATION_CYCLE" });
    await expect(
      locations.reparent({ id: shelf.id, parentId: shelf.id }),
    ).rejects.toMatchObject({ code: "LOCATION_CYCLE" });
    await expect(
      locations.create({ code: fr.code, name: "Duplicate", type: "OTHER" }),
    ).rejects.toMatchObject({ code: "P2002" });
    await locations.update({
      id: box.id,
      updatedAt: box.updatedAt.toISOString(),
      values: locationValues(box, { name: "Box renamed", notes: "Under desk" }),
    });
    await expect(
      locations.update({
        id: box.id,
        updatedAt: box.updatedAt.toISOString(),
        values: locationValues(box),
      }),
    ).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
    expect(
      (await createLocationQueries(db, authorize).tree()).find(
        (row) => row.id === box.id,
      )?.path,
    ).toBe(`${fr.code} / Shelf A / Box renamed`);
  });

  it("uses explicit fulfillment flags and blocks transit ancestors", async () => {
    const { item, fr, shelf, box, transit, command } = await fixture();
    await command({
      movementType: "PURCHASE",
      quantity: 2,
      locationId: shelf.id,
    });
    await command({
      movementType: "PURCHASE",
      quantity: 3,
      locationId: box.id,
    });
    expect((await queries.detail(item.id))?.stock.fulfillable).toBe(3);
    await locations.reparent({ id: fr.id, parentId: transit.id });
    expect((await queries.detail(item.id))?.stock).toMatchObject({
      total: 5,
      fulfillable: 0,
    });
    await expect(
      locations.create({
        code: randomUUID(),
        name: "Transit",
        type: "IN_TRANSIT",
        fulfillmentEnabled: true,
      }),
    ).rejects.toThrow();
  });

  it("filters immutable history by type, either endpoint and inclusive UTC dates", async () => {
    const { item, jp, transit, fr, command } = await fixture();
    const { movement } = await command({
      movementType: "PURCHASE",
      quantity: 5,
      locationId: jp.id,
      unitCost: "0",
      currency: "JPY",
      reference: "Free acquisition",
    });
    await command({
      movementType: "TRANSFER",
      quantity: 2,
      sourceLocationId: jp.id,
      destinationLocationId: transit.id,
    });
    await command({
      movementType: "TRANSFER",
      quantity: 2,
      sourceLocationId: transit.id,
      destinationLocationId: fr.id,
    });
    const date = movement.createdAt.toISOString().slice(0, 10);
    const history = await queries.movements(item.id, {
      type: "TRANSFER",
      location: transit.id,
      from: date,
      to: date,
      page: 999,
    });
    expect(history).toMatchObject({ total: 2, page: 1 });
    expect(history?.rows[0].actorUser?.name).toBe("Inventory operator");
    expect(
      history?.rows.every((row) => row.sourcePath && row.destinationPath),
    ).toBe(true);
    expect(
      (await queries.movements(item.id, { to: "2000-01-01" }))?.total,
    ).toBe(0);
    expect(
      (await queries.movements(item.id, { type: "PURCHASE" }))?.rows[0],
    ).toMatchObject({
      acquisitionUnitCostAmount: 0,
      referenceId: "Free acquisition",
    });
    await expect(
      db.inventoryMovement.update({
        where: { id: movement.id },
        data: { notes: "Rewrite" },
      }),
    ).rejects.toThrow();
  });

  it("includes archived owned merchandise by default and denies unauthorized access", async () => {
    const { item, jp, command } = await fixture();
    await command({ movementType: "PURCHASE", quantity: 1, locationId: jp.id });
    await catalog.archiveItem(item.id);
    expect(
      (
        await createInventoryQueries(db, authorize).overview({
          q: item.internalSku,
        })
      ).items[0]?.id,
    ).toBe(item.id);
    const outsider = await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Customer",
        isInternal: false,
      },
    });
    const denied = async () => ({ id: outsider.id });
    await expect(
      createInventoryCommands(db, denied).execute({
        merchandiseItemId: item.id,
        operationKey: randomUUID(),
        movementType: "PURCHASE",
        quantity: 1,
        locationId: jp.id,
      }),
    ).rejects.toThrow();
    await expect(createLocationQueries(db, denied).tree()).rejects.toThrow();
    await expect(
      createInventoryQueries(db, denied).overview(),
    ).rejects.toThrow();
    await expect(
      createLocationService(db, denied).update({
        id: jp.id,
        updatedAt: jp.updatedAt.toISOString(),
        values: locationValues(jp),
      }),
    ).rejects.toThrow();
  });

  it("rejects malformed commands and formats large estimates without precision loss", () => {
    const input = {
      merchandiseItemId: randomUUID(),
      operationKey: randomUUID(),
      movementType: "PURCHASE",
      quantity: 1,
      locationId: randomUUID(),
    };
    for (const override of [
      { quantity: 0 },
      { quantity: 1.5 },
      { quantity: -1 },
      { unitCost: "12.55" },
      { unitCost: "1.5", currency: "JPY" },
      { stock_quantity: 10 },
    ])
      expect(() => parseInventoryCommand({ ...input, ...override })).toThrow();
    expect(formatMoney(900719925474099199n, "EUR")).toBe(
      "€9,007,199,254,740,991.99",
    );
    expect(formatMoney(1650n, "JPY")).toBe("¥1,650");
  });
});
