import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { assertInternalAccount } from "../src/modules/auth/authorization";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { applyInventoryOperation } from "../src/modules/inventory/operations";

const database = createDatabaseClient(inject("testDatabaseUrl"));
let internalId: string;
const authorize = async () => assertInternalAccount(database, internalId);
const catalog = createCatalogService(database, authorize);
const locations = createLocationService(database, authorize);

beforeAll(async () => {
  const user = await database.user.create({
    data: {
      id: randomUUID(),
      name: "Catalog editor",
      email: `editor-${randomUUID()}@example.test`,
      isInternal: true,
    },
  });
  internalId = user.id;
});
afterAll(async () => {
  await database.$disconnect();
});

async function fixture() {
  const suffix = randomUUID();
  const franchise = await catalog.createFranchise({
    name: "Re:Zero",
    slug: `rz-${suffix}`,
  });
  const lineup = await catalog.createLineup({
    franchiseId: franchise.id,
    name: "Marine 2026",
    slug: `marine-${suffix}`,
  });
  const category = await catalog.createCategory({
    name: "Acrylic Stand",
    slug: `stand-${suffix}`,
  });
  const character = await catalog.createCharacter({
    franchiseId: franchise.id,
    name: `Rem ${suffix}`,
  });
  const other = await catalog.createCharacter({
    franchiseId: franchise.id,
    name: `Ram ${suffix}`,
  });
  const item = await catalog.createItem({
    name: "Rem Acrylic Stand",
    lineupId: lineup.id,
    categoryId: category.id,
    internalSku: suffix,
    slug: `rem-${suffix}`,
    characterIds: [character.id],
  });
  const base = {
    name: item.name,
    lineupId: lineup.id,
    categoryId: category.id,
    internalSku: item.internalSku,
    slug: item.slug,
  };
  return { suffix, franchise, lineup, category, character, other, item, base };
}
const identity = (item: { id: string; updatedAt: Date }) => ({
  id: item.id,
  updatedAt: item.updatedAt.toISOString(),
});

describe("catalog item editing", () => {
  it("updates fields and replaces character links without touching other records", async () => {
    const f = await fixture();
    const updated = await catalog.saveItem(
      {
        ...f.base,
        name: "Rem Acrylic Stand (revised)",
        japaneseName: "レム",
        description: "Updated description",
        manufacturer: "Good Smile",
        privateNotes: "internal only",
        officialMsrpAmount: 1650,
        officialMsrpCurrency: "JPY",
        characterIds: [f.other.id],
      },
      identity(f.item),
    );
    expect(updated.name).toBe("Rem Acrylic Stand (revised)");
    expect(updated.japaneseName).toBe("レム");
    expect(updated.officialMsrpAmount).toBe(1650);
    const links = await database.itemCharacter.findMany({
      where: { merchandiseItemId: f.item.id },
    });
    expect(links.map((link) => link.characterId)).toEqual([f.other.id]);
  });

  it("refuses a save built from a stale copy of the item", async () => {
    const f = await fixture();
    const stale = identity(f.item);
    await catalog.saveItem({ ...f.base, name: "First edit" }, stale);
    // Second operator submits a form opened before the first edit landed.
    await expect(
      catalog.saveItem({ ...f.base, name: "Second edit" }, stale),
    ).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
    const current = await database.merchandiseItem.findUniqueOrThrow({
      where: { id: f.item.id },
    });
    expect(current.name).toBe("First edit");
  });

  it("refuses to move an item into an archived lineup", async () => {
    const f = await fixture();
    const archivedLineup = await catalog.createLineup({
      franchiseId: f.franchise.id,
      name: "Retired",
      slug: `retired-${f.suffix}`,
    });
    await database.lineup.update({
      where: { id: archivedLineup.id },
      data: { archivedAt: new Date() },
    });
    await expect(
      catalog.saveItem(
        { ...f.base, lineupId: archivedLineup.id },
        identity(f.item),
      ),
    ).rejects.toMatchObject({ code: "LINEUP_UNAVAILABLE" });
  });

  it("requires the exact name before removing anything", async () => {
    const f = await fixture();
    await expect(catalog.removeItem(f.item.id, "wrong name")).rejects.toMatchObject({
      code: "CONFIRM_NAME",
    });
    expect(
      await database.merchandiseItem.findUnique({ where: { id: f.item.id } }),
    ).not.toBeNull();
  });

  it("deletes an item with no history, along with the records it owns", async () => {
    const f = await fixture();
    await catalog.addSource({
      merchandiseItemId: f.item.id,
      provider: "Official",
      sourceType: "OFFICIAL_STORE",
      url: "https://example.test/product",
    });
    await catalog.savePurchaseWatch({
      merchandiseItemId: f.item.id,
      targetQuantity: 2,
    });
    const result = await catalog.removeItem(f.item.id, f.item.name);
    expect(result).toMatchObject({ outcome: "deleted" });
    expect(
      await database.merchandiseItem.findUnique({ where: { id: f.item.id } }),
    ).toBeNull();
    for (const remaining of [
      database.itemSource.count({ where: { merchandiseItemId: f.item.id } }),
      database.itemCharacter.count({ where: { merchandiseItemId: f.item.id } }),
      database.purchaseWatch.count({ where: { merchandiseItemId: f.item.id } }),
    ])
      expect(await remaining).toBe(0);
  });

  /**
   * The ledger is immutable and orders reference their items, so an item that has ever held
   * stock must survive as an archived record rather than being deleted out from under them.
   */
  it("archives instead of deleting once the item has inventory history", async () => {
    const f = await fixture();
    const warehouse = await locations.create({
      code: `JP-${f.suffix}`,
      name: "Japan",
      type: "JAPAN_WAREHOUSE",
    });
    await applyInventoryOperation(
      database,
      {
        merchandiseItemId: f.item.id,
        movementType: "PURCHASE",
        quantityDelta: 3,
        destinationLocationId: warehouse.id,
        operationKey: randomUUID(),
      },
      internalId,
    );
    expect(await catalog.removeItem(f.item.id, f.item.name)).toBe("archived");
    const archived = await database.merchandiseItem.findUniqueOrThrow({
      where: { id: f.item.id },
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(
      await database.inventoryMovement.count({
        where: { merchandiseItemId: f.item.id },
      }),
    ).toBe(1);
    // Repeating the request must not report a second archive or delete the record.
    expect(await catalog.removeItem(f.item.id, f.item.name)).toBe(
      "already-archived",
    );

    const restored = await catalog.restoreItem(f.item.id);
    expect(restored.archivedAt).toBeNull();
  });

  it("refuses to restore an item whose lineup is still archived", async () => {
    const f = await fixture();
    await catalog.archiveItem(f.item.id);
    await database.lineup.update({
      where: { id: f.lineup.id },
      data: { archivedAt: new Date() },
    });
    await expect(catalog.restoreItem(f.item.id)).rejects.toMatchObject({
      code: "LINEUP_UNAVAILABLE",
    });
  });

  it("rejects every catalog mutation from a non-internal caller", async () => {
    const f = await fixture();
    const outsider = createCatalogService(database, async () => ({ id: "" }));
    // Each call is started only when it is awaited: building them all up front would leave
    // rejected promises unhandled while the loop works through the previous one.
    for (const attempt of [
      () => outsider.saveItem({ ...f.base }, identity(f.item)),
      () => outsider.removeItem(f.item.id, f.item.name),
      () => outsider.restoreItem(f.item.id),
    ])
      await expect(attempt()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("edits a franchise and refuses a stale save", async () => {
    const f = await fixture();
    const stale = {
      id: f.franchise.id,
      updatedAt: f.franchise.updatedAt.toISOString(),
    };
    const renamed = await catalog.updateFranchise(
      { name: "Re:Zero renamed", japaneseName: "リゼロ" },
      stale,
    );
    expect(renamed.name).toBe("Re:Zero renamed");
    // The slug is not editable, so admin URLs and prior references keep working.
    expect(renamed.slug).toBe(f.franchise.slug);
    await expect(
      catalog.updateFranchise({ name: "Third name" }, stale),
    ).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
  });

  it("archives a franchise that still has lineups, and deletes an empty one", async () => {
    const f = await fixture();
    await expect(
      catalog.removeFranchise(f.franchise.id, "not the name"),
    ).rejects.toMatchObject({ code: "CONFIRM_NAME" });
    expect(await catalog.removeFranchise(f.franchise.id, f.franchise.name)).toBe(
      "archived",
    );
    expect(
      (
        await database.franchise.findUniqueOrThrow({
          where: { id: f.franchise.id },
        })
      ).archivedAt,
    ).not.toBeNull();
    expect(await catalog.removeFranchise(f.franchise.id, f.franchise.name)).toBe(
      "already-archived",
    );
    expect(
      (await catalog.restoreFranchise(f.franchise.id)).archivedAt,
    ).toBeNull();

    const empty = await catalog.createFranchise({
      name: `Empty ${f.suffix}`,
      slug: `empty-${f.suffix}`,
    });
    expect(await catalog.removeFranchise(empty.id, empty.name)).toBe("deleted");
    expect(
      await database.franchise.findUnique({ where: { id: empty.id } }),
    ).toBeNull();
  });
});
