import { makePublicationReady } from "./publication-fixture";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createDashboardQueries } from "../src/modules/dashboard/queries";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { createPublicationService } from "../src/modules/publication/service";
import { createInventoryQueries } from "../src/modules/inventory/queries";
import { applyInventoryOperation } from "../src/modules/inventory/operations";
import { formatPartialDate } from "../src/modules/catalog/partial-date";

// A dedicated disposable schema permits meaningful empty-database and exact aggregate assertions.
const url = new URL(inject("testDatabaseUrl"));
if (!url.pathname.endsWith("_test"))
  throw new Error("Dashboard tests require the test database.");
const schema = `test_dashboard_${randomUUID().replaceAll("-", "")}`;
url.searchParams.set("schema", schema);
const db = createDatabaseClient(url.toString());
const poolUrl = new URL(url);
poolUrl.searchParams.delete("schema");
const pool = new Pool({ connectionString: poolUrl.toString() });
let actorId: string;
const authorize = async () => ({ id: actorId });
const dashboard = createDashboardQueries(db, authorize);
const catalog = createCatalogService(db, authorize);
const locations = createLocationService(db, authorize);
const publication = createPublicationService(db, authorize);
const itemIds: string[] = [];
let franchiseId: string,
  lineupId: string,
  franceId: string;
beforeAll(async () => {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await promisify(execFile)(
    process.execPath,
    [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: url.toString() },
      timeout: 60000,
    },
  );
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Dashboard operator",
        isInternal: true,
      },
    })
  ).id;
});
afterAll(async () => {
  await db.$disconnect();
  if (!/^test_dashboard_[a-f0-9]{32}$/.test(schema))
    throw new Error("Unsafe schema cleanup");
  try {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
});
describe("internal operations dashboard", () => {
  it("returns empty metrics and unavailable costs without inventing zero values", async () => {
    const data = await dashboard.overview();
    const value = await dashboard.valuation();
    expect(Object.values(data.metrics).every((value) => value === 0n)).toBe(
      true,
    );
    expect(value.acquisition).toEqual([]);
    expect(value.inventoryValue).toEqual([]);
    expect(value.retail).toEqual([]);
    expect(value.landedValue).toBeNull();
    expect(data.lowStock).toEqual([]);
    expect(data.latestLineups).toEqual([]);
    expect(data.activity).toEqual([]);
    expect(data.years).toEqual([]);
  });
  it("aggregates catalog, sourcing, physical geography and visible listings without join fanout", async () => {
    const franchise = await catalog.createFranchise({
      name: "Re:Zero",
      slug: randomUUID(),
    });
    franchiseId = franchise.id;
    const lineup = await catalog.createLineup({
      name: "Marine 2026",
      slug: randomUUID(),
      franchiseId,
      releaseDate: "2026-11",
    });
    lineupId = lineup.id;
    await catalog.createLineup({
      name: "Old release",
      slug: randomUUID(),
      franchiseId,
      releaseDate: "2025",
    });
    await catalog.createLineup({
      name: "Unknown release",
      slug: randomUUID(),
      franchiseId,
    });
    const category = await catalog.createCategory({
      name: "Stand",
      slug: randomUUID(),
    });
    for (let n = 0; n < 7; n++)
      itemIds.push(
        (
          await catalog.createItem({
            name: `Stand ${n}`,
            japaneseName: `レム ${n}`,
            internalSku: randomUUID(),
            slug: randomUUID(),
            categoryId: category.id,
            lineupId,
          })
        ).id,
      );
    const jp = await locations.create({
      name: "Tokyo depot",
      code: randomUUID(),
      type: "WAREHOUSE",
      countryCode: "JP",
    });
    const jpBox = await locations.create({
      name: "Box",
      code: randomUUID(),
      type: "BOX",
      parentId: jp.id,
    });
    const fr = await locations.create({
      name: "Paris depot",
      code: randomUUID(),
      type: "OTHER",
      countryCode: "FR",
      fulfillmentEnabled: true,
    });
    franceId = fr.id;
    const frBox = await locations.create({
      name: "Shelf A",
      code: randomUUID(),
      type: "SHELF",
      parentId: fr.id,
      fulfillmentEnabled: true,
    });
    const transit = await locations.create({
      name: "Freight",
      code: randomUUID(),
      type: "IN_TRANSIT",
      countryCode: "JP",
    });
    const transitBox = await locations.create({
      name: "Container",
      code: randomUUID(),
      type: "BOX",
      parentId: transit.id,
    });
    const offline = await locations.create({
      name: "Closed depot",
      code: randomUUID(),
      type: "WAREHOUSE",
      countryCode: "FR",
    });
    const offlineBox = await locations.create({
      name: "Closed box",
      code: randomUUID(),
      type: "BOX",
      parentId: offline.id,
      fulfillmentEnabled: true,
    });
    const unknown = await locations.create({
      name: "Unassigned country",
      code: "JP-NAME-IS-NOT-GEOGRAPHY",
      type: "OTHER",
    });
    const receive = (
      index: number,
      destinationLocationId: string,
      quantityDelta: number,
      cost?: [number, string],
    ) =>
      applyInventoryOperation(
        db,
        {
          merchandiseItemId: itemIds[index],
          movementType: "PURCHASE",
          operationKey: randomUUID(),
          destinationLocationId,
          quantityDelta,
          ...(cost
            ? {
                acquisitionUnitCostAmount: cost[0],
                acquisitionUnitCostCurrency: cost[1],
              }
            : {}),
        },
        actorId,
      );
    await receive(0, jpBox.id, 20, [1000, "JPY"]);
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: itemIds[0],
        movementType: "TRANSFER",
        operationKey: randomUUID(),
        sourceLocationId: jpBox.id,
        destinationLocationId: frBox.id,
        quantityDelta: 3,
      },
      actorId,
    );
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: itemIds[0],
        movementType: "TRANSFER",
        operationKey: randomUUID(),
        sourceLocationId: jpBox.id,
        destinationLocationId: transitBox.id,
        quantityDelta: 2,
      },
      actorId,
    );
    await receive(1, fr.id, 2); // Missing cost, published price in EUR.
    await receive(3, offlineBox.id, 4, [200, "EUR"]);
    await receive(4, fr.id, 1, [0, "JPY"]); // A known zero cost must remain known.
    await receive(5, unknown.id, 6, [50, "JPY"]);
    await locations.update({
      id: offline.id,
      updatedAt: offline.updatedAt.toISOString(),
      values: {
        name: offline.name,
        code: offline.code,
        type: offline.type,
        countryCode: "FR",
        active: false,
      },
    });
    for (const [index, priority, target, checked, enabled] of [
      [0, "URGENT", 25, null, true],
      [1, "HIGH", 2, new Date(), true],
      [2, "NORMAL", 9, new Date("2020-01-01"), true],
      [3, "LOW", null, new Date(), true],
      [4, "URGENT", 9, null, false],
    ] as const) {
      await catalog.savePurchaseWatch({
        merchandiseItemId: itemIds[index],
        enabled,
        priority,
        targetQuantity: target,
      });
      await db.purchaseWatch.update({
        where: { merchandiseItemId: itemIds[index] },
        data: { lastCheckedAt: checked },
      });
    }
    for (const index of [0, 1, 2, 3, 4]) {
      await makePublicationReady(db, itemIds[index]);
      await publication.saveListing({
        merchandiseItemId: itemIds[index],
        slug: randomUUID(),
        sellingPriceAmount: 1500,
        sellingPriceCurrency: "EUR",
      });
      if (index !== 3)
        await publication.setPublished({
          merchandiseItemId: itemIds[index],
          published: true,
        });
    }
    await db.saleListing.update({
      where: { merchandiseItemId: itemIds[0] },
      data: { featured: true },
    });
    await db.merchandiseItem.update({
      where: { id: itemIds[4] },
      data: { archivedAt: new Date() },
    });
    await db.merchandiseItem.update({
      where: { id: itemIds[6] },
      data: { createdAt: new Date("2020-01-01") },
    });
    const data = await dashboard.overview();
    expect(data.metrics).toEqual({
      franchises: 1n,
      lineups: 3n,
      items: 7n,
      recent: 6n,
      watched: 4n,
      high: 1n,
      urgent: 1n,
      below: 2n,
      unchecked: 2n,
      owned: 33n,
      fulfillable: 6n,
      stocked: 5n,
      published: 3n,
      drafts: 1n,
      outOfStock: 1n,
      featured: 1n,
    });
    expect(data.geography).toEqual({
      japan: 15n,
      transit: 2n,
      france: 10n,
      other: 6n,
    });
    expect(data.logistics.find((row) => row.id === jp.id)?.units).toBe(15n);
    expect(data.logistics.find((row) => row.id === fr.id)?.units).toBe(6n);
    expect(data.logistics.reduce((sum, row) => sum + row.units, 0n)).toBe(
      data.metrics.owned,
    );
    expect(data.priority.map((row) => row.id)).toEqual([
      itemIds[0],
      itemIds[1],
    ]);
    expect(data.gaps.map((row) => row.id)).toEqual([itemIds[2], itemIds[0]]);
    expect(data.unchecked.map((row) => row.id)).toEqual([
      itemIds[0],
      itemIds[2],
    ]);
    expect(data.lowStock.map((row) => row.id)).toEqual([
      itemIds[2],
      itemIds[1],
      itemIds[0],
    ]);
    expect(data.recentlyAdded).toHaveLength(5);
    expect(data.recentlyAdded.some((row) => row.id === itemIds[6])).toBe(false);
    expect(data.franchises[0]).toMatchObject({
      id: franchiseId,
      items: 7n,
      ownedSkus: 5n,
      units: 33n,
    });
    expect(data.years).toEqual([
      { year: 2026, count: 1n },
      { year: 2025, count: 1n },
      { year: null, count: 1n },
    ]);
    expect(data.latestLineups[0].id).toBe(lineupId);
    expect(
      formatPartialDate(
        data.latestLineups[0].releaseDate,
        data.latestLineups[0].releaseDatePrecision,
      ),
    ).toBe("November 2026");
  });
  it("keeps currencies separate, distinguishes unknown from zero and agrees with inventory estimates", async () => {
    const data = await dashboard.valuation();
    expect(data.acquisition).toEqual([
      { currency: "EUR", amount: 800n, units: 4n, skus: 1n },
      { currency: "JPY", amount: 20300n, units: 27n, skus: 3n },
      { currency: null, amount: null, units: 2n, skus: 1n },
    ]);
    expect(data.inventoryValue).toEqual(data.acquisition);
    expect(data.retail).toEqual([
      { currency: "EUR", amount: 7500n, units: 5n, skus: 2n },
      { currency: null, amount: null, units: 1n, skus: 1n },
    ]);
    expect(data.landedValue).toBeNull();
    const inventory = await createInventoryQueries(db, authorize).overview({
      franchise: franchiseId,
    });
    expect(
      inventory.items.find((row) => row.id === itemIds[4])?.estimatedValue,
    ).toEqual({ currency: "JPY", amount: 0n });
    expect(
      inventory.items.find((row) => row.id === itemIds[1])?.estimatedValue,
    ).toBeNull();
    // Later uncosted receipt uses the same latest-known-cost estimate, without hiding missing receipt costs.
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: itemIds[0],
        destinationLocationId: franceId,
        movementType: "PURCHASE",
        quantityDelta: 1,
        operationKey: randomUUID(),
      },
      actorId,
    );
    const after = await dashboard.valuation();
    expect(
      after.inventoryValue.find((row) => row.currency === "JPY")?.amount,
    ).toBe(21300n);
    expect(after.acquisition.find((row) => row.currency === null)?.units).toBe(
      3n,
    );
    expect(
      after.acquisition.find((row) => row.currency === "JPY")?.amount,
    ).toBe(20300n);
  });
  it("shows all movement kinds, signed removals, actor, physical paths and bounded activity", async () => {
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: itemIds[5],
        destinationLocationId: franceId,
        movementType: "PURCHASE",
        quantityDelta: 10,
        acquisitionUnitCostAmount: 200,
        acquisitionUnitCostCurrency: "JPY",
        operationKey: randomUUID(),
      },
      actorId,
    );
    for (const movementType of [
      "SALE",
      "GACHA",
      "DAMAGED",
      "LOST",
      "ADJUSTMENT",
    ] as const) {
      await applyInventoryOperation(
        db,
        {
          merchandiseItemId: itemIds[5],
          sourceLocationId: franceId,
          movementType,
          quantityDelta: -1,
          notes: "Dashboard verification",
          referenceType: "TEST",
          referenceId: "DASHBOARD-REF",
          operationKey: randomUUID(),
        },
        actorId,
      );
    }
    const data = await dashboard.overview();
    expect(data.activity).toHaveLength(10);
    expect(data.activity.slice(0, 5).map((row) => row.movementType)).toEqual([
      "ADJUSTMENT",
      "LOST",
      "DAMAGED",
      "GACHA",
      "SALE",
    ]);
    expect(data.activity[0]).toMatchObject({
      quantityDelta: -1,
      actorUser: { name: "Dashboard operator" },
      referenceId: "DASHBOARD-REF",
    });
    expect(data.activity[0].sourcePath).toBeTruthy();
    expect(data.activity[5]).toMatchObject({
      acquisitionUnitCostAmount: 200,
      acquisitionUnitCostCurrency: "JPY",
    });
  });
  it("hides archived franchise listings while retaining physical assets and sourcing", async () => {
    const before = await dashboard.overview();
    await db.franchise.update({
      where: { id: franchiseId },
      data: { archivedAt: new Date() },
    });
    const after = await dashboard.overview();
    expect(after.metrics.published).toBe(0n);
    expect(after.metrics.featured).toBe(0n);
    expect(after.lowStock).toEqual([]);
    expect(after.latestLineups).toEqual([]);
    expect(after.metrics.owned).toBe(before.metrics.owned);
    expect(after.metrics.watched).toBe(before.metrics.watched);
    // Stock behind an archived franchise keeps its units but loses every price, so the
    // separately loaded valuation must still report those units as uncovered.
    const value = await dashboard.valuation();
    expect(
      value.retail.every((row) => row.currency === null && row.amount === null),
    ).toBe(true);
    expect(value.retail.reduce((sum, row) => sum + row.units, 0n)).toBeGreaterThan(0n);
  });
  it("rejects missing, external, inactive and revoked internal accounts at the data layer", async () => {
    await expect(
      createDashboardQueries(db, async () => ({ id: "" })).overview(),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    for (const [isInternal, active] of [
      [false, true],
      [true, false],
    ]) {
      const user = await db.user.create({
        data: {
          id: randomUUID(),
          name: "Unauthorized",
          email: `${randomUUID()}@example.test`,
          isInternal,
          active,
        },
      });
      await expect(
        createDashboardQueries(db, async () => user).overview(),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await db.user.update({
      where: { id: actorId },
      data: { isInternal: false },
    });
    await expect(dashboard.overview()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
