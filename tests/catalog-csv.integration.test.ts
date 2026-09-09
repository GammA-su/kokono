import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createCatalogQueries } from "../src/modules/catalog/queries";
import { createCatalogCsvService } from "../src/modules/catalog-csv/service";
import {
  CSV_FORMAT,
  csvRecord,
  csvCell,
  parseCatalogCsv,
  encodeCharacters,
  decodeCharacters,
} from "../src/modules/catalog-csv/format";
import { exportCatalogRecords } from "../src/modules/catalog-csv/export";
import { createPublicationService } from "../src/modules/publication/service";
import { applyInventoryOperation } from "../src/modules/inventory/operations";

const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = async () => ({ id: actorId });
const secret = "csv-test-signing-secret-".repeat(3);
const catalog = createCatalogService(db, authorize),
  queries = createCatalogQueries(db, authorize);
const service = createCatalogCsvService(db, authorize, secret);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "CSV operator",
        isInternal: true,
      },
    })
  ).id;
});
afterAll(() => db.$disconnect());
function file(rows: Record<string, string>[]) {
  const headers = [
    "csv_format",
    ...new Set(rows.flatMap((row) => Object.keys(row))),
  ];
  return (
    "\uFEFF" +
    csvRecord(headers) +
    rows
      .map((row) =>
        csvRecord(
          headers.map((key) =>
            key === "csv_format" ? CSV_FORMAT : (row[key] ?? ""),
          ),
        ),
      )
      .join("")
  );
}
async function fixture() {
  const key = randomUUID();
  const franchise = await catalog.createFranchise({
    name: "Re:Zero CSV",
    slug: key,
  });
  const lineup = await catalog.createLineup({
    name: "Marine 2026",
    slug: key,
    franchiseId: franchise.id,
    releaseDate: "2026-11",
  });
  const category = await catalog.createCategory({
    name: "CSV acrylic stand",
    slug: key,
  });
  await catalog.createCharacter({
    name: "Rem",
    japaneseName: "レム",
    franchiseId: franchise.id,
  });
  await catalog.createCharacter({
    name: "Ra|m",
    japaneseName: "ラム",
    franchiseId: franchise.id,
  });
  const item = await catalog.createItem({
    name: "Original",
    japaneseName: "元の名前",
    categoryId: category.id,
    lineupId: lineup.id,
    internalSku: key,
    slug: key,
    janCode: "4901234567894",
    privateNotes: "MANUAL_PRIVATE",
  });
  const preview = (rows: Record<string, string>[], policy = {}) =>
    service.preview({ lineupId: lineup.id, csv: file(rows), policy });
  return { franchise, lineup, category, item, preview };
}
describe("catalog CSV", () => {
  it("round-trips Japanese, quotes/newlines, multiple characters, all date precisions, MSRP, sources, image and watch data", async () => {
    const f = await fixture();
    const rows = ["YEAR", "MONTH", "DAY"].map((precision, index) => ({
      name: index === 0 ? '=HYPERLINK("example")' : `Stand ${index}`,
      japanese_name: `レム、マリン「${index}」`,
      internal_sku: randomUUID(),
      category: f.category.slug,
      characters: encodeCharacters(["Rem", "Ra|m"]),
      official_msrp_amount: "1650",
      official_msrp_currency: "JPY",
      official_msrp_tax_state: "INCLUDED",
      release_date: ["2026", "2026-11", "2026-11-23"][index],
      release_date_precision: precision,
      manufacturer: "カドカワ",
      private_notes: '\'Private, quoted "note"\nSecond line',
      source_provider: "公式",
      source_type: "MANUFACTURER",
      source_url: "https://example.test/official",
      sources_json: JSON.stringify([
        {
          provider: "Shop",
          source_type: "RETAILER",
          url: "https://example.test/shop",
        },
      ]),
      image_url: "https://example.test/image.png",
      watch_enabled: "true",
      watch_target_quantity: "5",
      watch_max_price_amount: "1250",
      watch_max_price_currency: "EUR",
      watch_priority: "URGENT",
      watch_condition: "新品",
      marketplace_search_query: "レム マリン & アクリル",
    }));
    const preview = await f.preview(rows);
    expect(preview.rows.every((row) => !row.errors.length)).toBe(true);
    expect(
      await db.merchandiseItem.count({ where: { lineupId: f.lineup.id } }),
    ).toBe(1);
    const imported = await service.execute({
      token: preview.token,
      confirmed: true,
      decisions: preview.rows.map((row) => ({
        row: row.row,
        decision: "create",
      })),
    });
    expect(imported).toMatchObject({ created: 3, failed: 0 });
    const ids = imported.results.map((row) => row.itemId!);
    const exported = exportCatalogRecords(await queries.exportRecords(ids));
    const decoded = parseCatalogCsv(exported);
    expect(decoded.rows[0]).toMatchObject({
      name: rows[0].name,
      private_notes: rows[0].private_notes,
      watch_max_price_amount: "1250",
      watch_max_price_currency: "EUR",
      characters: "Rem|Ra\\|m",
    });
    expect(decoded.rows.map((row) => row.release_date_precision)).toEqual([
      "YEAR",
      "MONTH",
      "DAY",
    ]);
    const again = await service.preview({
      lineupId: f.lineup.id,
      csv: exported,
      policy: { updateWatch: true, updatePrivateNotes: true },
    });
    const updated = await service.execute({
      token: again.token,
      confirmed: true,
      decisions: again.rows.map((row, index) => ({
        row: row.row,
        decision: "update",
        targetId: ids[index],
      })),
    });
    expect(updated).toMatchObject({ updated: 3, failed: 0 });
    expect(exportCatalogRecords(await queries.exportRecords(ids))).toBe(
      exported,
    );
    expect(
      await db.inventoryBalance.count({
        where: { merchandiseItemId: { in: ids } },
      }),
    ).toBe(0);
    expect(
      await db.saleListing.count({ where: { merchandiseItemId: { in: ids } } }),
    ).toBe(0);
    expect(
      await db.itemSource.count({ where: { merchandiseItemId: ids[0] } }),
    ).toBe(2);
    expect(
      (await db.itemImage.findFirst({ where: { merchandiseItemId: ids[0] } }))
        ?.approvedForPublicUse,
    ).toBe(false);
  });
  it("resolves skip/update/create-anyway and blocks hard SKU uniqueness", async () => {
    const f = await fixture();
    const preview = await f.preview([
      {
        name: "Original",
        internal_sku: f.item.internalSku,
        category: f.category.slug,
      },
      {
        name: "Ｏｒｉｇｉｎａｌ",
        japanese_name: "元の名前",
        category: f.category.slug,
        jan_code: f.item.janCode!,
      },
      { name: "Updated", internal_sku: f.item.internalSku },
    ]);
    expect(preview.rows[0].createBlocked.length).toBeGreaterThan(0);
    expect(
      preview.rows[1].candidates.find((candidate) => candidate.id === f.item.id)
        ?.signals,
    ).toEqual(expect.arrayContaining(["NAME", "JAPANESE_NAME", "JAN"]));
    const result = await service.execute({
      token: preview.token,
      confirmed: true,
      decisions: [
        { row: 2, decision: "skip" },
        { row: 3, decision: "create" },
        { row: 4, decision: "update", targetId: f.item.id },
      ],
    });
    expect(result).toMatchObject({
      created: 1,
      updated: 1,
      skipped: 1,
      failed: 0,
    });
    const conflict = await f.preview([
      {
        name: "Another",
        category: f.category.slug,
        internal_sku: f.item.internalSku,
      },
    ]);
    const rejected = await service.execute({
      token: conflict.token,
      confirmed: true,
      decisions: [{ row: 2, decision: "create" }],
    });
    expect(rejected.failed).toBe(1);
    expect(rejected.results[0].message).toContain("unique");
  });
  it("preserves inventory, listings, blank fields, private sourcing and unrelated evidence on update", async () => {
    const f = await fixture();
    const loc = await db.storageLocation.create({
      data: { code: randomUUID(), name: "Storage", type: "OTHER" },
    });
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: f.item.id,
        movementType: "PURCHASE",
        quantityDelta: 5,
        destinationLocationId: loc.id,
        operationKey: randomUUID(),
      },
      actorId,
    );
    await catalog.savePurchaseWatch({
      merchandiseItemId: f.item.id,
      targetQuantity: 12,
      marketplaceSearchQuery: "MANUAL_QUERY",
      notes: "MANUAL_WATCH_NOTES",
    });
    const publication = createPublicationService(db, authorize);
    const listing = await publication.saveListing({
      merchandiseItemId: f.item.id,
      slug: randomUUID(),
      sellingPriceAmount: 2500,
      sellingPriceCurrency: "EUR",
      publicTitle: "Manual title",
    });
    const source = await catalog.addSource({
      merchandiseItemId: f.item.id,
      provider: "Manual provider",
      url: "https://example.test/keep",
      notes: "MANUAL_SOURCE",
    });
    const beforeWatch = await db.purchaseWatch.findUnique({
      where: { merchandiseItemId: f.item.id },
    });
    const preview = await f.preview([
      {
        internal_sku: f.item.internalSku,
        name: "New name",
        japanese_name: "",
        private_notes: "CSV_PRIVATE",
        marketplace_search_query: "CSV_QUERY",
        watch_target_quantity: "3",
        source_provider: "Changed provider",
        source_url: source.url,
        sources_json: JSON.stringify([
          {
            provider: "New",
            source_type: "OTHER",
            url: "https://example.test/new",
          },
        ]),
      },
    ]);
    const result = await service.execute({
      token: preview.token,
      confirmed: true,
      decisions: [{ row: 2, decision: "update", targetId: f.item.id }],
    });
    expect(result).toMatchObject({ updated: 1, failed: 0 });
    expect(
      await db.merchandiseItem.findUnique({ where: { id: f.item.id } }),
    ).toMatchObject({
      name: "New name",
      japaneseName: "元の名前",
      privateNotes: "MANUAL_PRIVATE",
    });
    expect(
      await db.purchaseWatch.findUnique({
        where: { merchandiseItemId: f.item.id },
      }),
    ).toEqual(beforeWatch);
    expect(
      await db.itemSource.findUnique({ where: { id: source.id } }),
    ).toEqual(source);
    expect(
      await db.itemSource.count({ where: { merchandiseItemId: f.item.id } }),
    ).toBe(2);
    expect(
      await db.saleListing.findUnique({ where: { id: listing.id } }),
    ).toEqual(listing);
    expect(
      (
        await db.inventoryBalance.findFirst({
          where: { merchandiseItemId: f.item.id },
        })
      )?.quantity,
    ).toBe(5);
    expect(
      await db.inventoryMovement.count({
        where: { merchandiseItemId: f.item.id },
      }),
    ).toBe(1);
  });
  it("updates only explicitly opted-in nonblank watch/private fields", async () => {
    const f = await fixture();
    await catalog.savePurchaseWatch({
      merchandiseItemId: f.item.id,
      enabled: true,
      targetQuantity: 12,
      maxUnitPriceAmount: 1500,
      notes: "Keep notes",
    });
    const preview = await f.preview(
      [
        {
          internal_sku: f.item.internalSku,
          watch_enabled: "false",
          marketplace_search_query: "新しい検索",
          private_notes: "New private",
        },
      ],
      { updateWatch: true, updatePrivateNotes: true },
    );
    const result = await service.execute({
      token: preview.token,
      confirmed: true,
      decisions: [{ row: 2, decision: "update", targetId: f.item.id }],
    });
    expect(result.updated).toBe(1);
    expect(
      await db.purchaseWatch.findUnique({
        where: { merchandiseItemId: f.item.id },
      }),
    ).toMatchObject({
      enabled: false,
      targetQuantity: 12,
      maxUnitPriceAmount: 1500,
      marketplaceSearchQuery: "新しい検索",
      notes: "Keep notes",
    });
    expect(
      (await db.merchandiseItem.findUniqueOrThrow({ where: { id: f.item.id } }))
        .privateNotes,
    ).toBe("New private");
  });
  it("rejects malformed CSV, unknown/stock columns and unsafe image/source values", async () => {
    for (const input of [
      'name,category\n"broken',
      "name,name\na,b",
      "name,category\na,b,c",
      'name,category\n"a"junk,b',
      "name,stock_quantity\na,4",
      "name,inventory_balance\na,4",
      "name,published\na,true",
      "\0",
    ])
      expect(() => parseCatalogCsv(input)).toThrow();
    const f = await fixture();
    const preview = await f.preview([
      {
        name: "Invalid image",
        category: f.category.slug,
        image_url: "javascript:alert(1)",
      },
      { name: "Invalid JSON", category: f.category.slug, sources_json: "{" },
    ]);
    expect(preview.rows.every((row) => row.errors.length)).toBe(true);
    expect(
      await db.merchandiseItem.count({ where: { lineupId: f.lineup.id } }),
    ).toBe(1);
  });
  it("reports row-level partial failures atomically, including duplicate SKUs inside a file", async () => {
    const f = await fixture(),
      sku = randomUUID();
    const preview = await f.preview([
      { name: "First", category: f.category.slug, internal_sku: sku },
      { name: "Second", category: f.category.slug, internal_sku: sku },
      {
        name: "Invalid date",
        category: f.category.slug,
        release_date: "2026-11",
        release_date_precision: "DAY",
      },
    ]);
    expect(preview.rows[1].createBlocked.length).toBeGreaterThan(0);
    expect(preview.rows[2].errors.join()).toContain("disagree");
    const result = await service.execute({
      token: preview.token,
      confirmed: true,
      decisions: preview.rows.map((row) => ({
        row: row.row,
        decision: "create",
      })),
    });
    expect(result).toMatchObject({ created: 1, failed: 2 });
    expect(
      result.results
        .filter((row) => row.status === "failed")
        .every((row) => row.message.length > 0),
    ).toBe(true);
    expect(
      await db.merchandiseItem.count({ where: { lineupId: f.lineup.id } }),
    ).toBe(2);
  });
  it("rejects stale updates and replays creation without duplicating rows", async () => {
    const f = await fixture();
    const preview = await f.preview([
      { internal_sku: f.item.internalSku, name: "CSV update" },
    ]);
    await catalog.savePurchaseWatch({
      merchandiseItemId: f.item.id,
      marketplaceSearchQuery: "New manual sourcing",
    });
    const stale = await service.execute({
      token: preview.token,
      confirmed: true,
      decisions: [{ row: 2, decision: "update", targetId: f.item.id }],
    });
    expect(stale.results[0].message).toContain("changed after preview");
    const creation = await f.preview([
      { name: "New design", category: f.category.slug },
    ]);
    const input = {
      token: creation.token,
      confirmed: true,
      decisions: [{ row: 2, decision: "create" }],
    };
    const results = await Promise.all([
      service.execute(input),
      service.execute(input),
    ]);
    expect(results.reduce((sum, row) => sum + row.created, 0)).toBe(1);
    expect(results.reduce((sum, row) => sum + row.skipped, 0)).toBe(1);
  });
  it("requires authorization, confirmation, untampered preview and a reviewed target in this lineup", async () => {
    const f = await fixture();
    const preview = await f.preview([
      { name: "Original", category: f.category.slug },
    ]);
    const payload = {
      token: preview.token,
      confirmed: true,
      decisions: [{ row: 2, decision: "update", targetId: randomUUID() }],
    };
    expect((await service.execute(payload)).failed).toBe(1);
    await expect(
      service.execute({ ...payload, token: preview.token + "x" }),
    ).rejects.toThrow();
    await expect(
      service.execute({ ...payload, confirmed: false }),
    ).rejects.toThrow();
    const outsider = await db.user.create({
      data: {
        id: randomUUID(),
        name: "Customer",
        email: `${randomUUID()}@example.test`,
        isInternal: false,
      },
    });
    const denied = createCatalogCsvService(
      db,
      async () => ({ id: outsider.id }),
      secret,
    );
    await expect(
      denied.preview({
        lineupId: f.lineup.id,
        csv: file([{ name: "No" }]),
        policy: {},
      }),
    ).rejects.toThrow();
    await expect(denied.execute(payload)).rejects.toThrow();
    await expect(
      createCatalogQueries(db, async () => ({ id: outsider.id })).exportRecords(
        [f.item.id],
      ),
    ).rejects.toThrow();
    const other = await fixture();
    const cross = await f.preview([
      {
        internal_sku: other.item.internalSku,
        name: "Cross lineup",
        category: f.category.slug,
      },
    ]);
    expect(cross.rows[0].candidates[0].canUpdate).toBe(false);
    expect(
      (
        await service.execute({
          token: cross.token,
          confirmed: true,
          decisions: [{ row: 2, decision: "update", targetId: other.item.id }],
        })
      ).failed,
    ).toBe(1);
  });
  it("uses shared catalog filters for all-record export selection and never exports stock", async () => {
    const f = await fixture();
    const ids = await queries.matchingIds(
      { lineup: f.lineup.id, stock: "none", archived: "true" },
      100001,
    );
    expect(ids).toEqual([f.item.id]);
    const exported = parseCatalogCsv(
      exportCatalogRecords(await queries.exportRecords(ids)),
    );
    expect(exported.rows[0].release_date).toBe(""); // Inherited month remains inherited, not an invented item date.
    expect(
      exported.headers.some((header) =>
        /stock|inventory|owned|listing/.test(header),
      ),
    ).toBe(false);
  });
  it("escapes spreadsheet formulas reversibly and correctly handles Japanese character separators", () => {
    for (const text of [
      "=1+1",
      "+cmd",
      "-1",
      "@SUM(A1)",
      "\t=1",
      " \r=1",
      "＝1+1",
      "'original",
      '日本語, "quoted"\r\nnext',
    ]) {
      const csv = file([{ name: text }]);
      expect(parseCatalogCsv(csv).rows[0].name).toBe(text);
      if (text !== '日本語, "quoted"\r\nnext')
        expect(csvCell(text)).toMatch(/^"'/);
    }
    expect(
      decodeCharacters(encodeCharacters(["レム", "Ram|Emilia", "A\\B"])),
    ).toEqual(["レム", "Ram|Emilia", "A\\B"]);
    expect(() => decodeCharacters("Rem||Ram")).toThrow();
    expect(() => decodeCharacters("Rem\\")).toThrow();
    expect(parseCatalogCsv("name\n'Literal apostrophe").rows[0].name).toBe(
      "'Literal apostrophe",
    );
  });
});
