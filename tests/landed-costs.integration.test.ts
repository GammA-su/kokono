import { makePublicationReady } from "./publication-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { createPurchaseService } from "../src/modules/purchases/service";
import { createShipmentService } from "../src/modules/shipments/service";
import { createLandedCostService } from "../src/modules/landed-costs/service";
import { createLandedCostQueries } from "../src/modules/landed-costs/queries";
import { components } from "../src/modules/landed-costs/validation";
import { getOwnedQuantity } from "../src/modules/inventory/operations";
import { createBulkManagementService } from "../src/modules/bulk-management/service";
import { listPublicListings } from "../src/modules/publication/queries";
import { createPublicationService } from "../src/modules/publication/service";
const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = async () => ({ id: actorId });
const catalog = createCatalogService(db, authorize),
  locations = createLocationService(db, authorize),
  purchasing = createPurchaseService(db, authorize),
  shipping = createShipmentService(db, authorize),
  costs = createLandedCostService(db, authorize),
  queries = createLandedCostQueries(db, authorize);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        name: "Cost reviewer",
        email: `${randomUUID()}@example.test`,
        isInternal: true,
      },
    })
  ).id;
});
afterAll(async () => {
  await db.$disconnect();
});
async function configure(importVatAsCost = true) {
  const previous = await db.landedCostSettings.findUnique({
    where: { id: "global" },
  });
  return costs.saveSettings({
    currency: "EUR",
    importVatAsCost,
    version: previous?.updatedAt.toISOString() ?? null,
  });
}
async function fixture() {
  await configure();
  const key = randomUUID();
  const franchise = await catalog.createFranchise({
      name: "Cost fixture",
      slug: key,
    }),
    lineup = await catalog.createLineup({
      name: "Marine",
      slug: key,
      franchiseId: franchise.id,
    }),
    category = await catalog.createCategory({ name: "Stand", slug: key });
  const items = [];
  for (const name of ["Rem", "Ram"])
    items.push(
      await catalog.createItem({
        name,
        internalSku: `${name}-${key}`,
        slug: `${name.toLowerCase()}-${key}`,
        lineupId: lineup.id,
        categoryId: category.id,
        officialMsrpAmount: 1650,
        officialMsrpCurrency: "JPY",
      }),
    );
  const jp = await locations.create({
      code: `JP-${key}`,
      name: "Japan",
      type: "JAPAN_WAREHOUSE",
    }),
    fr = await locations.create({
      code: `FR-${key}`,
      name: "France",
      type: "FRANCE_HOME",
      fulfillmentEnabled: true,
    }),
    transit = await locations.create({
      code: `TR-${key}`,
      name: "Transit",
      type: "IN_TRANSIT",
    });
  const purchase = await purchasing.create({
    id: randomUUID(),
    supplier: "Mercari Seller",
    externalReference: key,
    purchaseDate: "2026-08-01",
    currency: "JPY",
    status: "PAID",
    domesticShippingAmount: 101,
    feesAmount: 30,
    taxesAmount: 15,
    items: items.map((item, index) => ({
      merchandiseItemId: item.id,
      quantity: index === 0 ? 10 : 5,
      unitPriceAmount: index === 0 ? 100 : 200,
    })),
  });
  await purchasing.receive({
    purchaseId: purchase.id,
    itemIds: purchase.items.map((item) => item.id),
    destinationLocationId: jp.id,
  });
  const shipmentData = {
    id: randomUUID(),
    originLocationId: jp.id,
    destinationLocationId: fr.id,
    transitParentId: transit.id,
    shippingCostAmount: 101,
    insuranceCostAmount: 0,
    otherShippingFeesAmount: 0,
    shippingCurrency: "EUR",
    customsDutyAmount: 10,
    importVatAmount: 20,
    carrierCustomsFeeAmount: 5,
    otherImportFeesAmount: 0,
    importCurrency: "EUR",
    items: items.map((item, index) => ({
      merchandiseItemId: item.id,
      quantity: index === 0 ? 4 : 2,
    })),
  };
  const shipment = await shipping.create(shipmentData);
  await shipping.ship({ id: shipment.id, shipmentDate: "2026-09-01" });
  const input = {
    id: randomUUID(),
    shipmentId: shipment.id,
    method: "BY_QUANTITY",
    rates: { JPY: "0.01" },
    rateReference: "Recorded payment conversion",
    rows: shipment.items.map((item) => ({
      shipmentItemId: item.id,
      purchaseItemId: purchase.items.find(
        (line) => line.merchandiseItemId === item.merchandiseItemId,
      )!.id,
      quantity: item.quantity,
      unitOffset: 0,
      unitWeightGrams: item.quantity === 4 ? "100" : "400",
    })),
  };
  return { items, purchase, shipment, shipmentData, input };
}
describe("reviewed landed costs", () => {
  it("does not require landed cost to publish and keeps cost fields out of public selectors", async () => {
    const f = await fixture(),
      publication = createPublicationService(db, authorize);
    expect(await queries.estimates([f.items[0].id])).toEqual([]);
    await makePublicationReady(db, f.items[0].id);
    await publication.saveListing({
      merchandiseItemId: f.items[0].id,
      slug: `cost-unknown-${randomUUID()}`,
      sellingPriceAmount: 1500,
      sellingPriceCurrency: "EUR",
    });
    await publication.setPublished({
      merchandiseItemId: f.items[0].id,
      published: true,
    });
    const review = await costs.preview(f.input);
    await costs.finalize(f.input, review.reviewHash);
    const listing = await db.saleListing.findUniqueOrThrow({
      where: { merchandiseItemId: f.items[0].id },
    });
    expect(listing.sellingPriceAmount).toBe(1500);
    expect(listing.published).toBe(true);
    const publicData = JSON.stringify(await listPublicListings(db));
    expect(publicData).not.toContain("landedEstimate");
    expect(publicData).not.toContain("sourceSnapshot");
    expect(publicData).not.toContain("Recorded payment conversion");
  });
  it("serializes competing finalizations across shipments for the same acquired units", async () => {
    const f = await fixture(),
      second = await shipping.create({ ...f.shipmentData, id: randomUUID() });
    await shipping.ship({ id: second.id, shipmentDate: "2026-09-02" });
    const secondInput = {
      ...f.input,
      id: randomUUID(),
      shipmentId: second.id,
      rows: second.items.map((item) => ({
        ...f.input.rows.find(
          (row) =>
            row.purchaseItemId ===
            f.purchase.items.find(
              (batch) => batch.merchandiseItemId === item.merchandiseItemId,
            )!.id,
        )!,
        shipmentItemId: item.id,
      })),
    };
    const a = await costs.preview(f.input),
      b = await costs.preview(secondInput);
    const results = await Promise.allSettled([
      costs.finalize(f.input, a.reviewHash),
      costs.finalize(secondInput, b.reviewHash),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });
  it.each(["BY_QUANTITY", "BY_WEIGHT", "BY_ITEM_VALUE"])(
    "reviews and finalizes %s while preserving component totals and source records",
    async (method) => {
      const f = await fixture(),
        input = { ...f.input, method },
        before = await db.inventoryMovement.count({
          where: { merchandiseItemId: { in: f.items.map((item) => item.id) } },
        });
      const preview = await costs.preview(input);
      expect(
        await db.landedCostCalculation.count({
          where: { shipmentId: f.shipment.id },
        }),
      ).toBe(0);
      expect(preview.totalAmount).toBe("995");
      expect(preview.totals.domesticShipping).toBe("41");
      expect(preview.totals.marketplaceFees).toBe("12");
      expect(preview.totals.purchaseTaxes).toBe("6");
      for (const key of components)
        expect(
          preview.lines
            .reduce((sum, line) => sum + BigInt(line.components[key]), 0n)
            .toString(),
        ).toBe(preview.totals[key]);
      const result = await costs.finalize(input, preview.reviewHash);
      expect((await queries.detail(result.id))?.snapshot.totalAmount).toBe(
        "995",
      );
      expect(await getOwnedQuantity(db, f.items[0].id)).toBe(10);
      expect(
        await db.inventoryMovement.count({
          where: { merchandiseItemId: { in: f.items.map((item) => item.id) } },
        }),
      ).toBe(before);
      expect(
        (
          await db.merchandiseItem.findUniqueOrThrow({
            where: { id: f.items[0].id },
          })
        ).officialMsrpAmount,
      ).toBe(1650);
      expect(
        (await db.purchase.findUniqueOrThrow({ where: { id: f.purchase.id } }))
          .subtotalAmount,
      ).toBe(2000);
    },
  );
  it("supports explicit manual component allocation and rejects totals that do not reconcile", async () => {
    const f = await fixture(),
      input = {
        ...f.input,
        method: "MANUAL",
        rows: f.input.rows.map((row, index) => ({
          ...row,
          manual: {
            internationalShipping: index === 0 ? "60" : "41",
            customsDuty: index === 0 ? "10" : "0",
            importVat: index === 0 ? "20" : "0",
            carrierCustomsFee: index === 0 ? "5" : "0",
          },
        })),
      };
    const review = await costs.preview(input);
    expect(review.totalAmount).toBe("995");
    await costs.finalize(input, review.reviewHash);
    await expect(
      costs.preview({
        ...input,
        id: randomUUID(),
        rows: input.rows.map((row) => ({
          ...row,
          manual: { ...row.manual, internationalShipping: "1" },
        })),
      }),
    ).rejects.toMatchObject({ code: "MANUAL_TOTAL" });
  });
  it("requires actual weights for BY_WEIGHT and explicit nonzero FX", async () => {
    const f = await fixture();
    await expect(
      costs.preview({
        ...f.input,
        method: "BY_WEIGHT",
        rows: f.input.rows.map((row) => ({ ...row, unitWeightGrams: null })),
      }),
    ).rejects.toMatchObject({ code: "MISSING_WEIGHT" });
    await expect(
      costs.preview({ ...f.input, rates: {} }),
    ).rejects.toMatchObject({ code: "MISSING_RATE" });
    await expect(
      costs.preview({ ...f.input, rates: { JPY: "0" } }),
    ).rejects.toMatchObject({ code: "INVALID_RATE" });
  });
  it("snapshots VAT policy and refuses stale review after policy changes", async () => {
    const f = await fixture(),
      included = await costs.preview(f.input);
    await configure(false);
    await expect(
      costs.finalize(f.input, included.reviewHash),
    ).rejects.toMatchObject({ code: "STALE_REVIEW" });
    const excluded = await costs.preview(f.input);
    expect(excluded.totalAmount).toBe("975");
    expect(excluded.totals.importVat).toBe("0");
    const final = await costs.finalize(f.input, excluded.reviewHash);
    await configure(true);
    expect((await queries.detail(final.id))?.snapshot.importVatAsCost).toBe(
      false,
    );
  });
  it("preserves history across changed shipment charges and rejects stale source reviews", async () => {
    const f = await fixture(),
      first = await costs.preview(f.input),
      one = await costs.finalize(f.input, first.reviewHash);
    const nextInput = { ...f.input, id: randomUUID() },
      stale = await costs.preview(nextInput);
    const current = await db.shipment.findUniqueOrThrow({
      where: { id: f.shipment.id },
    });
    await shipping.update(
      { ...f.shipmentData, shippingCostAmount: 201 },
      current.updatedAt.toISOString(),
    );
    await expect(
      costs.finalize(nextInput, stale.reviewHash),
    ).rejects.toMatchObject({ code: "STALE_REVIEW" });
    const second = await costs.preview(nextInput),
      two = await costs.finalize(nextInput, second.reviewHash);
    expect(second.revision).toBe(2);
    expect(second.totalAmount).toBe("1095");
    expect((await queries.detail(one.id))?.snapshot.totalAmount).toBe("995");
    expect((await queries.inputs(f.shipment.id))?.history).toHaveLength(2);
    expect((await queries.estimates([f.items[0].id]))[0].calculationId).toBe(
      two.id,
    );
    await expect(
      db.landedCostCalculation.delete({ where: { id: one.id } }),
    ).rejects.toThrow();
    await expect(
      db.landedCostLine.updateMany({
        where: { calculationId: one.id },
        data: { quantity: 1 },
      }),
    ).rejects.toThrow();
  });
  it("rejects missing costs rather than silently treating them as zero", async () => {
    const f = await fixture(),
      current = await db.shipment.findUniqueOrThrow({
        where: { id: f.shipment.id },
      });
    await shipping.update(
      { ...f.shipmentData, insuranceCostAmount: null },
      current.updatedAt.toISOString(),
    );
    const review = await costs.preview(f.input);
    expect(review.blockers).not.toHaveLength(0);
    await expect(
      costs.finalize(f.input, review.reviewHash),
    ).rejects.toMatchObject({ code: "INCOMPLETE_COSTS" });
  });
  it("requires exact quantity coverage and prevents overlapping acquisition ranges", async () => {
    const f = await fixture();
    await expect(
      costs.preview({ ...f.input, rows: [f.input.rows[0]] }),
    ).rejects.toMatchObject({ code: "QUANTITY_MISMATCH" });
    const row = f.input.rows.find((row) => row.quantity === 4)!;
    await expect(
      costs.preview({
        ...f.input,
        rows: [
          ...f.input.rows.filter((other) => other !== row),
          { ...row, quantity: 2 },
          { ...row, quantity: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: "BATCH_OVERLAP" });
    const review = await costs.preview(f.input);
    await costs.finalize(f.input, review.reviewHash);
    const second = await shipping.create({
      ...f.shipmentData,
      id: randomUUID(),
    });
    await shipping.ship({ id: second.id, shipmentDate: "2026-09-02" });
    const next = {
      ...f.input,
      id: randomUUID(),
      shipmentId: second.id,
      rows: second.items.map((item) => ({
        ...f.input.rows.find(
          (row) =>
            row.purchaseItemId ===
            f.purchase.items.find(
              (line) => line.merchandiseItemId === item.merchandiseItemId,
            )!.id,
        )!,
        shipmentItemId: item.id,
      })),
    };
    await expect(costs.preview(next)).rejects.toMatchObject({
      code: "BATCH_OVERLAP",
    });
    const disjoint = {
      ...next,
      rows: next.rows.map((row) => ({ ...row, unitOffset: row.quantity })),
    };
    expect((await costs.preview(disjoint)).blockers).toEqual([]);
  });
  it("supports split rows from one purchase without duplicate domestic charges", async () => {
    const f = await fixture(),
      row = f.input.rows.find((row) => row.quantity === 4)!;
    const review = await costs.preview({
      ...f.input,
      rows: [
        ...f.input.rows.filter((other) => other !== row),
        { ...row, quantity: 2 },
        { ...row, quantity: 2, unitOffset: 2 },
      ],
    });
    expect(review.totalAmount).toBe("995");
    expect(review.totals.domesticShipping).toBe("41");
  });
  it("deduplicates simultaneous finalization and rejects changed input with a reused identity", async () => {
    const f = await fixture(),
      review = await costs.preview(f.input);
    const result = await Promise.all([
      costs.finalize(f.input, review.reviewHash),
      costs.finalize(f.input, review.reviewHash),
    ]);
    expect(result[0].id).toBe(result[1].id);
    expect(result.filter((row) => row.replayed)).toHaveLength(1);
    await expect(
      costs.finalize({ ...f.input, method: "MANUAL" }, review.reviewHash),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("exposes private estimates to publication review, without making them publication requirements", async () => {
    const f = await fixture();
    const review = await costs.preview(f.input);
    await costs.finalize(f.input, review.reviewHash);
    const bulk = createBulkManagementService(
      db,
      authorize,
      "landed-cost-test-secret-at-least-32-characters",
    );
    const prepared = await bulk.prepare({
      action: "publish",
      selection: { mode: "explicit", ids: [f.items[0].id] },
      filters: {},
    });
    expect(prepared.items[0].landedEstimate?.currency).toBe("EUR");
    const publicData = JSON.stringify(await listPublicListings(db));
    expect(publicData).not.toContain("landedEstimate");
    expect(publicData).not.toContain("Recorded payment conversion");
    const empty = await queries.estimates([randomUUID()]);
    expect(empty).toEqual([]);
  });
  it("requires internal authorization for policy, preview, finalization and estimates", async () => {
    const f = await fixture(),
      review = await costs.preview(f.input),
      customer = await db.user.create({
        data: {
          id: randomUUID(),
          name: "Customer",
          email: `${randomUUID()}@example.test`,
        },
      }),
      denied = async () => ({ id: customer.id });
    const service = createLandedCostService(db, denied),
      reads = createLandedCostQueries(db, denied);
    for (const operation of [
      () =>
        service.saveSettings({
          currency: "EUR",
          importVatAsCost: true,
          version: null,
        }),
      () => service.preview(f.input),
      () => service.finalize(f.input, review.reviewHash),
      () => reads.inputs(f.shipment.id),
      () => reads.estimates([f.items[0].id]),
      () => reads.detail(randomUUID()),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
