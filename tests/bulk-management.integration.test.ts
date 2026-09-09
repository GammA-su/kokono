import { makePublicationReady } from "./publication-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { assertInternalAccount } from "../src/modules/auth/authorization";
import { createCatalogService } from "../src/modules/catalog/service";
import { createCatalogQueries } from "../src/modules/catalog/queries";
import { createPublicationService } from "../src/modules/publication/service";
import { createBulkManagementService } from "../src/modules/bulk-management/service";
import type { BulkAction } from "../src/modules/bulk-management/selection";
import {
  getOwnedQuantity,
  reconcileInventory,
} from "../src/modules/inventory/operations";
import { getPublicListing } from "../src/modules/publication/queries";
import { guardPgQueryConcurrency } from "./pg-query-guard";

guardPgQueryConcurrency();
const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = () => assertInternalAccount(db, actorId);
const secret = "test-bulk-management-secret-with-32-characters";
const bulk = createBulkManagementService(db, authorize, secret);
const catalog = createCatalogService(db, authorize);
const queries = createCatalogQueries(db, authorize);
const publication = createPublicationService(db, authorize);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        name: "Bulk manager",
        email: `${randomUUID()}@example.test`,
        isInternal: true,
      },
    })
  ).id;
});
afterAll(() => db.$disconnect());

async function fixture(count = 3) {
  const franchise = await catalog.createFranchise({
    name: "Re:Zero",
    slug: randomUUID(),
  });
  const lineup = await catalog.createLineup({
    franchiseId: franchise.id,
    name: "Marine 2026",
    slug: randomUUID(),
    releaseDate: "2026-11",
  });
  const category = await catalog.createCategory({
    name: "Stand",
    slug: randomUUID(),
  });
  const items = [];
  for (let index = 0; index < count; index++)
    items.push(
      await catalog.createItem({
        name: `Rem ${index}`,
        lineupId: lineup.id,
        categoryId: category.id,
        internalSku: randomUUID(),
        slug: randomUUID(),
      }),
    );
  const source = await db.storageLocation.create({
    data: {
      code: `JP-${randomUUID()}`,
      name: "Warehouse",
      type: "JAPAN_WAREHOUSE",
    },
  });
  const destination = await db.storageLocation.create({
    data: {
      code: `FR-${randomUUID()}`,
      name: "Home",
      type: "FRANCE_HOME",
      fulfillmentEnabled: true,
    },
  });
  for (const item of items) await makePublicationReady(db, item.id);
  return { lineup, category, items, source, destination };
}
async function prepare(
  action: BulkAction,
  ids: string[],
  filters: Record<string, unknown> = {},
) {
  return bulk.prepare({
    action,
    filters: { archived: "true", ...filters },
    selection: { mode: "explicit", ids },
  });
}
const rows = (
  items: { id: string }[],
  values: (index: number) => Record<string, unknown>,
) => items.map((item, index) => ({ id: item.id, values: values(index) }));

describe("bulk merchandise management", () => {
  it("resolves entire lineup across pages, including archived items, and freezes the snapshot", async () => {
    const f = await fixture(28);
    await catalog.archiveItem(f.items[0].id);
    const review = await bulk.prepare({
      action: "watch",
      filters: { page: 2, size: 24 },
      selection: {
        mode: "lineup",
        lineupId: f.lineup.id,
        excludedIds: [f.items[1].id],
      },
    });
    expect(review.items).toHaveLength(27);
    expect(review.items.some((item) => item.id === f.items[0].id)).toBe(true);
    const later = await catalog.createItem({
      name: "Later addition",
      lineupId: f.lineup.id,
      categoryId: f.category.id,
      internalSku: randomUUID(),
      slug: randomUUID(),
    });
    const result = await bulk.execute({
      token: review.token,
      defaults: { priority: "HIGH", targetQuantity: 2 },
    });
    expect(result.updated).toBe(27);
    expect(
      await db.purchaseWatch.findUnique({
        where: { merchandiseItemId: later.id },
      }),
    ).toBeNull();
    expect(
      await db.purchaseWatch.findUnique({
        where: { merchandiseItemId: f.items[1].id },
      }),
    ).toBeNull();
  });
  it("uses existing catalog filters and NFKC search normalization for explicit selection", async () => {
    const f = await fixture();
    const filters = { lineup: f.lineup.id, q: "Ｒｅｍ １" };
    const list = await queries.list(filters);
    const review = await prepare(
      "watch",
      f.items.map((i) => i.id),
      filters,
    );
    expect(review.items.map((i) => i.id)).toEqual(list.items.map((i) => i.id));
    expect(review.omitted).toBe(2);
  });
  it("creates/updates watches using defaults and per-item overrides, preserving sourcing notes", async () => {
    const f = await fixture();
    await catalog.savePurchaseWatch({
      merchandiseItemId: f.items[0].id,
      notes: "Keep this",
      marketplaceSearchQuery: "Rem marine",
    });
    const review = await prepare(
      "watch",
      f.items.map((i) => i.id),
    );
    const result = await bulk.execute({
      token: review.token,
      defaults: {
        enabled: true,
        priority: "HIGH",
        targetQuantity: 2,
        maximumPrice: "1650",
        watchCurrency: "JPY",
        conditionPreference: "Sealed",
      },
      rows: [
        {
          id: f.items[1].id,
          values: { targetQuantity: 5, priority: "URGENT", enabled: false },
        },
      ],
    });
    expect(result.updated).toBe(3);
    expect(
      await db.purchaseWatch.findUnique({
        where: { merchandiseItemId: f.items[0].id },
      }),
    ).toMatchObject({
      notes: "Keep this",
      marketplaceSearchQuery: "Rem marine",
      maxUnitPriceAmount: 1650,
      conditionPreference: "Sealed",
    });
    expect(
      await db.purchaseWatch.findUnique({
        where: { merchandiseItemId: f.items[1].id },
      }),
    ).toMatchObject({ enabled: false, targetQuantity: 5, priority: "URGENT" });
    const disable = await prepare(
      "disable-watch",
      f.items.map((i) => i.id),
    );
    expect(await bulk.execute({ token: disable.token })).toMatchObject({
      updated: 2,
      skipped: 1,
      failed: 0,
    });
  });
  it("receives different quantities/costs and retries without duplicate movements", async () => {
    const f = await fixture();
    const review = await prepare(
      "receive",
      f.items.map((i) => i.id),
    );
    const request = {
      token: review.token,
      defaults: {
        destinationLocationId: f.source.id,
        cost: "900",
        costCurrency: "JPY",
        reference: "order-123",
        note: "Arrived",
      },
      rows: rows(f.items, (i) => ({
        quantity: i + 1,
        ...(i === 1 ? { cost: "1100" } : {}),
      })),
    };
    const first = await bulk.execute(request);
    expect(first).toMatchObject({ updated: 3, failed: 0 });
    expect(await bulk.execute(request)).toMatchObject({
      updated: 0,
      skipped: 3,
      failed: 0,
    });
    for (let index = 0; index < f.items.length; index++) {
      expect(await getOwnedQuantity(db, f.items[index].id)).toBe(index + 1);
      expect(
        await db.inventoryMovement.count({
          where: { merchandiseItemId: f.items[index].id },
        }),
      ).toBe(1);
      expect(await reconcileInventory(db, f.items[index].id)).toEqual([]);
    }
    expect(
      await db.inventoryMovement.findFirst({
        where: { merchandiseItemId: f.items[1].id },
      }),
    ).toMatchObject({
      acquisitionUnitCostAmount: 1100,
      referenceType: "PURCHASE",
      referenceId: "order-123",
      actorUserId: actorId,
    });
  });
  it("rejects changed inventory retries, missing quantities and inactive destinations", async () => {
    const f = await fixture(1);
    const review = await prepare("receive", [f.items[0].id]);
    const base = {
      token: review.token,
      defaults: { destinationLocationId: f.source.id },
    };
    expect((await bulk.execute(base)).failed).toBe(1);
    expect(
      (
        await bulk.execute({
          ...base,
          rows: rows(f.items, () => ({ quantity: 2 })),
        })
      ).updated,
    ).toBe(1);
    const changed = await bulk.execute({
      ...base,
      rows: rows(f.items, () => ({ quantity: 9 })),
    });
    expect(changed.results[0].reason).toContain("operation key");
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(2);
    await db.storageLocation.update({
      where: { id: f.destination.id },
      data: { active: false },
    });
    const other = await prepare("receive", [f.items[0].id]);
    const inactive = await bulk.execute({
      token: other.token,
      defaults: { destinationLocationId: f.destination.id },
      rows: rows(f.items, () => ({ quantity: 1 })),
    });
    expect(inactive.results[0].reason).toContain("inactive");
  });
  it("transfers atomically per item, reports insufficient stock, and conserves ownership", async () => {
    const f = await fixture();
    const receive = await prepare(
      "receive",
      f.items.map((i) => i.id),
    );
    await bulk.execute({
      token: receive.token,
      defaults: { destinationLocationId: f.source.id },
      rows: rows(f.items, () => ({ quantity: 3 })),
    });
    const review = await prepare(
      "transfer",
      f.items.map((i) => i.id),
    );
    const result = await bulk.execute({
      token: review.token,
      defaults: {
        sourceLocationId: f.source.id,
        destinationLocationId: f.destination.id,
      },
      rows: rows(f.items, (i) => ({ quantity: i === 1 ? 99 : i + 1 })),
    });
    expect(result).toMatchObject({ updated: 2, failed: 1 });
    expect(
      result.results.find((r) => r.id === f.items[1].id)?.reason,
    ).toContain("not enough stock");
    expect(
      await db.inventoryBalance.findUnique({
        where: {
          merchandiseItemId_storageLocationId: {
            merchandiseItemId: f.items[1].id,
            storageLocationId: f.destination.id,
          },
        },
      }),
    ).toBeNull();
    for (const item of f.items) {
      expect(await getOwnedQuantity(db, item.id)).toBe(3);
      expect(await reconcileInventory(db, item.id)).toEqual([]);
    }
  });
  it("requires an adjustment reason and records signed movements instead of assigning totals", async () => {
    const f = await fixture(1);
    const review = await prepare("adjust", [f.items[0].id]);
    const input = {
      token: review.token,
      defaults: { locationId: f.source.id },
      rows: rows(f.items, () => ({ quantity: 5 })),
    };
    expect((await bulk.execute(input)).results[0].reason).toContain(
      "explanation",
    );
    expect(
      (
        await bulk.execute({
          ...input,
          defaults: { ...input.defaults, note: "Counted missing receipt" },
        })
      ).updated,
    ).toBe(1);
    const decrease = await prepare("adjust", [f.items[0].id]);
    expect(
      (
        await bulk.execute({
          token: decrease.token,
          defaults: { locationId: f.source.id, note: "Correct count" },
          rows: rows(f.items, () => ({ quantity: -2 })),
        })
      ).updated,
    ).toBe(1);
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(3);
    expect(await reconcileInventory(db, f.items[0].id)).toEqual([]);
  });
  it("hands publishing to review and publishes only valid confirmed rows", async () => {
    const f = await fixture();
    await catalog.archiveItem(f.items[2].id);
    const review = await prepare(
      "publish",
      f.items.map((i) => i.id),
    );
    expect(
      review.items.every((item) => item.publicationIssues.length > 0),
    ).toBe(true);
    expect(
      await db.saleListing.count({
        where: { merchandiseItemId: { in: f.items.map((i) => i.id) } },
      }),
    ).toBe(0);
    await expect(bulk.execute({ token: review.token })).rejects.toThrow(
      "Confirm",
    );
    const result = await bulk.execute({
      token: review.token,
      confirmed: true,
      rows: rows(f.items, (i) => ({
        slug: i === 1 ? "" : `listing-${randomUUID()}`,
        sellingPrice: "24.90",
        sellingCurrency: "EUR",
        publicTitle: "Rem stand",
      })),
    });
    expect(result).toMatchObject({ updated: 1, failed: 2 });
    expect(
      await db.saleListing.findUnique({
        where: { merchandiseItemId: f.items[0].id },
      }),
    ).toMatchObject({ sellingPriceAmount: 2490, published: true });
    expect(
      await db.saleListing.findUnique({
        where: { merchandiseItemId: f.items[1].id },
      }),
    ).toBeNull();
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(0);
  });
  it("rejects stale publication review and preserves an intervening price edit", async () => {
    const f = await fixture(1);
    await publication.saveListing({
      merchandiseItemId: f.items[0].id,
      slug: randomUUID(),
      sellingPriceAmount: 2000,
      sellingPriceCurrency: "EUR",
    });
    const review = await prepare("publish", [f.items[0].id]);
    await publication.setSellingPrice({
      merchandiseItemId: f.items[0].id,
      sellingPriceAmount: 3100,
      sellingPriceCurrency: "EUR",
    });
    const result = await bulk.execute({
      token: review.token,
      confirmed: true,
      rows: rows(f.items, () => ({
        slug: randomUUID(),
        sellingPrice: "20.00",
        sellingCurrency: "EUR",
      })),
    });
    expect(result.results[0].reason).toContain("changed");
    expect(
      await db.saleListing.findUnique({
        where: { merchandiseItemId: f.items[0].id },
      }),
    ).toMatchObject({ sellingPriceAmount: 3100, published: false });
  });
  it("archives with confirmation while retaining stock, watches and immutable history", async () => {
    const f = await fixture(1);
    const receipt = await prepare("receive", [f.items[0].id]);
    await bulk.execute({
      token: receipt.token,
      defaults: { destinationLocationId: f.source.id },
      rows: rows(f.items, () => ({ quantity: 4 })),
    });
    const listing = await publication.saveListing({
      merchandiseItemId: f.items[0].id,
      slug: randomUUID(),
      sellingPriceAmount: 1000,
      sellingPriceCurrency: "JPY",
    });
    await publication.setPublished({
      merchandiseItemId: f.items[0].id,
      published: true,
    });
    await catalog.savePurchaseWatch({ merchandiseItemId: f.items[0].id });
    const review = await prepare("archive", [f.items[0].id]);
    await expect(bulk.execute({ token: review.token })).rejects.toThrow(
      "Confirm",
    );
    expect(
      (await bulk.execute({ token: review.token, confirmed: true })).updated,
    ).toBe(1);
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(4);
    expect(
      await db.inventoryMovement.count({
        where: { merchandiseItemId: f.items[0].id },
      }),
    ).toBe(1);
    expect(await getPublicListing(db, listing.slug)).toBeNull();
    expect(
      await db.purchaseWatch.findUnique({
        where: { merchandiseItemId: f.items[0].id },
      }),
    ).toMatchObject({ enabled: true });
  });
  it("sets category, price and featured status and unpublishes through services", async () => {
    const f = await fixture(2);
    const listing = await publication.saveListing({
      merchandiseItemId: f.items[0].id,
      slug: randomUUID(),
      sellingPriceAmount: 1000,
      sellingPriceCurrency: "JPY",
    });
    await publication.setPublished({
      merchandiseItemId: f.items[0].id,
      published: true,
    });
    for (const action of [
      "price",
      "feature",
      "unfeature",
      "unpublish",
    ] as const) {
      const review = await prepare(
        action,
        f.items.map((i) => i.id),
      );
      expect(
        await bulk.execute({
          token: review.token,
          defaults: { sellingPrice: "25.50", sellingCurrency: "EUR" },
        }),
      ).toMatchObject({ updated: 1, skipped: 1, failed: 0 });
    }
    expect(
      await db.saleListing.findUnique({ where: { id: listing.id } }),
    ).toMatchObject({
      sellingPriceAmount: 2550,
      sellingPriceCurrency: "EUR",
      featured: false,
      published: false,
    });
    const category = await catalog.createCategory({
      name: "Badge",
      slug: randomUUID(),
    });
    const review = await prepare(
      "category",
      f.items.map((i) => i.id),
    );
    expect(
      (
        await bulk.execute({
          token: review.token,
          defaults: { categoryId: category.id },
        })
      ).updated,
    ).toBe(2);
    expect(
      await db.merchandiseItem.count({
        where: { lineupId: f.lineup.id, categoryId: category.id },
      }),
    ).toBe(2);
  });
  it("reports partial validation failures with reasons without discarding valid rows", async () => {
    const f = await fixture();
    const review = await prepare(
      "watch",
      f.items.map((i) => i.id),
    );
    const result = await bulk.execute({
      token: review.token,
      rows: rows(f.items, (i) =>
        i === 0
          ? { targetQuantity: -1 }
          : i === 1
            ? { skip: true }
            : { targetQuantity: 2 },
      ),
    });
    expect(result).toMatchObject({ updated: 1, skipped: 1, failed: 1 });
    expect(
      result.results.every((r) => r.status === "updated" || Boolean(r.reason)),
    ).toBe(true);
    expect(
      await db.purchaseWatch.findUnique({
        where: { merchandiseItemId: f.items[0].id },
      }),
    ).toBeNull();
  });
  it("exports the fixed selection in catalog CSV format with safe cells and no stock", async () => {
    const f = await fixture(1);
    await db.merchandiseItem.update({
      where: { id: f.items[0].id },
      data: { name: '=HYPERLINK("https://example.test")' },
    });
    const review = await prepare("export", [f.items[0].id]);
    const result = await bulk.execute({ token: review.token });
    expect(result.csv).toContain("release_date_precision");
    expect(result.csv).toContain("official_msrp_amount");
    expect(result.csv).not.toContain('"Owned"');
    expect(result.csv).toContain("'=HYPERLINK");
    expect(result.csv).not.toContain("November 1,");
  });
  it("checks internal authorization, snapshot integrity, actor binding and row membership", async () => {
    const f = await fixture(1);
    const review = await prepare("watch", [f.items[0].id]);
    await expect(
      bulk.execute({ token: review.token + "tampered" }),
    ).rejects.toThrow("Selection");
    await expect(
      bulk.execute({
        token: review.token,
        rows: [{ id: randomUUID(), values: {} }],
      }),
    ).rejects.toThrow("belong");
    const outsider = createBulkManagementService(
      db,
      async () => ({ id: randomUUID() }),
      secret,
    );
    await expect(
      outsider.prepare({
        action: "watch",
        filters: {},
        selection: { mode: "explicit", ids: [f.items[0].id] },
      }),
    ).rejects.toThrow("internal");
    await expect(outsider.execute({ token: review.token })).rejects.toThrow(
      "internal",
    );
    const otherUser = await db.user.create({
      data: {
        id: randomUUID(),
        name: "Other",
        email: `${randomUUID()}@example.test`,
        isInternal: true,
      },
    });
    const other = createBulkManagementService(
      db,
      () => assertInternalAccount(db, otherUser.id),
      secret,
    );
    await expect(other.execute({ token: review.token })).rejects.toThrow(
      "Selection",
    );
  });
});
