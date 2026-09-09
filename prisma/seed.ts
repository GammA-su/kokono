import "dotenv/config";
import { createDatabaseClient } from "../src/db/client";
import { applyInventoryOperation } from "../src/modules/inventory/operations";
import { parsePartialDate } from "../src/modules/catalog/partial-date";

if (process.env.NODE_ENV === "production" || process.env.ALLOW_DEVELOPMENT_SEED !== "true") {
  throw new Error("Synthetic seed refused. Set ALLOW_DEVELOPMENT_SEED=true in a non-production environment.");
}

const database = createDatabaseClient(process.env.DATABASE_URL ?? "");
try {
  const franchise = await database.franchise.upsert({
    where: { slug: "re-zero" }, update: {},
    create: {
      name: "Re:Zero − Starting Life in Another World", japaneseName: "Re:ゼロから始める異世界生活",
      slug: "re-zero", aliases: ["Re:Zero", "リゼロ"], description: "Synthetic development catalog; release details are illustrative.",
    },
  });
  const release = parsePartialDate("2026");
  const lineup = await database.lineup.upsert({
    where: { franchiseId_slug: { franchiseId: franchise.id, slug: "marine-ver-2026" } }, update: {},
    create: { franchiseId: franchise.id, name: "Marine Ver. 2026", slug: "marine-ver-2026", releaseDate: release.date,
      releaseDatePrecision: release.precision, status: "UNKNOWN", notes: "Synthetic sample, not a verified official release." },
  });
  const categoryNames = ["Acrylic Stand", "Acrylic Keychain", "Can Badge", "Clear File", "Tapestry", "Plush", "Prize Figure", "Scale Figure", "Trading Card", "Other"];
  const categories = new Map<string, string>();
  for (const name of categoryNames) {
    const slug = name.toLowerCase().replaceAll(" ", "-");
    const category = await database.category.upsert({ where: { slug }, update: {}, create: { name, slug } });
    categories.set(name, category.id);
  }
  const characterIds = {
    Rem: "9c808b55-76ba-4f36-b7cc-0dd301c6c201",
    Ram: "9c808b55-76ba-4f36-b7cc-0dd301c6c202",
    Emilia: "9c808b55-76ba-4f36-b7cc-0dd301c6c203",
  };
  for (const [name, japaneseName] of [["Rem", "レム"], ["Ram", "ラム"], ["Emilia", "エミリア"]] as const) {
    await database.character.upsert({ where: { id: characterIds[name] }, update: {}, create: { id: characterIds[name], franchiseId: franchise.id, name, japaneseName } });
  }
  const japan = await database.storageLocation.upsert({
    where: { code: "JP-WAREHOUSE" }, update: {}, create: { code: "JP-WAREHOUSE", name: "Japan Warehouse", type: "JAPAN_WAREHOUSE", countryCode: "JP" },
  });
  const france = await database.storageLocation.upsert({
    where: { code: "FR-HOME" }, update: {}, create: { code: "FR-HOME", name: "France Home", type: "FRANCE_HOME", countryCode: "FR", fulfillmentEnabled: true },
  });
  const shelf = await database.storageLocation.upsert({
    where: { code: "FR-HOME-SHELF-A" }, update: {}, create: { code: "FR-HOME-SHELF-A", name: "Shelf A", type: "SHELF", parentId: france.id },
  });
  const box = await database.storageLocation.upsert({
    where: { code: "FR-HOME-SHELF-A-BOX-A1" }, update: {}, create: { code: "FR-HOME-SHELF-A-BOX-A1", name: "Box A1", type: "BOX", parentId: shelf.id, fulfillmentEnabled: true },
  });
  await database.storageLocation.upsert({
    where: { code: "IN-TRANSIT" }, update: {}, create: { code: "IN-TRANSIT", name: "In Transit", type: "IN_TRANSIT" },
  });

  const itemIds = new Map<string, string>();
  for (const name of ["Rem", "Ram", "Emilia"] as const) {
    const sku = `DEMO-REZERO-MARINE-${name.toUpperCase()}-STAND`;
    const item = await database.merchandiseItem.upsert({
      where: { internalSku: sku }, update: {},
      create: {
        lineupId: lineup.id, categoryId: categories.get("Acrylic Stand")!, internalSku: sku,
        name: `${name} Marine Ver. Acrylic Stand`, slug: `${name.toLowerCase()}-marine-ver-acrylic-stand`,
        officialMsrpAmount: 1650, officialMsrpCurrency: "JPY", officialMsrpTaxInclusion: "INCLUDED",
        privateNotes: "Synthetic development item. Prices are examples, not verified market data.",
        characters: { create: { characterId: characterIds[name] } },
      },
    });
    itemIds.set(name, item.id);
  }
  // A fourth item makes the no-watch/no-stock/no-listing state and multiple characters explicit.
  const catalogOnly = await database.merchandiseItem.upsert({
    where: { internalSku: "DEMO-REZERO-MARINE-CLEAR-FILE" }, update: {},
    create: {
      lineupId: lineup.id, categoryId: categories.get("Clear File")!, internalSku: "DEMO-REZERO-MARINE-CLEAR-FILE",
      name: "Rem and Emilia Marine Ver. Clear File", slug: "rem-emilia-marine-ver-clear-file",
      characters: { create: [{ characterId: characterIds.Rem }, { characterId: characterIds.Emilia }] },
    },
  });
  await database.purchaseWatch.upsert({
    where: { merchandiseItemId: itemIds.get("Rem")! }, update: {},
    create: { merchandiseItemId: itemIds.get("Rem")!, targetQuantity: 5, maxUnitPriceAmount: 1000, priority: "HIGH", conditionPreference: "Unopened preferred", marketplaceSearchQuery: "レム マリン アクリルスタンド" },
  });
  await applyInventoryOperation(database, {
    merchandiseItemId: itemIds.get("Ram")!, movementType: "PURCHASE", quantityDelta: 3, destinationLocationId: japan.id,
    operationKey: "development-seed:ram:purchase:v1", acquisitionUnitCostAmount: 900, acquisitionUnitCostCurrency: "JPY",
  }, null);
  await applyInventoryOperation(database, {
    merchandiseItemId: itemIds.get("Emilia")!, movementType: "PURCHASE", quantityDelta: 5, destinationLocationId: france.id,
    operationKey: "development-seed:emilia:purchase:v1", acquisitionUnitCostAmount: 1000, acquisitionUnitCostCurrency: "JPY",
  }, null);
  await applyInventoryOperation(database, {
    merchandiseItemId: itemIds.get("Emilia")!, movementType: "TRANSFER", quantityDelta: 2,
    sourceLocationId: france.id, destinationLocationId: box.id, operationKey: "development-seed:emilia:shelve:v1",
  }, null);
  await database.saleListing.upsert({
    where: { merchandiseItemId: itemIds.get("Emilia")! }, update: {},
    create: { merchandiseItemId: itemIds.get("Emilia")!, slug: "emilia-marine-acrylic-stand", sellingPriceAmount: 2500,
      sellingPriceCurrency: "EUR", published: true, publishedAt: new Date(), publicDescription: "Illustrative development listing." },
  });
  const sourceId = "a8c8bb55-76ba-4f36-b7cc-0dd301c6c201";
  await database.itemSource.upsert({ where: { id: sourceId }, update: {}, create: {
    id: sourceId, merchandiseItemId: catalogOnly.id, provider: "Development example", sourceType: "OTHER",
    url: "https://example.com/illustrative-merchandise", notes: "Placeholder evidence only; not an actual official source.",
  } });
  await database.itemImage.upsert({ where: { id: "a8c8bb55-76ba-4f36-b7cc-0dd301c6c202" }, update: {}, create: {
    id: "a8c8bb55-76ba-4f36-b7cc-0dd301c6c202", merchandiseItemId: catalogOnly.id,
    storageKey: "development/placeholders/clear-file.webp", imageRole: "PRIMARY", caption: "Placeholder; no image uploaded.",
  } });
  console.log("Seeded four illustrative items, three characters, and five locations. No authentication accounts were created.");
} finally {
  await database.$disconnect();
}
