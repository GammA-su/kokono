import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { assertInternalAccount } from "../src/modules/auth/authorization";
import { createCatalogQueries } from "../src/modules/catalog/queries";
import { createBulkEntryService } from "../src/modules/catalog/bulk-entry";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLineupService } from "../src/modules/lineups/service";
import { applyInventoryOperation } from "../src/modules/inventory/operations";
import { formatPartialDate } from "../src/modules/catalog/partial-date";
import { formatMoney } from "../src/modules/shared/money";
import {
  catalogStatuses,
  stockBucketLabel,
} from "../src/modules/catalog/presentation";
import { guardPgQueryConcurrency } from "./pg-query-guard";

guardPgQueryConcurrency();

const db = createDatabaseClient(inject("testDatabaseUrl"));
let userId: string;
const authorize = () => assertInternalAccount(db, userId);
const catalog = createCatalogService(db, authorize);
const lineups = createLineupService(db, authorize);
const bulk = createBulkEntryService(db, authorize);
const queries = createCatalogQueries(db, authorize);

/** One franchise per scenario keeps assertions independent of the rest of the catalog. */
async function workspace() {
  const franchise = await catalog.createFranchise({
    name: `Re:Zero ${randomUUID()}`,
    japaneseName: "リゼロ",
    slug: randomUUID(),
  });
  const lineup = await lineups.save({
    franchiseId: franchise.id,
    name: "Marine Ver. 2026",
    japaneseName: "マリン Ver. 2026",
    manufacturer: "KADOKAWA",
    releaseDate: "2026-11",
    status: "PREORDER",
    sources: [],
  });
  const category = await catalog.createCategory({
    name: "Acrylic stand",
    slug: randomUUID(),
  });
  const characters: Record<string, { id: string; name: string }> = {};
  for (const [name, japaneseName] of [
    ["Rem", "レム"],
    ["Ram", "ラム"],
    ["Emilia", "エミリア"],
  ])
    characters[name] = await catalog.createCharacter({
      franchiseId: franchise.id,
      name,
      japaneseName,
    });
  return { franchise, lineup, category, characters };
}
async function location(
  type: "JAPAN_WAREHOUSE" | "FRANCE_HOME" | "IN_TRANSIT",
  prefix: string,
  fulfillmentEnabled = false,
) {
  return db.storageLocation.create({
    data: {
      code: `${prefix}-${randomUUID()}`,
      name: `${prefix} location`,
      type,
      fulfillmentEnabled,
    },
  });
}
async function stock(itemId: string, locationId: string, quantity: number) {
  return applyInventoryOperation(
    db,
    {
      merchandiseItemId: itemId,
      movementType: "PURCHASE",
      quantityDelta: quantity,
      destinationLocationId: locationId,
      operationKey: randomUUID(),
    },
    userId,
  );
}
function row(categoryId: string, overrides: Record<string, unknown> = {}) {
  return { name: "Rem Acrylic Stand", categoryId, ...overrides };
}

beforeAll(async () => {
  const user = await db.user.create({
    data: {
      id: randomUUID(),
      name: "Catalog tester",
      email: `${randomUUID()}@example.test`,
      isInternal: true,
    },
  });
  userId = user.id;
});
afterAll(async () => {
  await db.$disconnect();
});

describe("visual merchandise catalog", () => {
  it("lists catalog-only merchandise that is not owned, watched or published", async () => {
    const { franchise, lineup, category, characters } = await workspace();
    await bulk.save({
      acknowledgeDuplicates: true,
      lineupId: lineup.id,
      rows: [
        row(category.id, {
          name: "Rem Acrylic Stand",
          japaneseName: "レム アクリルスタンド",
          characterIds: [characters.Rem.id],
          officialMsrpAmount: "1650",
          releaseDate: "2026-11",
        }),
      ],
    });
    const result = await queries.list({ franchise: franchise.id });
    expect(result.total).toBe(1);
    const [item] = result.items;
    expect(item.statuses).toEqual(["CATALOG_ONLY"]);
    expect(item.stock).toMatchObject({ total: 0, fulfillable: 0, buckets: [] });
    expect(item.purchaseWatch).toBeNull();
    expect(item.saleListing).toBeNull();
    expect(item.lineup.franchise.name).toBe(franchise.name);
    expect(item.category.name).toBe("Acrylic stand");
    expect(item.characters.map((character) => character.name)).toEqual(["Rem"]);
    expect(
      formatMoney(item.officialMsrpAmount!, item.officialMsrpCurrency!),
    ).toBe("¥1,650");
  });

  it("filters by franchise, lineup, category, character, manufacturer, JAN and sources", async () => {
    const { franchise, lineup, category, characters } = await workspace();
    const other = await catalog.createCategory({
      name: "Clear file",
      slug: randomUUID(),
    });
    await bulk.save({
      acknowledgeDuplicates: true,
      lineupId: lineup.id,
      rows: [
        row(category.id, {
          name: "Rem Acrylic Stand",
          characterIds: [characters.Rem.id],
          janCode: "4970381777777",
          manufacturer: "KADOKAWA",
          source: {
            provider: "KADOKAWA",
            sourceType: "MANUFACTURER",
            url: "https://example.com/official",
          },
        }),
        row(other.id, {
          name: "Ram and Emilia Clear File",
          characterIds: [characters.Ram.id, characters.Emilia.id],
          manufacturer: "Other maker",
        }),
      ],
    });
    const scoped = { franchise: franchise.id };
    const names = async (filters: Record<string, unknown>) =>
      (await queries.list({ ...scoped, ...filters })).items.map(
        (item) => item.name,
      );
    expect(await names({})).toHaveLength(2);
    expect(await names({ lineup: lineup.id })).toHaveLength(2);
    expect(await names({ lineup: randomUUID() })).toEqual([]);
    expect(await names({ category: other.id })).toEqual([
      "Ram and Emilia Clear File",
    ]);
    expect(await names({ character: characters.Emilia.id })).toEqual([
      "Ram and Emilia Clear File",
    ]);
    expect(await names({ manufacturer: "KADOKAWA" })).toEqual([
      "Rem Acrylic Stand",
    ]);
    expect(await names({ jan: "has" })).toEqual(["Rem Acrylic Stand"]);
    expect(await names({ jan: "none" })).toEqual(["Ram and Emilia Clear File"]);
    expect(await names({ source: "official" })).toEqual(["Rem Acrylic Stand"]);
    expect(await names({ source: "none" })).toEqual([
      "Ram and Emilia Clear File",
    ]);
    expect(await names({ status: "PREORDER" })).toHaveLength(2);
    expect(await names({ status: "RELEASED" })).toEqual([]);
  });

  it("searches Japanese names, characters, lineups, SKU and JAN without loading the catalog", async () => {
    const { franchise, lineup, category, characters } = await workspace();
    const saved = await bulk.save({
      acknowledgeDuplicates: true,
      lineupId: lineup.id,
      rows: [
        row(category.id, {
          name: "Rem Acrylic Stand",
          japaneseName: "レム アクリルスタンド",
          characterIds: [characters.Rem.id],
          janCode: "4970381999999",
        }),
        row(category.id, {
          name: "Ram Acrylic Stand",
          japaneseName: "ラム アクリルスタンド",
          characterIds: [characters.Ram.id],
        }),
      ],
    });
    const scoped = { franchise: franchise.id };
    const names = async (q: string) =>
      (await queries.list({ ...scoped, q })).items.map((item) => item.name);
    expect(await names("レム")).toEqual(["Rem Acrylic Stand"]);
    expect(await names("アクリル")).toHaveLength(2);
    expect(await names("ラム")).toEqual(["Ram Acrylic Stand"]);
    // Character records are searched through the join, not by loading items client-side.
    expect(await names("エミリア")).toEqual([]);
    expect(await names("マリン")).toHaveLength(2);
    expect(await names("リゼロ")).toHaveLength(2);
    expect(await names("4970381999999")).toEqual(["Rem Acrylic Stand"]);
    expect(await names(saved.created[0].internalSku)).toEqual([
      "Rem Acrylic Stand",
    ]);
    // Full-width input is normalized, and LIKE wildcards are treated literally.
    expect(await names("ＲＥＭ")).toEqual(["Rem Acrylic Stand"]);
    expect(await names("%")).toEqual([]);
    expect(await names("no such merchandise")).toEqual([]);
  });

  it("finds merchandise by any of its characters", async () => {
    const { franchise, lineup, category, characters } = await workspace();
    await bulk.save({
      acknowledgeDuplicates: true,
      lineupId: lineup.id,
      rows: [
        row(category.id, {
          name: "Witch Cult Group Poster",
          characterIds: [
            characters.Rem.id,
            characters.Ram.id,
            characters.Emilia.id,
          ],
        }),
      ],
    });
    const scoped = { franchise: franchise.id };
    for (const query of ["Rem", "Ram", "Emilia", "レム", "エミリア"])
      expect(
        (await queries.list({ ...scoped, q: query })).items.map((i) => i.name),
      ).toEqual(["Witch Cult Group Poster"]);
    for (const character of Object.values(characters))
      expect(
        (await queries.list({ ...scoped, character: character.id })).total,
      ).toBe(1);
  });

  it("keeps release precision and never answers a month filter with a year-only date", async () => {
    const { franchise, lineup, category } = await workspace();
    await bulk.save({
      acknowledgeDuplicates: true,
      lineupId: lineup.id,
      rows: [
        row(category.id, { name: "Year only", releaseDate: "2026" }),
        row(category.id, { name: "Month only", releaseDate: "2026-11" }),
        row(category.id, { name: "Exact day", releaseDate: "2026-11-14" }),
        row(category.id, { name: "Inherits lineup", releaseDate: "" }),
      ],
    });
    const scoped = { franchise: franchise.id, sort: "alphabetical" as const };
    const { items } = await queries.list(scoped);
    expect(
      items.map((item) => [
        item.name,
        formatPartialDate(item.release.date, item.release.precision),
        item.release.inherited,
      ]),
    ).toEqual([
      ["Exact day", "14 November 2026", false],
      ["Inherits lineup", "November 2026", true],
      ["Month only", "November 2026", false],
      ["Year only", "2026", false],
    ]);
    expect((await queries.list({ ...scoped, year: 2026 })).total).toBe(4);
    expect((await queries.list({ ...scoped, year: 2025 })).total).toBe(0);
    const november = await queries.list({ ...scoped, year: 2026, month: 11 });
    expect(november.items.map((item) => item.name)).toEqual([
      "Exact day",
      "Inherits lineup",
      "Month only",
    ]);
    // 2026 is stored on 1 January as an anchor; January must not claim it either.
    expect((await queries.list({ ...scoped, month: 1 })).total).toBe(0);
  });

  it("summarizes owned stock by location and separates fulfillable units", async () => {
    const { franchise, lineup, category } = await workspace();
    const saved = await bulk.save({
      acknowledgeDuplicates: true,
      lineupId: lineup.id,
      rows: [
        row(category.id, { name: "Owned everywhere" }),
        row(category.id, { name: "Catalog only" }),
      ],
    });
    const [owned] = saved.created;
    const france = await location("FRANCE_HOME", "FR", true);
    const japan = await location("JAPAN_WAREHOUSE", "JP");
    const transit = await location("IN_TRANSIT", "TRANSIT");
    await stock(owned.id, france.id, 3);
    await stock(owned.id, japan.id, 12);
    await stock(owned.id, transit.id, 5);

    const scoped = { franchise: franchise.id };
    const { items } = await queries.list({ ...scoped, sort: "stock" });
    const [first, second] = items;
    expect(first.name).toBe("Owned everywhere");
    expect(first.stock.total).toBe(20);
    expect(first.stock.fulfillable).toBe(3);
    expect(
      first.stock.buckets.map((bucket) => `${bucket.label} ${bucket.quantity}`),
    ).toEqual(["JP 12", "Transit 5", "FR 3"]);
    expect(first.stock.locations.map((row) => row.fulfillable)).toEqual([
      false,
      false,
      true,
    ]);
    expect(first.statuses).toEqual(["IN_STOCK"]);
    expect(second.stock.total).toBe(0);

    expect((await queries.list({ ...scoped, stock: "has" })).total).toBe(1);
    expect((await queries.list({ ...scoped, stock: "none" })).total).toBe(1);
    expect(
      (await queries.list({ ...scoped, stock: "fulfillable" })).items.map(
        (item) => item.name,
      ),
    ).toEqual(["Owned everywhere"]);
    expect(
      (await queries.list({ ...scoped, location: japan.id })).items.map(
        (item) => item.name,
      ),
    ).toEqual(["Owned everywhere"]);
    expect((await queries.list({ ...scoped, location: france.id })).total).toBe(
      1,
    );
    expect(
      (await queries.list({ ...scoped, sort: "fulfillable" })).items[0].name,
    ).toBe("Owned everywhere");
    expect(
      stockBucketLabel({ code: "JP-WAREHOUSE", type: "JAPAN_WAREHOUSE" }),
    ).toBe("JP");
    expect(stockBucketLabel({ code: "JP-WAREHOUSE", type: "IN_TRANSIT" })).toBe(
      "Transit",
    );
  });

  it("reports purchase-watch state and orders by priority", async () => {
    const { franchise, lineup, category } = await workspace();
    const saved = await bulk.save({
      acknowledgeDuplicates: true,
      lineupId: lineup.id,
      rows: [
        row(category.id, {
          name: "Urgent watch",
          watch: {
            enabled: true,
            priority: "URGENT",
            targetQuantity: "5",
            maxUnitPriceAmount: "1000",
            marketplaceSearchQuery: "レム アクリルスタンド",
          },
        }),
        row(category.id, {
          name: "Normal watch",
          watch: { enabled: true, priority: "NORMAL" },
        }),
        row(category.id, {
          name: "Disabled watch",
          watch: { marketplaceSearchQuery: "ラム" },
        }),
        row(category.id, { name: "No watch" }),
      ],
    });
    const scoped = { franchise: franchise.id };
    const byPriority = await queries.list({ ...scoped, sort: "priority" });
    expect(byPriority.items.slice(0, 2).map((item) => item.name)).toEqual([
      "Urgent watch",
      "Normal watch",
    ]);
    expect(byPriority.items[0].statuses).toEqual(["WATCHING", "CATALOG_ONLY"]);
    expect((await queries.list({ ...scoped, watch: "enabled" })).total).toBe(2);
    expect((await queries.list({ ...scoped, watch: "disabled" })).total).toBe(
      2,
    );
    expect(
      (await queries.list({ ...scoped, priority: "URGENT" })).items.map(
        (item) => item.name,
      ),
    ).toEqual(["Urgent watch"]);
    const detail = await queries.detail(saved.created[0].id);
    expect(detail?.purchaseWatch).toMatchObject({
      enabled: true,
      priority: "URGENT",
      targetQuantity: 5,
      maxUnitPriceAmount: 1000,
      maxUnitPriceCurrency: "JPY",
      marketplaceSearchQuery: "レム アクリルスタンド",
    });
  });

  it("distinguishes live listings, out-of-stock listings, drafts and archived records", async () => {
    const { franchise, lineup, category } = await workspace();
    const saved = await bulk.save({
      acknowledgeDuplicates: true,
      lineupId: lineup.id,
      rows: [
        row(category.id, { name: "Live item" }),
        row(category.id, { name: "Published without fulfillable stock" }),
        row(category.id, { name: "Draft listing" }),
        row(category.id, { name: "Archived item" }),
      ],
    });
    const [live, unfulfillable, draft, archived] = saved.created;
    const france = await location("FRANCE_HOME", "FR", true);
    const japan = await location("JAPAN_WAREHOUSE", "JP");
    await stock(live.id, france.id, 2);
    await stock(unfulfillable.id, japan.id, 4);
    for (const [item, published] of [
      [live, true],
      [unfulfillable, true],
      [draft, false],
    ] as const)
      await db.saleListing.create({
        data: {
          merchandiseItemId: item.id,
          slug: randomUUID(),
          sellingPriceAmount: 2500,
          sellingPriceCurrency: "EUR",
          published,
          publishedAt: published ? new Date() : null,
        },
      });
    await catalog.archiveItem(archived.id);

    const scoped = { franchise: franchise.id, archived: "true" as const };
    const statuses = new Map(
      (await queries.list(scoped)).items.map((item) => [
        item.name,
        item.statuses,
      ]),
    );
    expect(statuses.get("Live item")).toEqual(["LIVE", "IN_STOCK"]);
    expect(statuses.get("Published without fulfillable stock")).toEqual([
      "OUT_OF_STOCK",
      "IN_STOCK",
    ]);
    expect(statuses.get("Draft listing")).toEqual(["CATALOG_ONLY"]);
    expect(statuses.get("Archived item")).toEqual(["ARCHIVED"]);
    expect(
      (await queries.list({ ...scoped, listing: "published" })).total,
    ).toBe(2);
    expect(
      (await queries.list({ ...scoped, listing: "unpublished" })).total,
    ).toBe(2);
    // Archived records are hidden by default and can be isolated on request.
    expect((await queries.list({ franchise: franchise.id })).total).toBe(3);
    expect(
      (
        await queries.list({ franchise: franchise.id, archived: "only" })
      ).items.map((item) => item.name),
    ).toEqual(["Archived item"]);
    const detail = await queries.detail(live.id);
    expect(detail?.saleListing).toMatchObject({
      published: true,
      sellingPriceAmount: 2500,
      sellingPriceCurrency: "EUR",
    });
    expect(formatMoney(2500, "EUR")).toBe("€25.00");
    expect(
      catalogStatuses({
        archived: true,
        published: true,
        totalStock: 3,
        fulfillableStock: 3,
        watching: true,
      }),
    ).toEqual(["ARCHIVED", "IN_STOCK", "WATCHING"]);
  });

  it("paginates on the server with stable ordering and clamps out-of-range pages", async () => {
    const { franchise, lineup, category } = await workspace();
    await bulk.save({
      acknowledgeDuplicates: true,
      lineupId: lineup.id,
      rows: Array.from({ length: 30 }, (_, index) =>
        row(category.id, {
          name: `Item ${String(index).padStart(2, "0")}`,
        }),
      ),
    });
    const scoped = {
      franchise: franchise.id,
      sort: "alphabetical" as const,
      size: 24,
    };
    const first = await queries.list(scoped);
    expect(first.total).toBe(30);
    expect(first.items).toHaveLength(24);
    expect(first.pageCount).toBe(2);
    expect(first.items[0].name).toBe("Item 00");
    const second = await queries.list({ ...scoped, page: 2 });
    expect(second.items).toHaveLength(6);
    expect(second.filters.page).toBe(2);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(30);
    const clamped = await queries.list({ ...scoped, page: 500 });
    expect(clamped.filters.page).toBe(2);
    expect(clamped.items).toHaveLength(6);
    expect(clamped.total).toBe(30);
    const empty = await queries.list({
      ...scoped,
      q: "no such merchandise",
      page: 4,
    });
    expect(empty.total).toBe(0);
    expect(empty.items).toEqual([]);
    expect((await queries.list({ ...scoped, size: 96 })).items).toHaveLength(
      30,
    );
  });

  it("groups the detail view into catalog, sourcing, inventory and sale data", async () => {
    const { franchise, lineup, category, characters } = await workspace();
    const saved = await bulk.save({
      acknowledgeDuplicates: true,
      lineupId: lineup.id,
      rows: [
        row(category.id, {
          name: "Rem Acrylic Stand",
          japaneseName: "レム アクリルスタンド",
          characterIds: [characters.Rem.id, characters.Ram.id],
          janCode: "4970381777788",
          officialMsrpAmount: "1650",
          officialMsrpTaxInclusion: "INCLUDED",
          privateNotes: "Second-hand only",
          image: "https://example.com/rem.png",
          source: {
            provider: "KADOKAWA",
            sourceType: "MANUFACTURER",
            url: "https://example.com/official",
          },
          watch: { enabled: true, targetQuantity: "3" },
        }),
      ],
    });
    const [item] = saved.created;
    const japan = await location("JAPAN_WAREHOUSE", "JP");
    const france = await location("FRANCE_HOME", "FR", true);
    await stock(item.id, japan.id, 4);
    await stock(item.id, france.id, 1);
    const detail = await queries.detail(item.id);
    expect(detail).toMatchObject({
      name: "Rem Acrylic Stand",
      japaneseName: "レム アクリルスタンド",
      janCode: "4970381777788",
      privateNotes: "Second-hand only",
      manufacturer: "KADOKAWA",
      movementCount: 2,
    });
    expect(
      detail?.characters.map((character) => character.name).sort(),
    ).toEqual(["Ram", "Rem"]);
    expect(detail?.images[0]).toMatchObject({
      imageRole: "PRIMARY",
      storageKey: "https://example.com/rem.png",
    });
    expect(detail?.sources[0]).toMatchObject({
      provider: "KADOKAWA",
      sourceType: "MANUFACTURER",
    });
    expect(detail?.stock).toMatchObject({ total: 5, fulfillable: 1 });
    expect(detail?.saleListing).toBeNull();
    expect(detail?.lineup.franchise.name).toBe(franchise.name);

    const movements = await queries.movements(item.id, { size: 25 });
    expect(movements?.total).toBe(2);
    expect(movements?.rows.map((row) => row.quantityDelta).sort()).toEqual([
      1, 4,
    ]);
    expect(movements?.rows[0].destinationLocation?.code).toBeDefined();
    expect(movements?.rows[0].actorUser?.name).toBe("Catalog tester");
    expect(await queries.detail("not-a-uuid")).toBeNull();
    expect(await queries.detail(randomUUID())).toBeNull();
    expect(await queries.movements(randomUUID())).toBeNull();
  });

  it("offers filter options and denies every read without an active internal account", async () => {
    const { franchise } = await workspace();
    const facets = await queries.facets({ franchise: franchise.id });
    expect(facets.franchises.some((row) => row.id === franchise.id)).toBe(true);
    expect(facets.characters.map((character) => character.name).sort()).toEqual(
      ["Emilia", "Ram", "Rem"],
    );
    expect(facets.lineups).toHaveLength(1);
    expect(facets.years).toContain(2026);
    expect(facets.manufacturers).toContain("KADOKAWA");

    const denied = createCatalogQueries(db, () =>
      assertInternalAccount(db, undefined),
    );
    await expect(denied.list({})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(denied.facets({})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(denied.detail(randomUUID())).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(denied.movements(randomUUID())).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const disabled = await db.user.create({
      data: {
        id: randomUUID(),
        name: "Former operator",
        email: `${randomUUID()}@example.test`,
        isInternal: true,
        active: false,
      },
    });
    await expect(
      createCatalogQueries(db, () =>
        assertInternalAccount(db, disabled.id),
      ).list({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
