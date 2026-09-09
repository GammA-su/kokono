import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { assertInternalAccount } from "../src/modules/auth/authorization";
import { createBulkEntryService } from "../src/modules/catalog/bulk-entry";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLineupService } from "../src/modules/lineups/service";
import { formatPartialDate } from "../src/modules/catalog/partial-date";
import { formatRowIssue } from "../src/modules/catalog/bulk-fields";
import { internalSkuPrefix } from "../src/modules/catalog/sku";
import { normalizedName } from "../src/modules/catalog/duplicates";
import { guardPgQueryConcurrency } from "./pg-query-guard";

guardPgQueryConcurrency();

const db = createDatabaseClient(inject("testDatabaseUrl"));
let userId: string;
const authorize = () => assertInternalAccount(db, userId);
const catalog = createCatalogService(db, authorize);
const lineups = createLineupService(db, authorize);
const bulk = createBulkEntryService(db, authorize);

beforeAll(async () => {
  const user = await db.user.create({
    data: {
      id: randomUUID(),
      name: "Bulk tester",
      email: `${randomUUID()}@example.test`,
      isInternal: true,
    },
  });
  userId = user.id;
});
afterAll(async () => {
  await db.$disconnect();
});

const lineupSource = {
  provider: "KADOKAWA",
  sourceType: "MANUFACTURER",
  url: "https://example.com/official",
  checkedDate: "",
  notes: null,
};
async function workspace() {
  const franchise = await catalog.createFranchise({
    name: `Re:Zero ${randomUUID()}`,
    slug: randomUUID(),
  });
  const lineup = await lineups.save({
    franchiseId: franchise.id,
    name: "Marine Ver. 2026",
    japaneseName: "マリン Ver. 2026",
    manufacturer: "KADOKAWA",
    releaseDate: "2026-11",
    announcedDate: "2026",
    status: "PREORDER",
    sources: [lineupSource],
  });
  const category = await catalog.createCategory({
    name: "Acrylic stand",
    slug: randomUUID(),
  });
  const characters = Object.fromEntries(
    await Promise.all(
      ["Rem", "Ram", "Emilia"].map(async (name) => [
        name,
        await catalog.createCharacter({ franchiseId: franchise.id, name }),
      ]),
    ),
  );
  return { franchise, lineup, category, characters };
}
function row(categoryId: string, overrides: Record<string, unknown> = {}) {
  return {
    name: "Rem Acrylic Stand",
    categoryId,
    // The editor sends inherited lineup values with every row; they stay overridable.
    manufacturer: "KADOKAWA",
    releaseDate: "2026-11",
    ...overrides,
  };
}

describe("bulk merchandise entry", () => {
  it("creates several items with inherited lineup metadata, sources and images in one batch", async () => {
    const { lineup, category, characters } = await workspace();
    const result = await bulk.save({
      lineupId: lineup.id,
      rows: [
        row(category.id, {
          name: "Rem Acrylic Stand",
          japaneseName: "レム アクリルスタンド",
          characterIds: [characters.Rem.id],
          officialMsrpAmount: "1650",
          officialMsrpTaxInclusion: "INCLUDED",
          janCode: "4970381234567",
          image: "https://example.com/rem.png",
          source: {
            provider: "KADOKAWA",
            sourceType: "MANUFACTURER",
            url: "https://example.com/official",
          },
        }),
        row(category.id, {
          name: "Ram Acrylic Stand",
          characterIds: [characters.Ram.id],
          officialMsrpAmount: "1650",
        }),
        row(category.id, {
          name: "Emilia Acrylic Stand",
          characterIds: [characters.Emilia.id],
          officialMsrpAmount: "1650",
          privateNotes: "Check the reprint",
        }),
      ],
    });
    expect(result.created).toHaveLength(3);
    const items = await db.merchandiseItem.findMany({
      where: { lineupId: lineup.id },
      include: { characters: true, sources: true, images: true },
      orderBy: { name: "asc" },
    });
    expect(items.map((item) => item.name)).toEqual([
      "Emilia Acrylic Stand",
      "Ram Acrylic Stand",
      "Rem Acrylic Stand",
    ]);
    for (const item of items) {
      expect(item.manufacturer).toBe("KADOKAWA");
      expect(
        formatPartialDate(item.releaseDate, item.releaseDatePrecision),
      ).toBe("November 2026");
      expect(item.officialMsrpAmount).toBe(1650);
      expect(item.officialMsrpCurrency).toBe("JPY");
      expect(item.slug).not.toBe("");
    }
    const rem = items.find((item) => item.name === "Rem Acrylic Stand")!;
    expect(rem.officialMsrpTaxInclusion).toBe("INCLUDED");
    expect(rem.janCode).toBe("4970381234567");
    expect(rem.sources).toHaveLength(1);
    expect(rem.sources[0].url).toBe("https://example.com/official");
    expect(rem.images).toHaveLength(1);
    expect(rem.images[0].imageRole).toBe("PRIMARY");
    expect(rem.images[0].storageKey).toBe("https://example.com/rem.png");
    expect(rem.images[0].originalUrl).toBe("https://example.com/rem.png");
    expect(rem.images[0].sourceProvider).toBe("KADOKAWA");
    // Cataloguing alone creates no stock, watch, or listing.
    expect(
      await db.inventoryBalance.count({ where: { merchandiseItemId: rem.id } }),
    ).toBe(0);
    expect(
      await db.purchaseWatch.count({ where: { merchandiseItemId: rem.id } }),
    ).toBe(0);
    expect(
      await db.saleListing.count({ where: { merchandiseItemId: rem.id } }),
    ).toBe(0);
  });

  it("stores multiple characters per item through the ItemCharacter relation", async () => {
    const { lineup, category, characters } = await workspace();
    await bulk.save({
      lineupId: lineup.id,
      rows: [
        row(category.id, {
          name: "Rem and Ram Clear File",
          characterIds: [characters.Rem.id, characters.Ram.id],
        }),
        row(category.id, {
          name: "Emilia and Subaru Tapestry",
          // A repeated selection is stored once.
          characterIds: [characters.Emilia.id, characters.Emilia.id],
        }),
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
    const items = await db.merchandiseItem.findMany({
      where: { lineupId: lineup.id },
      include: { characters: { include: { character: true } } },
      orderBy: { name: "asc" },
    });
    expect(
      items.map((item) =>
        item.characters.map(({ character }) => character.name).sort(),
      ),
    ).toEqual([["Emilia"], ["Ram", "Rem"], ["Emilia", "Ram", "Rem"]]);
  });

  it("duplicates a previous row's release metadata while keeping separate identities", async () => {
    const { lineup, category, characters } = await workspace();
    // The editor's duplicate action reuses shared metadata but never the SKU, JAN,
    // characters or image; the same distinction is asserted on the persisted records.
    const shared = {
      categoryId: category.id,
      manufacturer: "KADOKAWA",
      releaseDate: "2026-11-14",
      officialMsrpAmount: "1650",
      officialMsrpCurrency: "JPY",
      source: {
        provider: "KADOKAWA",
        sourceType: "MANUFACTURER",
        url: "https://example.com/official",
      },
      watch: { enabled: true, targetQuantity: "2", priority: "HIGH" },
    };
    await bulk.save({
      lineupId: lineup.id,
      rows: [
        {
          ...shared,
          name: "Rem Acrylic Stand",
          characterIds: [characters.Rem.id],
          janCode: "4970381111111",
        },
        {
          ...shared,
          name: "Ram Acrylic Stand",
          characterIds: [characters.Ram.id],
          janCode: "4970381111128",
        },
        {
          ...shared,
          name: "Emilia Acrylic Stand",
          characterIds: [characters.Emilia.id],
        },
      ],
    });
    const items = await db.merchandiseItem.findMany({
      where: { lineupId: lineup.id },
      include: { purchaseWatch: true, sources: true },
      orderBy: { name: "asc" },
    });
    expect(items).toHaveLength(3);
    expect(new Set(items.map((item) => item.internalSku)).size).toBe(3);
    expect(items.map((item) => item.janCode)).toEqual([
      null,
      "4970381111128",
      "4970381111111",
    ]);
    for (const item of items) {
      expect(
        formatPartialDate(item.releaseDate, item.releaseDatePrecision),
      ).toBe("14 November 2026");
      expect(item.purchaseWatch?.targetQuantity).toBe(2);
      expect(item.purchaseWatch?.priority).toBe("HIGH");
      expect(item.sources[0].provider).toBe("KADOKAWA");
    }
  });

  it("preserves imprecise release dates and never invents a first day of the month", async () => {
    const { lineup, category } = await workspace();
    await bulk.save({
      lineupId: lineup.id,
      rows: [
        row(category.id, { name: "Year only", releaseDate: "2026" }),
        row(category.id, { name: "Month only", releaseDate: "2026-11" }),
        row(category.id, { name: "Exact day", releaseDate: "2026-11-14" }),
        row(category.id, { name: "Unknown release", releaseDate: "" }),
      ],
    });
    const items = await db.merchandiseItem.findMany({
      where: { lineupId: lineup.id },
      orderBy: { name: "asc" },
    });
    expect(
      items.map((item) => [
        item.name,
        item.releaseDatePrecision,
        formatPartialDate(item.releaseDate, item.releaseDatePrecision),
      ]),
    ).toEqual([
      ["Exact day", "DAY", "14 November 2026"],
      ["Month only", "MONTH", "November 2026"],
      ["Unknown release", null, null],
      ["Year only", "YEAR", "2026"],
    ]);
  });

  it("creates purchase watches only for rows that configure one", async () => {
    const { lineup, category } = await workspace();
    await bulk.save({
      lineupId: lineup.id,
      rows: [
        row(category.id, {
          name: "Watched stand",
          watch: {
            enabled: true,
            targetQuantity: "5",
            maxUnitPriceAmount: "1000",
            maxUnitPriceCurrency: "JPY",
            priority: "URGENT",
            conditionPreference: "Sealed only",
            marketplaceSearchQuery: "レム アクリルスタンド",
            notes: "Buy below retail",
          },
        }),
        row(category.id, {
          name: "Query only stand",
          // A query without the toggle still stores a disabled configuration.
          watch: { marketplaceSearchQuery: "ラム アクリルスタンド" },
        }),
        row(category.id, { name: "Unwatched stand" }),
      ],
    });
    const items = await db.merchandiseItem.findMany({
      where: { lineupId: lineup.id },
      include: { purchaseWatch: true },
      orderBy: { name: "asc" },
    });
    const [queryOnly, unwatched, watched] = items;
    expect(watched.purchaseWatch).toMatchObject({
      enabled: true,
      targetQuantity: 5,
      maxUnitPriceAmount: 1000,
      maxUnitPriceCurrency: "JPY",
      priority: "URGENT",
      conditionPreference: "Sealed only",
      marketplaceSearchQuery: "レム アクリルスタンド",
      notes: "Buy below retail",
    });
    expect(queryOnly.purchaseWatch).toMatchObject({
      enabled: false,
      marketplaceSearchQuery: "ラム アクリルスタンド",
    });
    expect(unwatched.purchaseWatch).toBeNull();
  });

  it("reports possible duplicates for review and saves them once acknowledged", async () => {
    const { lineup, category, characters } = await workspace();
    await bulk.save({
      lineupId: lineup.id,
      rows: [
        row(category.id, {
          name: "Rem Acrylic Stand",
          japaneseName: "レム アクリルスタンド",
          janCode: "4970381222222",
          characterIds: [characters.Rem.id],
          officialMsrpAmount: "1650",
        }),
      ],
    });
    const candidates = {
      lineupId: lineup.id,
      rows: [
        row(category.id, { name: "rem  acrylic stand!" }),
        row(category.id, { name: "Other stand", janCode: "4970381222222" }),
        row(category.id, {
          name: "Another stand",
          japaneseName: "レム アクリルスタンド",
        }),
        row(category.id, {
          name: "Attribute twin",
          characterIds: [characters.Rem.id],
          officialMsrpAmount: "1650",
        }),
        row(category.id, { name: "Batch repeat" }),
        row(category.id, { name: "Batch repeat" }),
      ],
    };
    const review = await bulk.review(candidates);
    expect(review.issues).toEqual([]);
    expect(
      review.warnings.map((warning) => [warning.row, warning.signal]),
    ).toEqual(
      expect.arrayContaining([
        [1, "NAME"],
        [2, "JAN"],
        [3, "JAPANESE_NAME"],
        [4, "ATTRIBUTES"],
        [6, "NAME"],
      ]),
    );
    for (const warning of review.warnings)
      expect(warning.message).toContain("Possible duplicate");
    // Weak signals are never rejected silently: they block only until acknowledged.
    await expect(bulk.save(candidates)).rejects.toMatchObject({
      code: "DUPLICATE_REVIEW",
    });
    expect(
      await db.merchandiseItem.count({ where: { lineupId: lineup.id } }),
    ).toBe(1);
    const saved = await bulk.save({
      ...candidates,
      acknowledgeDuplicates: true,
    });
    expect(saved.created).toHaveLength(6);
    expect(
      await db.merchandiseItem.count({ where: { lineupId: lineup.id } }),
    ).toBe(7);
  });

  it("identifies invalid rows by row, field and reason without saving any row", async () => {
    const { lineup, category, characters } = await workspace();
    const rows = [
      row(category.id, {
        name: "Valid stand",
        characterIds: [characters.Rem.id],
      }),
      row(category.id, { name: "", janCode: "12345" }),
      row(category.id, {
        name: "Bad money",
        officialMsrpAmount: "1650.50",
        releaseDate: "2026-02-30",
      }),
      row(category.id, {
        name: "Bad source",
        source: {
          provider: "",
          sourceType: "OTHER",
          url: "javascript:alert(1)",
        },
      }),
      { ...row(category.id, { name: "No category" }), categoryId: "" },
      {
        ...row(category.id, { name: "Missing character" }),
        characterIds: [randomUUID()],
      },
    ];
    const review = await bulk.review({ lineupId: lineup.id, rows });
    expect(review.valid).toBe(1);
    expect(review.issues.map((issue) => [issue.row, issue.field])).toEqual([
      [2, "name"],
      [2, "janCode"],
      [3, "releaseDate"],
      [3, "officialMsrpAmount"],
      [4, "source.url"],
      [5, "categoryId"],
      [6, "characterIds"],
    ]);
    expect(formatRowIssue(review.issues[1])).toBe(
      "Row 2 — JAN code: JAN code must be 8 or 13 digits.",
    );
    await expect(
      bulk.save({ lineupId: lineup.id, rows }),
    ).rejects.toMatchObject({ code: "INVALID_ROWS" });
    // The valid row is not written either: the batch is all or nothing.
    expect(
      await db.merchandiseItem.count({ where: { lineupId: lineup.id } }),
    ).toBe(0);
  });

  it("generates unique deterministic SKUs and rejects a conflicting manual SKU", async () => {
    const { lineup, category } = await workspace();
    const prefix = internalSkuPrefix(lineup);
    await bulk.save({
      lineupId: lineup.id,
      rows: [
        row(category.id, { name: "First stand" }),
        row(category.id, { name: "Second stand" }),
        row(category.id, {
          name: "Manual stand",
          internalSku: `${prefix}-0100`,
        }),
      ],
    });
    const items = await db.merchandiseItem.findMany({
      where: { lineupId: lineup.id },
      orderBy: { internalSku: "asc" },
    });
    expect(items.map((item) => item.internalSku)).toEqual([
      `${prefix}-0001`,
      `${prefix}-0002`,
      `${prefix}-0100`,
    ]);
    // A later batch continues the same sequence without reusing a taken suffix.
    await bulk.save({
      lineupId: lineup.id,
      rows: [row(category.id, { name: "Third stand" })],
    });
    expect(
      (
        await db.merchandiseItem.findFirst({
          where: { lineupId: lineup.id, name: "Third stand" },
        })
      )?.internalSku,
    ).toBe(`${prefix}-0101`);
    await expect(
      bulk.save({
        lineupId: lineup.id,
        rows: [
          row(category.id, {
            name: "Duplicate SKU",
            internalSku: `${prefix}-0100`,
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROWS" });
    expect(
      await db.merchandiseItem.count({ where: { lineupId: lineup.id } }),
    ).toBe(4);
  });

  it("refuses archived lineups and unauthorized actors", async () => {
    const { franchise, lineup, category } = await workspace();
    await db.lineup.update({
      where: { id: lineup.id },
      data: { archivedAt: new Date() },
    });
    await expect(
      bulk.save({ lineupId: lineup.id, rows: [row(category.id)] }),
    ).rejects.toMatchObject({ code: "LINEUP_UNAVAILABLE" });
    await lineups.restore(lineup.id);
    await db.franchise.update({
      where: { id: franchise.id },
      data: { archivedAt: new Date() },
    });
    await expect(
      bulk.save({ lineupId: lineup.id, rows: [row(category.id)] }),
    ).rejects.toMatchObject({ code: "LINEUP_UNAVAILABLE" });
    await db.franchise.update({
      where: { id: franchise.id },
      data: { archivedAt: null },
    });

    const denied = () => assertInternalAccount(db, undefined);
    const anonymous = createBulkEntryService(db, denied);
    await expect(
      anonymous.save({ lineupId: lineup.id, rows: [row(category.id)] }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      anonymous.review({ lineupId: lineup.id, rows: [row(category.id)] }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

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
      createBulkEntryService(db, () =>
        assertInternalAccount(db, disabled.id),
      ).save({ lineupId: lineup.id, rows: [row(category.id)] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await db.merchandiseItem.count({ where: { lineupId: lineup.id } }),
    ).toBe(0);
  });

  it("normalizes names for comparison without changing what is stored", () => {
    expect(normalizedName("Rem  Acrylic Stand!")).toBe("remacrylicstand");
    expect(normalizedName("ＲＥＭ・アクリルスタンド")).toBe(
      "remアクリルスタンド",
    );
  });
});
