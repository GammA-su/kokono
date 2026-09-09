import { makePublicationReady } from "./publication-fixture";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { createWatchlistQueries } from "../src/modules/watchlist/queries";
import { createWatchlistCommands } from "../src/modules/watchlist/commands";
import {
  marketplaceSearchLinks,
  sourcingQuery,
} from "../src/modules/watchlist/marketplaces";
import { quantityNeeded } from "../src/modules/watchlist/filters";
import { applyInventoryOperation } from "../src/modules/inventory/operations";
import { createPublicationService } from "../src/modules/publication/service";
import { getPublicListing } from "../src/modules/publication/queries";
import { formatPartialDate } from "../src/modules/catalog/partial-date";

const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = async () => ({ id: actorId });
const catalog = createCatalogService(db, authorize),
  locations = createLocationService(db, authorize);
const queries = createWatchlistQueries(db, authorize),
  commands = createWatchlistCommands(db, authorize);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        name: "Sourcing operator",
        email: `${randomUUID()}@example.test`,
        isInternal: true,
      },
    })
  ).id;
});
afterAll(() => db.$disconnect());
async function fixture(count = 1) {
  const key = randomUUID();
  const franchise = await catalog.createFranchise({
    name: "Re:Zero",
    slug: key,
  });
  const lineup = await catalog.createLineup({
    name: "Marine 2026",
    slug: key,
    franchiseId: franchise.id,
    releaseDate: "2026-11",
  });
  const category = await catalog.createCategory({ name: "Stand", slug: key });
  const character = await catalog.createCharacter({
    name: "Rem",
    japaneseName: "レム",
    franchiseId: franchise.id,
  });
  const items = [];
  for (let n = 0; n < count; n++) {
    const item = await catalog.createItem({
      name: `Stand ${String(n).padStart(2, "0")}`,
      japaneseName: `レム アクリルスタンド ${n}`,
      internalSku: `${key}-${n}`,
      slug: `${key}-${n}`,
      lineupId: lineup.id,
      categoryId: category.id,
      characterIds: [character.id],
      officialMsrpAmount: 1000 + n,
      officialMsrpCurrency: "JPY",
    });
    await catalog.savePurchaseWatch({
      merchandiseItemId: item.id,
      targetQuantity: 5,
      maxUnitPriceAmount: 900 + n,
    });
    items.push(item);
  }
  const list = (filters: Record<string, unknown> = {}) =>
    queries.list({ franchise: franchise.id, ...filters });
  const stock = (itemId: string, locationId: string, quantity: number) =>
    applyInventoryOperation(
      db,
      {
        merchandiseItemId: itemId,
        destinationLocationId: locationId,
        quantityDelta: quantity,
        movementType: "PURCHASE",
        operationKey: randomUUID(),
      },
      actorId,
    );
  return { franchise, lineup, category, character, items, list, stock };
}
describe("private sourcing workflow", () => {
  it("shows zero-stock watches, target gaps and precise release dates", async () => {
    const { items, list } = await fixture();
    const result = await list();
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: items[0].id,
      quantityNeeded: 5,
      japanOwned: 0,
      franceOwned: 0,
      stock: { total: 0, fulfillable: 0 },
    });
    expect(
      formatPartialDate(
        result.items[0].release.date,
        result.items[0].release.precision,
      ),
    ).toBe("November 2026");
    expect(quantityNeeded(5, 2)).toBe(3);
    expect(quantityNeeded(5, 10)).toBe(0);
    expect(quantityNeeded(null, 0)).toBeNull();
  });
  it("counts physical country ancestry without guessing codes or conflating fulfillment", async () => {
    const { items, list, stock } = await fixture();
    const jp = await locations.create({
      code: randomUUID(),
      name: "Depot",
      type: "WAREHOUSE",
      countryCode: "JP",
    });
    const fr = await locations.create({
      code: randomUUID(),
      name: "Home",
      type: "OTHER",
      countryCode: "FR",
      active: false,
    });
    const box = await locations.create({
      code: randomUUID(),
      name: "Box",
      type: "BOX",
      parentId: jp.id,
    });
    const transit = await locations.create({
      code: randomUUID(),
      name: "Transit",
      type: "IN_TRANSIT",
      parentId: jp.id,
    });
    const transitBox = await locations.create({
      code: randomUUID(),
      name: "Transit box",
      type: "BOX",
      countryCode: "FR",
      parentId: transit.id,
    });
    const unknown = await locations.create({
      code: `JP-FR-${randomUUID()}`,
      name: "France Japan",
      type: "OTHER",
      fulfillmentEnabled: true,
    });
    // Inactive stock is still physically owned: receive before deactivating the hierarchy.
    await locations.update({
      id: fr.id,
      updatedAt: fr.updatedAt.toISOString(),
      values: {
        code: fr.code,
        name: fr.name,
        type: fr.type,
        countryCode: "FR",
        active: true,
      },
    });
    await stock(items[0].id, box.id, 2);
    await stock(items[0].id, fr.id, 3);
    await stock(items[0].id, transitBox.id, 4);
    await stock(items[0].id, unknown.id, 1);
    const current = await db.storageLocation.findUniqueOrThrow({
      where: { id: fr.id },
    });
    await locations.update({
      id: fr.id,
      updatedAt: current.updatedAt.toISOString(),
      values: {
        code: fr.code,
        name: fr.name,
        type: fr.type,
        countryCode: "FR",
        active: false,
      },
    });
    expect((await list()).items[0]).toMatchObject({
      quantityNeeded: 0,
      japanOwned: 2,
      franceOwned: 3,
      stock: { total: 10, fulfillable: 1 },
    });
    expect((await list({ country: "JP" })).total).toBe(1);
    expect((await list({ country: "FR" })).total).toBe(1);
    expect((await list({ below: "yes" })).total).toBe(0);
  });
  it("filters franchise, lineup, character, category, priority, year, stock and gap", async () => {
    const { items, lineup, character, category, list, stock } =
      await fixture(3);
    const jp = await locations.create({
      code: randomUUID(),
      name: "Japan",
      type: "JAPAN_WAREHOUSE",
    });
    await stock(items[1].id, jp.id, 2);
    await stock(items[2].id, jp.id, 7);
    await commands.execute({
      action: "priority",
      merchandiseItemId: items[1].id,
      priority: "URGENT",
    });
    expect(
      (
        await list({
          lineup: lineup.id,
          character: character.id,
          category: category.id,
          year: 2026,
          priority: "URGENT",
          stock: "has",
          below: "yes",
          country: "JP",
        })
      ).items.map((row) => row.id),
    ).toEqual([items[1].id]);
    expect((await list({ stock: "none" })).items.map((row) => row.id)).toEqual([
      items[0].id,
    ]);
    expect(
      (await list({ below: "yes", sort: "gap" })).items.map(
        (row) => row.quantityNeeded,
      ),
    ).toEqual([5, 3]);
    for (const filters of [
      { franchise: randomUUID() },
      { lineup: randomUUID() },
      { character: randomUUID() },
      { category: randomUUID() },
      { year: 2025 },
      { country: "FR" },
    ])
      expect((await list(filters)).total).toBe(0);
  });
  it("updates priority atomically without resetting private sourcing fields or checked time", async () => {
    const { items } = await fixture();
    const id = items[0].id;
    await catalog.savePurchaseWatch({
      merchandiseItemId: id,
      conditionPreference: "Sealed",
      marketplaceSearchQuery: "レム マリン",
      notes: "PRIVATE_NOTES",
      targetQuantity: 12,
      maxUnitPriceAmount: 1234,
    });
    await commands.execute({ action: "checked", merchandiseItemId: id });
    const checked = await db.purchaseWatch.findUniqueOrThrow({
      where: { merchandiseItemId: id },
    });
    for (const priority of ["LOW", "NORMAL", "HIGH", "URGENT"])
      await commands.execute({
        action: "priority",
        merchandiseItemId: id,
        priority,
      });
    expect(
      await db.purchaseWatch.findUniqueOrThrow({
        where: { merchandiseItemId: id },
      }),
    ).toMatchObject({
      priority: "URGENT",
      targetQuantity: 12,
      maxUnitPriceAmount: 1234,
      conditionPreference: "Sealed",
      marketplaceSearchQuery: "レム マリン",
      notes: "PRIVATE_NOTES",
      lastCheckedAt: checked.lastCheckedAt,
    });
  });
  it("saves price/target/condition/query and disables without touching inventory or listing", async () => {
    const { items, list, stock } = await fixture();
    const id = items[0].id;
    const fr = await locations.create({
      code: randomUUID(),
      name: "FR",
      type: "FRANCE_HOME",
      fulfillmentEnabled: true,
    });
    await stock(id, fr.id, 2);
    const publication = createPublicationService(db, authorize);
    const listing = await publication.saveListing({
      merchandiseItemId: id,
      slug: randomUUID(),
      sellingPriceAmount: 2500,
      sellingPriceCurrency: "EUR",
    });
    await commands.execute({
      action: "save",
      merchandiseItemId: id,
      enabled: true,
      priority: "HIGH",
      targetQuantity: "6",
      maxPrice: "12.50",
      currency: "EUR",
      condition: "Boxed",
      query: "レム & マリン",
    });
    expect((await list()).items[0]).toMatchObject({
      quantityNeeded: 4,
      purchaseWatch: {
        maxUnitPriceAmount: 1250,
        maxUnitPriceCurrency: "EUR",
        conditionPreference: "Boxed",
        marketplaceSearchQuery: "レム & マリン",
      },
    });
    await commands.execute({ action: "disable", merchandiseItemId: id });
    expect((await list()).total).toBe(0);
    expect(
      await db.inventoryMovement.count({ where: { merchandiseItemId: id } }),
    ).toBe(1);
    expect(
      await db.saleListing.findUnique({ where: { id: listing.id } }),
    ).toEqual(listing);
    expect(
      await db.purchaseWatch.count({ where: { merchandiseItemId: id } }),
    ).toBe(1);
    await commands.execute({
      action: "save",
      merchandiseItemId: id,
      enabled: true,
      priority: "NORMAL",
      targetQuantity: "",
      maxPrice: "",
      currency: "JPY",
      condition: "",
      query: "",
    });
    expect((await list()).items[0].quantityNeeded).toBeNull();
  });
  it("filters age including never checked, marks checked explicitly and sorts oldest first", async () => {
    const { items, list } = await fixture(3);
    await db.purchaseWatch.update({
      where: { merchandiseItemId: items[1].id },
      data: { lastCheckedAt: new Date(Date.now() - 40 * 86400000) },
    });
    await commands.execute({
      action: "checked",
      merchandiseItemId: items[2].id,
    });
    expect(
      (await list({ checked: "never" })).items.map((row) => row.id),
    ).toEqual([items[0].id]);
    expect(
      (await list({ checked: "30", sort: "checked" })).items.map(
        (row) => row.id,
      ),
    ).toEqual([items[0].id, items[1].id]);
    expect((await list({ checked: "90" })).total).toBe(1);
    expect(
      (await list({ sort: "checked" })).items.map((row) => row.id),
    ).toEqual(items.map((row) => row.id));
    await commands.execute({
      action: "checked",
      merchandiseItemId: items[0].id,
    });
    expect((await list({ checked: "never" })).total).toBe(0);
  });
  it("sorts by watch creation, release, priority and currency-aware prices", async () => {
    const { items, list } = await fixture(3);
    await catalog.savePurchaseWatch({
      merchandiseItemId: items[0].id,
      priority: "URGENT",
      maxUnitPriceAmount: 1500,
    });
    await db.merchandiseItem.update({
      where: { id: items[1].id },
      data: {
        releaseDate: new Date("2027-01-01T00:00:00Z"),
        releaseDatePrecision: "YEAR",
      },
    });
    expect((await list({ sort: "priority" })).items[0].id).toBe(items[0].id);
    expect((await list({ sort: "watch-added" })).items[0].id).toBe(items[2].id);
    expect((await list({ sort: "release-desc" })).items[0].id).toBe(
      items[1].id,
    );
    expect((await list({ sort: "msrp" })).items.map((row) => row.id)).toEqual(
      items.map((row) => row.id),
    );
    expect(
      (await list({ sort: "max-price" })).items.map((row) => row.id),
    ).toEqual([items[1].id, items[2].id, items[0].id]);
  });
  it("paginates/filter-sorts on the server and clamps out-of-range pages", async () => {
    const { list } = await fixture(26);
    const first = await list({ sort: "gap", below: "yes", size: 24 });
    const last = await list({ sort: "gap", below: "yes", size: 24, page: 999 });
    expect(first.items).toHaveLength(24);
    expect(first.total).toBe(26);
    expect(last.items).toHaveLength(2);
    expect(last.filters.page).toBe(2);
    expect(
      new Set([...first.items, ...last.items].map((row) => row.id)).size,
    ).toBe(26);
  });
  it("blocks unauthorized queries and every mutation and never exposes watch data publicly", async () => {
    const { items } = await fixture();
    const id = items[0].id;
    const outsider = await db.user.create({
      data: {
        id: randomUUID(),
        name: "Customer",
        email: `${randomUUID()}@example.test`,
        isInternal: false,
      },
    });
    const denied = async () => ({ id: outsider.id });
    await expect(createWatchlistQueries(db, denied).list()).rejects.toThrow();
    for (const action of ["checked", "disable", "priority"])
      await expect(
        createWatchlistCommands(db, denied).execute({
          action,
          merchandiseItemId: id,
          ...(action === "priority" ? { priority: "HIGH" } : {}),
        }),
      ).rejects.toThrow();
    await expect(
      createWatchlistCommands(db, denied).execute({
        action: "save",
        merchandiseItemId: id,
        enabled: true,
        priority: "HIGH",
        targetQuantity: "1",
        maxPrice: "",
        currency: "JPY",
        query: "SECRET_QUERY",
        condition: "SECRET_CONDITION",
      }),
    ).rejects.toThrow();
    await catalog.savePurchaseWatch({
      merchandiseItemId: id,
      marketplaceSearchQuery: "SECRET_QUERY",
      conditionPreference: "SECRET_CONDITION",
      notes: "SECRET_NOTES",
    });
    const publication = createPublicationService(db, authorize);
    const listing = await publication.saveListing({
      merchandiseItemId: id,
      slug: randomUUID(),
      sellingPriceAmount: 2500,
      sellingPriceCurrency: "EUR",
    });
    await makePublicationReady(db, id);
    await publication.setPublished({ merchandiseItemId: id, published: true });
    const publicData = JSON.stringify(await getPublicListing(db, listing.slug));
    for (const field of [
      "SECRET",
      "purchaseWatch",
      "targetQuantity",
      "maxUnitPrice",
      "lastChecked",
      "countryCode",
    ])
      expect(publicData).not.toContain(field);
  });
  it("encodes marketplace URLs safely and prefers saved query then exact Japanese name", () => {
    const value = "レム マリン & # /?=＋";
    const links = marketplaceSearchLinks(value);
    expect(links).toHaveLength(6);
    const keys = ["keyword", "p", null, "query", "search_word", "keyword"];
    links.forEach((link, index) => {
      const url = new URL(link.href);
      expect(url.protocol).toBe("https:");
      expect(url.hash).toBe("");
      expect(
        keys[index]
          ? url.searchParams.get(keys[index]!)
          : decodeURIComponent(url.pathname.slice("/search/".length)),
      ).toBe(value);
    });
    expect(new URL(links[2].href).hostname).toBe(
      "paypayfleamarket.yahoo.co.jp",
    );
    expect(marketplaceSearchLinks("   ")).toEqual([]);
    expect(
      sourcingQuery({
        name: "English",
        japaneseName: "日本語",
        purchaseWatch: { marketplaceSearchQuery: " custom " },
      }),
    ).toBe("custom");
    expect(sourcingQuery({ name: "English", japaneseName: "日本語" })).toBe(
      "日本語",
    );
    expect(sourcingQuery({ name: "English", japaneseName: " " })).toBe(
      "English",
    );
  });
  it("rejects stale full-form edits and invalid quantities/prices without losing newer data", async () => {
    const { items } = await fixture();
    const id = items[0].id;
    const old = await db.purchaseWatch.findUniqueOrThrow({
      where: { merchandiseItemId: id },
    });
    await commands.execute({
      action: "priority",
      merchandiseItemId: id,
      priority: "URGENT",
    });
    const input = {
      action: "save",
      merchandiseItemId: id,
      enabled: true,
      priority: "LOW",
      targetQuantity: "5",
      maxPrice: "1000",
      currency: "JPY",
      condition: "",
      query: "",
    };
    await expect(
      commands.execute({ ...input, version: old.updatedAt.toISOString() }),
    ).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
    for (const invalid of [
      { targetQuantity: "0" },
      { targetQuantity: "-1" },
      { targetQuantity: "1.5" },
      { maxPrice: "1.5" },
      { currency: "bad!" },
    ])
      await expect(
        commands.execute({ ...input, ...invalid }),
      ).rejects.toThrow();
    expect(
      (
        await db.purchaseWatch.findUniqueOrThrow({
          where: { merchandiseItemId: id },
        })
      ).priority,
    ).toBe("URGENT");
  });
});
