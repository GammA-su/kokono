import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createAssistedImportService } from "../src/modules/assisted-import/service";
const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = async () => ({ id: actorId });
const secret = "assisted-import-test-secret-".repeat(3);
const html = readFileSync(
  new URL("./fixtures/sources/structured-lineup.html", import.meta.url),
  "utf8",
);
const catalog = createCatalogService(db, authorize);
const service = createAssistedImportService(
  db,
  authorize,
  secret,
  async (url) => ({ url, html }),
);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Importer operator",
        isInternal: true,
      },
    })
  ).id;
});
afterAll(() => db.$disconnect());
async function fixture() {
  const key = randomUUID();
  const franchise = await catalog.createFranchise({
    name: "Importer franchise",
    slug: key,
  });
  const lineup = await catalog.createLineup({
    name: "Importer lineup",
    slug: key,
    franchiseId: franchise.id,
  });
  const category = await catalog.createCategory({
    name: `Stand ${key}`,
    slug: key,
  });
  const character = await catalog.createCharacter({
    name: "Rem",
    japaneseName: "レム",
    franchiseId: franchise.id,
  });
  const input = {
    franchiseId: franchise.id,
    lineupId: lineup.id,
    provider: "Official Fixture",
    sourceType: "MANUFACTURER",
    url: `https://merch.example.com/${key}`,
  };
  const extraction = await service.extract(input);
  const rows = extraction.candidates.map((row) => ({
    ...row,
    categoryId: category.id,
  }));
  return { franchise, lineup, category, character, input, extraction, rows };
}
describe("administrator-reviewed source imports", () => {
  it("extracts without writes, imports only confirmed selection and preserves names, dates, image/source provenance", async () => {
    const f = await fixture();
    expect(
      await db.merchandiseItem.count({ where: { lineupId: f.lineup.id } }),
    ).toBe(0);
    expect(f.extraction.candidates[0].characterIds).toEqual([f.character.id]);
    expect(f.extraction.candidates[0].warnings.join(" ")).toContain(
      "未登録キャラ",
    );
    await expect(
      service.commit({
        token: f.extraction.token,
        confirmed: true,
        acknowledgeDuplicates: true,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_REVIEW" });
    const row = {
      ...f.rows[0],
      name: "Rem Marine Acrylic Stand",
      sources: [
        {
          provider: "Edited source",
          sourceType: "RETAILER" as const,
          url: `https://shop.example.com/${randomUUID()}`,
        },
      ],
    };
    const review = await service.review({
      token: f.extraction.token,
      rows: [row],
    });
    expect(review.issues).toEqual([]);
    expect(review.token).toBeTruthy();
    expect(
      await db.merchandiseItem.count({ where: { lineupId: f.lineup.id } }),
    ).toBe(0);
    await expect(
      service.commit({
        token: review.token,
        confirmed: false,
        acknowledgeDuplicates: true,
      }),
    ).rejects.toThrow();
    const result = await service.commit({
      token: review.token,
      confirmed: true,
      acknowledgeDuplicates: true,
    });
    expect(result.created).toBe(1);
    const stored = await db.merchandiseItem.findUniqueOrThrow({
      where: { id: row.key },
      include: {
        sources: true,
        images: true,
        characters: true,
        inventoryBalances: true,
        inventoryMovements: true,
        saleListing: true,
      },
    });
    expect(stored).toMatchObject({
      name: row.name,
      japaneseName: "レム　マリンVer. アクリルスタンド",
      officialMsrpAmount: 1650,
      officialMsrpCurrency: "JPY",
      janCode: "0490123456789",
      releaseDatePrecision: "MONTH",
    });
    expect(stored.releaseDate?.toISOString().slice(0, 7)).toBe("2026-11");
    expect(stored.characters.map((c) => c.characterId)).toEqual([
      f.character.id,
    ]);
    expect(stored.sources.map((s) => s.url)).toEqual(
      expect.arrayContaining([
        f.input.url,
        "https://merch.example.com/products/rem",
        row.sources[0].url,
      ]),
    );
    expect(
      stored.sources.every((s) =>
        s.notes?.includes("Original Japanese name: レム　"),
      ),
    ).toBe(true);
    expect(stored.images).toHaveLength(2);
    expect(
      stored.images.every(
        (image) =>
          !image.approvedForPublicUse &&
          image.originalUrl &&
          image.sourceUrl === f.input.url &&
          image.sourceProvider === "Official Fixture",
      ),
    ).toBe(true);
    expect(stored.inventoryBalances).toEqual([]);
    expect(stored.inventoryMovements).toEqual([]);
    expect(stored.saleListing).toBeNull();
    expect(
      await db.merchandiseItem.count({ where: { lineupId: f.lineup.id } }),
    ).toBe(1);
  });
  it("detects JAN/title/source/image duplicates and requires an explicit duplicate decision", async () => {
    const f = await fixture();
    const original = await catalog.createItem({
      name: f.rows[0].name,
      japaneseName: f.rows[0].japaneseName,
      categoryId: f.category.id,
      lineupId: f.lineup.id,
      internalSku: randomUUID(),
      slug: randomUUID(),
      janCode: f.rows[0].janCode,
    });
    await db.itemSource.create({
      data: {
        merchandiseItemId: original.id,
        provider: "Evidence",
        url: f.input.url,
      },
    });
    await db.itemImage.create({
      data: {
        merchandiseItemId: original.id,
        storageKey: f.rows[0].images[0].url,
        originalUrl: f.rows[0].images[0].url,
      },
    });
    const review = await service.review({
      token: f.extraction.token,
      rows: [f.rows[0]],
    });
    expect(
      review.duplicates.some(
        (w) => w.message.includes("JAN") && w.existingItemId === original.id,
      ),
    ).toBe(true);
    expect(
      review.duplicates.some((w) => w.message.includes("Japanese name")),
    ).toBe(true);
    expect(
      review.duplicates.some((w) =>
        w.message.includes("Shared image or source"),
      ),
    ).toBe(true);
    await expect(
      service.commit({
        token: review.token,
        confirmed: true,
        acknowledgeDuplicates: false,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_DUPLICATES" });
    const before = await db.merchandiseItem.count({
      where: { lineupId: f.lineup.id },
    });
    await service.commit({
      token: review.token,
      confirmed: true,
      acknowledgeDuplicates: true,
    });
    expect(
      await db.merchandiseItem.count({ where: { lineupId: f.lineup.id } }),
    ).toBe(before + 1);
    expect(
      (
        await db.merchandiseItem.findUniqueOrThrow({
          where: { id: original.id },
        })
      ).name,
    ).toBe(original.name);
  });
  it("prevents edited/tampered selection, stale duplicate decisions and double insertion", async () => {
    const f = await fixture();
    await expect(
      service.review({
        token: f.extraction.token,
        rows: [{ ...f.rows[2], key: randomUUID() }],
      }),
    ).rejects.toMatchObject({ code: "IMPORT_SELECTION" });
    await expect(
      service.review({
        token: f.extraction.token,
        rows: [f.rows[2], f.rows[2]],
      }),
    ).rejects.toThrow();
    await expect(
      service.review({ token: `${f.extraction.token}x`, rows: [f.rows[2]] }),
    ).rejects.toThrow();
    const review = await service.review({
      token: f.extraction.token,
      rows: [f.rows[2]],
    });
    await catalog.createItem({
      name: f.rows[2].name,
      categoryId: f.category.id,
      lineupId: f.lineup.id,
      internalSku: randomUUID(),
      slug: randomUUID(),
    });
    await expect(
      service.commit({
        token: review.token,
        confirmed: true,
        acknowledgeDuplicates: true,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_CHANGED" });
    const next = await service.review({
      token: f.extraction.token,
      rows: [f.rows[2]],
    });
    const results = await Promise.all(
      [1, 2].map(() =>
        service.commit({
          token: next.token,
          confirmed: true,
          acknowledgeDuplicates: true,
        }),
      ),
    );
    expect(results.map((r) => r.created).sort()).toEqual([0, 1]);
    expect(results.map((r) => r.skipped).sort()).toEqual([0, 1]);
  });
  it("rejects missing fields, cross-franchise characters, inconsistent dates and unauthorized stock/image fields", async () => {
    const f = await fixture(),
      other = await fixture();
    const bad = await service.review({
      token: f.extraction.token,
      rows: [
        f.rows[0],
        { ...f.rows[1], categoryId: "", releaseDatePrecision: "DAY" },
      ],
    });
    expect(bad.token).toBeNull();
    expect(bad.issues.length).toBeGreaterThan(0);
    const character = await service.review({
      token: f.extraction.token,
      rows: [{ ...f.rows[0], characterIds: [other.character.id] }],
    });
    expect(character.issues[0].message).toContain("franchise");
    const date = await service.review({
      token: f.extraction.token,
      rows: [{ ...f.rows[0], releaseDatePrecision: "DAY" }],
    });
    expect(date.issues[0].message).toContain("precision disagree");
    await expect(
      service.review({
        token: f.extraction.token,
        rows: [{ ...f.rows[0], stock_quantity: 50 }],
      }),
    ).rejects.toThrow();
    await expect(
      service.review({
        token: f.extraction.token,
        rows: [
          {
            ...f.rows[0],
            images: [{ ...f.rows[0].images[0], approvedForPublicUse: true }],
          },
        ],
      }),
    ).rejects.toThrow();
    expect(
      await db.merchandiseItem.count({ where: { lineupId: f.lineup.id } }),
    ).toBe(0);
  });
  it("keeps failed extraction read-only and checks authorization before any outbound work", async () => {
    const f = await fixture();
    let fetched = 0;
    const failing = createAssistedImportService(
      db,
      authorize,
      secret,
      async () => {
        fetched++;
        throw new Error("fixture failure");
      },
    );
    await expect(failing.extract(f.input)).rejects.toThrow();
    expect(
      await db.merchandiseItem.count({ where: { lineupId: f.lineup.id } }),
    ).toBe(0);
    const outsider = await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "External",
        isInternal: false,
      },
    });
    const unauthorized = createAssistedImportService(
      db,
      async () => outsider,
      secret,
      async () => {
        fetched++;
        return { url: f.input.url, html };
      },
    );
    await expect(unauthorized.extract(f.input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(unauthorized.options()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      unauthorized.review({ token: f.extraction.token, rows: f.rows }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetched).toBe(1);
    await db.franchise.update({
      where: { id: f.franchise.id },
      data: { archivedAt: new Date() },
    });
    await expect(failing.extract(f.input)).rejects.toMatchObject({
      code: "IMPORT_LINEUP",
    });
    expect(fetched).toBe(1);
  });
});
