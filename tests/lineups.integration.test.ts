import { makePublicationReady } from "./publication-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { assertInternalAccount } from "../src/modules/auth/authorization";
import { createLineupService } from "../src/modules/lineups/service";
import {
  createLineupQueries,
  lineupFilterSchema,
} from "../src/modules/lineups/queries";
import { createCatalogService } from "../src/modules/catalog/service";
import { applyInventoryOperation } from "../src/modules/inventory/operations";
import { getPublicListing } from "../src/modules/publication/queries";
import { formatPartialDate } from "../src/modules/catalog/partial-date";
import { partialDateInput } from "../src/modules/lineups/presentation";
import { guardPgQueryConcurrency } from "./pg-query-guard";

guardPgQueryConcurrency();

const db = createDatabaseClient(inject("testDatabaseUrl"));
let userId: string;
const authorize = () => assertInternalAccount(db, userId);
const service = createLineupService(db, authorize);
const queries = createLineupQueries(db, authorize);
const catalog = createCatalogService(db, authorize);
beforeAll(async () => {
  const user = await db.user.create({
    data: {
      id: randomUUID(),
      name: "Lineup tester",
      email: `${randomUUID()}@example.test`,
      isInternal: true,
    },
  });
  userId = user.id;
});
afterAll(async () => {
  await db.$disconnect();
});

async function franchise() {
  return catalog.createFranchise({
    name: `Franchise ${randomUUID()}`,
    slug: randomUUID(),
  });
}
function source(url = "https://example.com/official") {
  return {
    provider: "Official manufacturer",
    sourceType: "MANUFACTURER",
    url,
    checkedDate: "2026-09-07",
    notes: "Checked against official announcement",
  };
}
function input(franchiseId: string, overrides: Record<string, unknown> = {}) {
  return {
    franchiseId,
    name: "Marine Ver. 2026",
    japaneseName: "マリン Ver. 2026",
    manufacturer: "KADOKAWA",
    releaseDate: "2026-11",
    announcedDate: "2026",
    status: "PREORDER",
    sources: [source()],
    ...overrides,
  };
}
async function item(lineupId: string) {
  const category = await catalog.createCategory({
    name: "Stand",
    slug: randomUUID(),
  });
  return catalog.createItem({
    lineupId,
    categoryId: category.id,
    internalSku: randomUUID(),
    slug: randomUUID(),
    name: "Rem Acrylic Stand",
  });
}

describe("lineup forms and source management", () => {
  it("creates multiple source links and preserves exact date precision", async () => {
    const f = await franchise();
    const lineup = await service.save(
      input(f.id, { sources: [source(), source("https://example.com/store")] }),
    );
    const detail = await queries.detail(lineup.id);
    expect(detail?.sources).toHaveLength(2);
    expect(
      formatPartialDate(detail!.releaseDate, detail!.releaseDatePrecision),
    ).toBe("November 2026");
    expect(
      formatPartialDate(detail!.announcedDate, detail!.announcedDatePrecision),
    ).toBe("2026");
    expect(detail?.counts).toEqual({
      catalogued: 0,
      owned: 0,
      published: 0,
      watched: 0,
      characters: 0,
      stock: 0,
    });
  });
  it("edits a lineup, clears dates, and replaces source links atomically", async () => {
    const f = await franchise();
    const lineup = await service.save(input(f.id));
    const saved = await service.save(
      input(f.id, {
        name: "Updated release",
        releaseDate: null,
        announcedDate: null,
        sources: [source("https://example.com/revised")],
      }),
      { id: lineup.id, updatedAt: lineup.updatedAt.toISOString() },
    );
    expect(saved.slug).toBe(lineup.slug);
    const detail = await queries.detail(lineup.id);
    expect(detail?.releaseDate).toBeNull();
    expect(detail?.releaseDatePrecision).toBeNull();
    expect(detail?.sources.map((s) => s.url)).toEqual([
      "https://example.com/revised",
    ]);
  });
  it("rejects stale edits without overwriting new metadata or sources", async () => {
    const f = await franchise();
    const lineup = await service.save(input(f.id));
    await db.lineup.update({
      where: { id: lineup.id },
      data: {
        name: "Another operator",
        updatedAt: new Date(lineup.updatedAt.getTime() + 1000),
      },
    });
    await expect(
      service.save(input(f.id, { sources: [] }), {
        id: lineup.id,
        updatedAt: lineup.updatedAt.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
    expect((await queries.detail(lineup.id))?.name).toBe("Another operator");
    expect((await queries.detail(lineup.id))?.sources).toHaveLength(1);
  });
  it("retains source identities, creation dates and precise checked timestamps during metadata edits", async () => {
    const f = await franchise();
    const lineup = await service.save(input(f.id));
    const original = await db.lineupSource.findFirstOrThrow({
      where: { lineupId: lineup.id },
    });
    const checkedAt = new Date("2026-09-07T14:35:24.000Z");
    await db.lineupSource.update({
      where: { id: original.id },
      data: { checkedAt },
    });
    await service.save(input(f.id, { name: "Renamed release" }), {
      id: lineup.id,
      updatedAt: lineup.updatedAt.toISOString(),
    });
    const stored = await db.lineupSource.findFirstOrThrow({
      where: { lineupId: lineup.id },
    });
    expect(stored.id).toBe(original.id);
    expect(stored.createdAt).toEqual(original.createdAt);
    expect(stored.checkedAt).toEqual(checkedAt);
  });
  it("validates unsafe source URLs, duplicates, invalid dates, and non-image references before writing", async () => {
    const f = await franchise();
    for (const overrides of [
      { sources: [source("javascript:alert(1)")] },
      { sources: [source(), source()] },
      { releaseDate: "2026-02-29" },
      { mainImageStorageKey: "javascript:alert(1)" },
    ]) {
      await expect(service.save(input(f.id, overrides))).rejects.toThrow();
    }
    expect(await db.lineup.count({ where: { franchiseId: f.id } })).toBe(0);
  });
  it("duplicates metadata and sources but no items, stock, watches, listings, or verification dates", async () => {
    const f = await franchise();
    const lineup = await service.save(input(f.id));
    await item(lineup.id);
    const copy = await service.duplicate(lineup.id);
    const detail = await queries.detail(copy.id);
    expect(copy.id).not.toBe(lineup.id);
    expect(copy.slug).not.toBe(lineup.slug);
    expect(copy.name).toContain("(copy)");
    expect(detail?.sources).toHaveLength(1);
    expect(detail?.sources[0].checkedAt).toBeNull();
    expect(detail?.counts.stock).toBe(0);
    expect(detail?.items).toHaveLength(0);
    expect(detail?.counts.watched).toBe(0);
    expect(detail?.counts.published).toBe(0);
  });
  it("requires exact name confirmation and deletes only empty lineups", async () => {
    const f = await franchise();
    const lineup = await service.save(input(f.id));
    await expect(service.remove(lineup.id, "wrong")).rejects.toMatchObject({
      code: "CONFIRM_NAME",
    });
    expect(await service.remove(lineup.id, lineup.name)).toBe("deleted");
    expect(
      await db.lineupSource.count({ where: { lineupId: lineup.id } }),
    ).toBe(0);
    expect(await queries.detail(lineup.id)).toBeNull();
  });
  it("archives populated lineups, preserves inventory/history, hides listings, and supports restore", async () => {
    const f = await franchise();
    const lineup = await service.save(input(f.id));
    const merch = await item(lineup.id);
    const location = await db.storageLocation.create({
      data: {
        code: randomUUID(),
        name: "France",
        type: "FRANCE_HOME",
        fulfillmentEnabled: true,
      },
    });
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: merch.id,
        movementType: "PURCHASE",
        quantityDelta: 5,
        destinationLocationId: location.id,
        operationKey: randomUUID(),
      },
      userId,
    );
    const listing = await db.saleListing.create({
      data: {
        merchandiseItemId: merch.id,
        slug: randomUUID(),
        sellingPriceAmount: 2000,
        sellingPriceCurrency: "EUR",
        published: true,
        publishedAt: new Date(),
      },
    });
    await makePublicationReady(db, merch.id);
    expect(await service.remove(lineup.id, lineup.name)).toBe("archived");
    expect((await queries.detail(lineup.id))?.counts.stock).toBe(5);
    expect(
      await db.inventoryMovement.count({
        where: { merchandiseItemId: merch.id },
      }),
    ).toBe(1);
    expect(await getPublicListing(db, listing.slug)).toBeNull();
    expect((await queries.list({ franchise: f.id })).total).toBe(0);
    expect(
      (await queries.list({ franchise: f.id, archived: "true" })).total,
    ).toBe(1);
    await service.restore(lineup.id);
    expect(await getPublicListing(db, listing.slug)).not.toBeNull();
  });
  it("creates item source records in the same transaction as the catalog item", async () => {
    const f = await franchise();
    const lineup = await service.save(input(f.id));
    const category = await catalog.createCategory({
      name: "Stand",
      slug: randomUUID(),
    });
    const values = {
      lineupId: lineup.id,
      categoryId: category.id,
      internalSku: randomUUID(),
      slug: randomUUID(),
      name: "Item with sources",
    };
    await expect(
      catalog.createItem(values, [source("javascript:bad")]),
    ).rejects.toThrow();
    expect(
      await db.merchandiseItem.findUnique({
        where: { internalSku: values.internalSku },
      }),
    ).toBeNull();
    const merch = await catalog.createItem(values, [
      source(),
      source("https://example.com/retailer"),
    ]);
    expect(
      await db.itemSource.count({ where: { merchandiseItemId: merch.id } }),
    ).toBe(2);
    expect(
      await db.inventoryBalance.count({
        where: { merchandiseItemId: merch.id },
      }),
    ).toBe(0);
  });
  it("edits item sources and rejects wrong-lineup and stale submissions", async () => {
    const f = await franchise();
    const lineup = await service.save(input(f.id));
    const merch = await item(lineup.id);
    await expect(
      service.saveItemSources({
        lineupId: randomUUID(),
        itemId: merch.id,
        updatedAt: merch.updatedAt.toISOString(),
        sources: [source()],
      }),
    ).rejects.toMatchObject({ code: "ITEM_NOT_FOUND" });
    const saved = await service.saveItemSources({
      lineupId: lineup.id,
      itemId: merch.id,
      updatedAt: merch.updatedAt.toISOString(),
      sources: [source(), source("https://example.com/item")],
    });
    expect(
      await db.itemSource.count({ where: { merchandiseItemId: merch.id } }),
    ).toBe(2);
    await expect(
      service.saveItemSources({
        lineupId: lineup.id,
        itemId: merch.id,
        updatedAt: "2000-01-01T00:00:00.000Z",
        sources: [],
      }),
    ).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
    await service.saveItemSources({
      lineupId: lineup.id,
      itemId: merch.id,
      updatedAt: saved.updatedAt.toISOString(),
      sources: [],
    });
    expect(
      await db.itemSource.count({ where: { merchandiseItemId: merch.id } }),
    ).toBe(0);
  });
});

describe("scalable lineup queries", () => {
  it("combines search, franchise, status, year and manufacturer filters", async () => {
    const f = await franchise();
    await service.save(input(f.id));
    await service.save(
      input(f.id, {
        name: "Forest",
        japaneseName: null,
        status: "RELEASED",
        manufacturer: "Other",
        releaseDate: "2025",
      }),
    );
    const result = await queries.list({
      q: "マリン",
      franchise: f.id,
      status: "PREORDER",
      year: "2026",
      manufacturer: "KADOKAWA",
    });
    expect(result.total).toBe(1);
    expect(result.rows[0].name).toBe("Marine Ver. 2026");
    expect((await queries.list({ franchise: f.id, q: "kadokawa" })).total).toBe(
      1,
    );
    expect((await queries.list({ franchise: f.id, year: "2027" })).total).toBe(
      0,
    );
  });
  it("supports all sort orders with unknown dates last and deterministic pagination", async () => {
    const f = await franchise();
    const early = await service.save(
      input(f.id, { name: "Zulu", releaseDate: "2025" }),
    );
    const late = await service.save(
      input(f.id, { name: "Alpha", releaseDate: "2027" }),
    );
    const unknown = await service.save(
      input(f.id, { name: "Middle", releaseDate: null }),
    );
    await db.lineup.update({
      where: { id: unknown.id },
      data: { createdAt: new Date("2030-01-01T00:00:00Z") },
    });
    for (const [sort, ids] of [
      ["newest", [late.id, early.id, unknown.id]],
      ["oldest", [early.id, late.id, unknown.id]],
      ["added", [unknown.id, late.id, early.id]],
      ["alphabetical", [late.id, unknown.id, early.id]],
    ] as const) {
      expect(
        (await queries.list({ franchise: f.id, sort })).rows.map(
          (row) => row.id,
        ),
      ).toEqual(ids);
    }
    await db.lineup.createMany({
      data: Array.from({ length: 52 }, (_, i) => ({
        franchiseId: f.id,
        name: `Other ${i}`,
        slug: randomUUID(),
      })),
    });
    const first = await queries.list({ franchise: f.id, page: 1 });
    const second = await queries.list({ franchise: f.id, page: 2 });
    expect(first.rows).toHaveLength(25);
    expect(second.rows).toHaveLength(25);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(
      50,
    );
    const last = await queries.list({ franchise: f.id, page: 999 });
    expect(last.filters.page).toBe(3);
    expect(last.rows).toHaveLength(5);
    expect(
      (await queries.list({ franchise: f.id, size: 50 })).rows,
    ).toHaveLength(50);
  });
  it("counts owned designs, units, characters, watches and effective publication without join multiplication", async () => {
    const f = await franchise();
    const lineup = await service.save(input(f.id));
    const a = await item(lineup.id);
    await item(lineup.id);
    const rem = await catalog.createCharacter({
      franchiseId: f.id,
      name: "Rem",
    });
    const emilia = await catalog.createCharacter({
      franchiseId: f.id,
      name: "Emilia",
    });
    await db.itemCharacter.createMany({
      data: [rem, emilia].map((character) => ({
        merchandiseItemId: a.id,
        characterId: character.id,
      })),
    });
    for (const quantity of [2, 3]) {
      const location = await db.storageLocation.create({
        data: { code: randomUUID(), name: "Location" },
      });
      await applyInventoryOperation(
        db,
        {
          merchandiseItemId: a.id,
          movementType: "PURCHASE",
          quantityDelta: quantity,
          destinationLocationId: location.id,
          operationKey: randomUUID(),
        },
        userId,
      );
    }
    await db.purchaseWatch.create({ data: { merchandiseItemId: a.id } });
    await db.saleListing.create({
      data: {
        merchandiseItemId: a.id,
        slug: randomUUID(),
        sellingPriceAmount: 100,
        sellingPriceCurrency: "JPY",
        published: true,
        publishedAt: new Date(),
      },
    });
    const expected = {
      catalogued: 2,
      owned: 1,
      published: 1,
      watched: 1,
      characters: 2,
      stock: 5,
    };
    expect((await queries.list({ franchise: f.id })).rows[0].counts).toEqual(
      expected,
    );
    const detail = await queries.detail(lineup.id);
    expect(detail?.counts).toEqual(expected);
    expect(detail?.items.find((row) => row.id === a.id)?.locationCount).toBe(2);
    await catalog.archiveItem(a.id);
    expect((await queries.detail(lineup.id))?.counts).toEqual({
      ...expected,
      published: 0,
    });
  });
  it("paginates detail items while retaining totals for the full lineup", async () => {
    const f = await franchise();
    const lineup = await service.save(input(f.id));
    const first = await item(lineup.id);
    await db.merchandiseItem.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        lineupId: lineup.id,
        categoryId: first.categoryId,
        name: `Item ${i}`,
        internalSku: randomUUID(),
        slug: randomUUID(),
      })),
    });
    const detail = await queries.detail(lineup.id, { page: 2 });
    expect(detail?.items).toHaveLength(6);
    expect(detail?.counts.catalogued).toBe(31);
  });
  it("normalizes malformed URL filters and denies unauthenticated reads and writes", async () => {
    expect(
      lineupFilterSchema.parse({
        page: "bad",
        size: 999,
        status: "invalid",
        franchise: "bad",
        q: ["bad"],
      }),
    ).toMatchObject({
      page: 1,
      size: 25,
      q: "",
      status: undefined,
      franchise: undefined,
    });
    const denied = () => assertInternalAccount(db, undefined);
    await expect(
      createLineupQueries(db, denied).list({}),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      createLineupService(db, denied).save({}),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      createLineupService(db, denied).duplicate(randomUUID()),
    ).rejects.toThrow();
    expect(await queries.detail("not-a-uuid")).toBeNull();
  });
  it("round-trips all supported date input precisions", () => {
    expect(partialDateInput(new Date("2026-11-01T00:00:00Z"), "MONTH")).toBe(
      "2026-11",
    );
    expect(partialDateInput(new Date("2026-01-01T00:00:00Z"), "YEAR")).toBe(
      "2026",
    );
    expect(partialDateInput(new Date("2026-11-14T00:00:00Z"), "DAY")).toBe(
      "2026-11-14",
    );
  });
});
