import { randomUUID, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import {
  applyInventoryOperation,
  getOwnedQuantity,
} from "../src/modules/inventory/operations";
import { reservedAt } from "../src/modules/inventory/reservations";
import { createGachaService } from "../src/modules/gacha/service";
import {
  createGachaQueries,
  publicGachaOdds,
  publicGachaBanners,
} from "../src/modules/gacha/queries";
import { prizeForTicket } from "../src/modules/gacha/odds";
import { createPublicationService } from "../src/modules/publication/service";
import { resolvePublicListings } from "../src/modules/publication/queries";
import { createCommerceService } from "../src/modules/commerce/service";
import { makePublicationReady } from "./publication-fixture";
import { guardPgQueryConcurrency } from "./pg-query-guard";
guardPgQueryConcurrency();
const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = async () => ({ id: actorId }),
  catalog = createCatalogService(db, authorize),
  locations = createLocationService(db, authorize),
  service = createGachaService(db, authorize),
  queries = createGachaQueries(db, authorize);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Gacha operator",
        isInternal: true,
      },
    })
  ).id;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
});
async function fixture(quantity = 3, prizeCount = 1) {
  const slug = randomUUID(),
    franchise = await catalog.createFranchise({ name: "Gacha fixture", slug }),
    lineup = await catalog.createLineup({
      name: "Test release",
      slug,
      franchiseId: franchise.id,
    }),
    category = await catalog.createCategory({ name: "Stand", slug });
  const fr = await locations.create({
    code: `FR-${slug}`,
    name: "France gacha box",
    type: "FRANCE_HOME",
    countryCode: "FR",
    fulfillmentEnabled: true,
  });
  const jp = await locations.create({
    code: `JP-${slug}`,
    name: "Japan storage",
    type: "JAPAN_WAREHOUSE",
    countryCode: "JP",
  });
  const items = [];
  for (let n = 0; n < prizeCount; n++) {
    const item = await catalog.createItem({
      name: `Prize ${n}`,
      japaneseName: `レム ${n}`,
      slug: `${slug}-${n}`,
      internalSku: `${slug}-${n}`,
      lineupId: lineup.id,
      categoryId: category.id,
      privateNotes: "PRIVATE_GACHA_TEST",
    });
    if (quantity) await receive(item.id, fr.id, quantity);
    await receive(item.id, jp.id, 10);
    items.push(item);
  }
  const input = {
    name: "Test banner",
    slug,
    active: true,
    terms: "Administrator grant terms",
    termsVersion: "1",
    prizes: items.map((item, n) => ({
      merchandiseItemId: item.id,
      displayName: item.name,
      description: "Public prize",
      tier: n ? "Common" : "Rare",
      weight: n ? 9 : 1,
      allocation: 1,
    })),
  };
  return { items, fr, jp, input };
}
function receive(
  merchandiseItemId: string,
  destinationLocationId: string,
  quantityDelta: number,
) {
  return applyInventoryOperation(
    db,
    {
      merchandiseItemId,
      destinationLocationId,
      quantityDelta,
      movementType: "PURCHASE",
      operationKey: randomUUID(),
    },
    actorId,
  );
}
function grant(
  b: { id: string; configurationId: string },
  key: string = randomUUID(),
) {
  return service.grant({
    bannerId: b.id,
    configurationId: b.configurationId,
    operationKey: key,
    customerReference: "CUSTOMER_PRIVATE_REFERENCE",
    reason: "No-charge administrator grant",
  });
}
describe("inventory-backed gacha", () => {
  it("public banner discovery is paginated and cannot expose private state or future price as a live offer", async () => {
    const f = await fixture(1),
      b = await service.configure({
        ...f.input,
        active: false,
        pullPriceAmount: 1200,
        currency: "EUR",
      });
    let page = await publicGachaBanners(db, 1);
    let row = page.items.find((i) => i.id === b.id);
    for (let n = 2; !row && n <= page.pageInfo.pageCount; n++) {
      page = await publicGachaBanners(db, n);
      row = page.items.find((i) => i.id === b.id);
    }
    expect(row).toMatchObject({
      slug: f.input.slug,
      active: false,
      price: null,
      artwork: null,
      publicDrawsEnabled: false,
    });
    expect(page.pageInfo.size).toBe(24);
    expect(page.items.length).toBeLessThanOrEqual(24);
    expect(JSON.stringify(page)).not.toContain(actorId);
    expect(Object.keys(row!).sort()).toEqual(
      [
        "id",
        "slug",
        "name",
        "description",
        "active",
        "startsAt",
        "endsAt",
        "artwork",
        "price",
        "publicDrawsEnabled",
      ].sort(),
    );
    const detail = await publicGachaOdds(db, f.input.slug);
    expect(detail).toMatchObject({
      bannerId: b.id,
      price: null,
      publicDrawsEnabled: false,
    });
  });
  it("checkout and gacha contend for the same last unit through shared reservations", async () => {
    const f = await fixture(1),
      item = f.items[0],
      image = await makePublicationReady(db, item.id),
      fresh = await db.merchandiseItem.findUniqueOrThrow({
        where: { id: item.id },
      });
    const listing = await createPublicationService(
      db,
      authorize,
    ).publishReviewed({
      expectedItemUpdatedAt: fresh.updatedAt.toISOString(),
      expectedListingUpdatedAt: null,
      listing: {
        merchandiseItemId: item.id,
        slug: item.slug,
        publicTitle: "Public prize",
        sellingPriceAmount: 2490,
        sellingPriceCurrency: "EUR",
        sellingPriceTaxInclusion: "INCLUDED",
        imageIds: [image.id],
      },
    });
    const commerce = createCommerceService(db),
      owner = randomBytes(32).toString("base64url"),
      quote = await commerce.quote(owner, {
        lines: [{ listingId: listing.id, quantity: 1 }],
        contact: { email: "gacha-checkout@example.test" },
        shippingAddress: {
          name: "Test Customer",
          line1: "10 rue Test",
          city: "Paris",
          postalCode: "75001",
          country: "FR",
        },
      });
    const results = await Promise.allSettled([
      service.configure(f.input),
      commerce.checkout(owner, {
        quoteId: quote.id,
        operationKey: randomUUID(),
        accepted: true,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.$transaction((tx) => reservedAt(tx, item.id, f.fr.id)),
    ).toBe(1);
    const publicItems = await resolvePublicListings(db, {
      listingIds: [listing.id],
    });
    expect(publicItems.items[0].availability.availableQuantity).toBe(0);
    expect(await getOwnedQuantity(db, item.id)).toBe(11);
  });
  it("reserves pool stock in the shared model without changing physical balances", async () => {
    const f = await fixture(3, 2),
      b = await service.configure(f.input);
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(13);
    expect(
      await db.$transaction((tx) => reservedAt(tx, f.items[0].id, f.fr.id)),
    ).toBe(1);
    const reservations = await db.inventoryReservation.findMany({
      where: { gachaPrize: { bannerId: b.id } },
    });
    expect(reservations).toHaveLength(2);
    expect(
      reservations.every(
        (r) =>
          r.orderItemId === null &&
          r.storageLocationId === f.fr.id &&
          r.status === "CONFIRMED",
      ),
    ).toBe(true);
    await expect(
      applyInventoryOperation(
        db,
        {
          merchandiseItemId: f.items[0].id,
          sourceLocationId: f.fr.id,
          quantityDelta: -3,
          movementType: "LOST",
          operationKey: randomUUID(),
        },
        actorId,
      ),
    ).rejects.toThrow();
    const odds = await publicGachaOdds(db, f.input.slug);
    expect(odds?.prizes.map((p) => p.probability.percentage)).toEqual([
      "10",
      "90",
    ]);
  });
  it("rejects Japan-only stock and rolls back the entire configuration", async () => {
    const f = await fixture(0);
    await expect(service.configure(f.input)).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });
    expect(await db.gachaBanner.count({ where: { slug: f.input.slug } })).toBe(
      0,
    );
  });
  it("serializes two simultaneous grants for the final prize and replays an operation key", async () => {
    const f = await fixture(1),
      b = await service.configure(f.input),
      key = randomUUID();
    const results = await Promise.allSettled([grant(b, key), grant(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.gachaPull.count({ where: { bannerId: b.id } })).toBe(1);
    const pull = await db.gachaPull.findFirstOrThrow({
      where: { bannerId: b.id },
    });
    const replay = await grant(b, pull.operationKey);
    expect(replay.id).toBe(pull.id);
    const reservation = await db.inventoryReservation.findUniqueOrThrow({
      where: { gachaPullId: pull.id },
    });
    expect(reservation.status).toBe("CONFIRMED");
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(11);
    expect((await publicGachaOdds(db, f.input.slug))?.drawState).toBe(
      "POOL_DEPLETED",
    );
  });
  it("stops all draws when any prize is depleted without changing weights", async () => {
    const f = await fixture(2, 2),
      b = await service.configure(f.input);
    await grant(b);
    const publicOdds = await publicGachaOdds(db, f.input.slug);
    expect(publicOdds?.drawState).toBe("POOL_DEPLETED");
    expect(publicOdds?.prizes.map((p) => p.probability.percentage)).toEqual([
      "10",
      "90",
    ]);
    await expect(grant(b)).rejects.toMatchObject({ code: "POOL_UNAVAILABLE" });
  });
  it("consumes through a single immutable GACHA movement and prevents double consumption", async () => {
    const f = await fixture(1),
      b = await service.configure(f.input),
      p = await grant(b);
    const operation = {
      pullId: p.id,
      action: "CONSUME",
      reason: "Handover REF-1",
    };
    await Promise.all([
      service.finalize(operation),
      service.finalize(operation),
    ]);
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(10);
    const movements = await db.inventoryMovement.findMany({
      where: { referenceType: "GACHA_PULL", referenceId: p.id },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      movementType: "GACHA",
      quantityDelta: -1,
      sourceLocationId: f.fr.id,
      actorUserId: actorId,
    });
    expect(
      (
        await db.inventoryReservation.findUniqueOrThrow({
          where: { gachaPullId: p.id },
        })
      ).movementId,
    ).toBe(movements[0].id);
    await expect(
      service.finalize({ pullId: p.id, action: "CANCEL", reason: "Too late" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
  it("preserves historical odds and awards across configuration edits, with stale edit protection", async () => {
    const f = await fixture(3),
      first = await service.configure(f.input),
      pull = await grant(first),
      snapshot = await db.gachaConfiguration.findUniqueOrThrow({
        where: { id: first.configurationId },
      });
    const second = await service.configure({
      ...f.input,
      id: first.id,
      expectedConfigurationId: first.configurationId,
      termsVersion: "2",
      prizes: [{ ...f.input.prizes[0], weight: 9, allocation: 2 }],
    });
    expect(second.version).toBe(2);
    expect(
      await db.gachaConfiguration.findUnique({
        where: { id: first.configurationId },
      }),
    ).toEqual(snapshot);
    expect(
      (await db.gachaPull.findUniqueOrThrow({ where: { id: pull.id } }))
        .configurationId,
    ).toBe(first.configurationId);
    expect(
      await db.$transaction((tx) => reservedAt(tx, f.items[0].id, f.fr.id)),
    ).toBe(3);
    await expect(
      service.configure({
        ...f.input,
        id: first.id,
        expectedConfigurationId: first.configurationId,
      }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
    await expect(grant(first)).rejects.toMatchObject({
      code: "CONFIGURATION_CHANGED",
    });
    await service.finalize({
      pullId: pull.id,
      action: "CANCEL",
      reason: "Recipient declined",
    });
    expect(
      await db.$transaction((tx) => reservedAt(tx, f.items[0].id, f.fr.id)),
    ).toBe(2);
  });
  it("rolls back released old allocations if a replacement pool cannot be backed", async () => {
    const f = await fixture(1),
      b = await service.configure(f.input);
    await expect(
      service.configure({
        ...f.input,
        id: b.id,
        expectedConfigurationId: b.configurationId,
        prizes: [{ ...f.input.prizes[0], allocation: 2 }],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect((await queries.detail(b.id))?.readiness.ready).toBe(true);
    expect(
      await db.gachaConfiguration.count({ where: { bannerId: b.id } }),
    ).toBe(1);
  });
  it("enforces immutable snapshots, prize odds, pull audit and award backing at the database boundary", async () => {
    const f = await fixture(2),
      b = await service.configure(f.input),
      p = await grant(b),
      prize = await db.gachaPrize.findUniqueOrThrow({
        where: { id: p.prizeId },
      });
    expect(prizeForTicket([prize], p.randomTicket).prize.id).toBe(p.prizeId);
    await expect(
      db.gachaConfiguration.update({
        where: { id: b.configurationId },
        data: { snapshot: { tampered: true } },
      }),
    ).rejects.toThrow();
    await expect(
      db.gachaPrize.update({ where: { id: p.prizeId }, data: { weight: 100 } }),
    ).rejects.toThrow();
    await expect(
      db.gachaPull.update({
        where: { id: p.id },
        data: { audit: { tampered: true } },
      }),
    ).rejects.toThrow();
    await expect(
      db.gachaPull.delete({ where: { id: p.id } }),
    ).rejects.toThrow();
    await expect(
      db.inventoryReservation.update({
        where: { gachaPullId: p.id },
        data: { status: "RELEASED" },
      }),
    ).rejects.toThrow();
    await expect(
      db.gachaBanner.update({
        where: { id: b.id },
        data: { paidEnabled: true },
      }),
    ).rejects.toThrow();
    await expect(
      db.gachaEvent.updateMany({
        where: { bannerId: b.id },
        data: { note: "tampered" },
      }),
    ).rejects.toThrow();
  });
  it("pause retains stock; release and cancellation free only the intended units without refilling", async () => {
    const f = await fixture(2),
      b = await service.configure({
        ...f.input,
        prizes: [{ ...f.input.prizes[0], allocation: 2 }],
      }),
      p = await grant(b);
    await service.control({
      bannerId: b.id,
      configurationId: b.configurationId,
      action: "PAUSE",
      reason: "Pause",
    });
    expect(
      await db.$transaction((tx) => reservedAt(tx, f.items[0].id, f.fr.id)),
    ).toBe(2);
    await expect(grant(b)).rejects.toMatchObject({ code: "POOL_UNAVAILABLE" });
    await service.control({
      bannerId: b.id,
      configurationId: b.configurationId,
      action: "RELEASE_POOL",
      reason: "Release unawarded",
    });
    expect(
      await db.$transaction((tx) => reservedAt(tx, f.items[0].id, f.fr.id)),
    ).toBe(1);
    await service.finalize({
      pullId: p.id,
      action: "CANCEL",
      reason: "Cancel award",
    });
    expect(
      await db.$transaction((tx) => reservedAt(tx, f.items[0].id, f.fr.id)),
    ).toBe(0);
    await expect(
      service.control({
        bannerId: b.id,
        configurationId: b.configurationId,
        action: "RESUME",
        reason: "No stock allocated",
      }),
    ).rejects.toThrow();
    expect(await getOwnedQuantity(db, f.items[0].id)).toBe(12);
  });
  it("enforces eligibility and schedule, and supports a global grant kill switch", async () => {
    const f = await fixture(2),
      b = await service.configure({
        ...f.input,
        startsAt: "2099-01-01T00:00:00Z",
      });
    await expect(grant(b)).rejects.toMatchObject({ code: "POOL_UNAVAILABLE" });
    const active = await service.configure({
      ...f.input,
      id: b.id,
      expectedConfigurationId: b.configurationId,
    });
    vi.stubEnv("GACHA_DRAWS_ENABLED", "false");
    try {
      await expect(grant(active)).rejects.toMatchObject({
        code: "POOL_UNAVAILABLE",
      });
    } finally {
      vi.unstubAllEnvs();
    }
    await db.storageLocation.update({
      where: { id: f.fr.id },
      data: { active: false },
    });
    expect((await publicGachaOdds(db, f.input.slug))?.drawState).toBe(
      "LOCATION_OR_ITEM_UNAVAILABLE",
    );
    await expect(grant(active)).rejects.toThrow();
  });
  it("simulation has no database side effects and public selectors exclude private data", async () => {
    const f = await fixture(2, 2),
      b = await service.configure(f.input);
    await grant(b);
    const before = {
      pulls: await db.gachaPull.count({ where: { bannerId: b.id } }),
      events: await db.gachaEvent.count({ where: { bannerId: b.id } }),
      reservations: await db.inventoryReservation.findMany({
        where: { gachaPrize: { bannerId: b.id } },
        orderBy: { id: "asc" },
      }),
      balances: await db.inventoryBalance.findMany({
        where: { merchandiseItemId: { in: f.items.map((i) => i.id) } },
        orderBy: [{ merchandiseItemId: "asc" }, { storageLocationId: "asc" }],
      }),
    };
    const simulation = await service.simulate({
      configurationId: b.configurationId,
      count: 100000,
    });
    expect(simulation.results.reduce((n, r) => n + r.observed, 0)).toBe(100000);
    expect(await db.gachaPull.count({ where: { bannerId: b.id } })).toBe(
      before.pulls,
    );
    expect(await db.gachaEvent.count({ where: { bannerId: b.id } })).toBe(
      before.events,
    );
    expect(
      await db.inventoryReservation.findMany({
        where: { gachaPrize: { bannerId: b.id } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before.reservations);
    expect(
      await db.inventoryBalance.findMany({
        where: { merchandiseItemId: { in: f.items.map((i) => i.id) } },
        orderBy: [{ merchandiseItemId: "asc" }, { storageLocationId: "asc" }],
      }),
    ).toEqual(before.balances);
    const publicData = JSON.stringify(await publicGachaOdds(db, f.input.slug));
    for (const secret of [
      "CUSTOMER_PRIVATE_REFERENCE",
      "PRIVATE_GACHA_TEST",
      actorId,
      f.fr.code,
      "actorUser",
      "purchaseWatch",
      "randomTicket",
      "audit",
    ])
      expect(publicData).not.toContain(secret);
  });
  it("rejects unauthorized queries, mutations, paid requests and conflicting operation keys", async () => {
    const f = await fixture(2),
      b = await service.configure(f.input),
      user = await db.user.create({
        data: {
          id: randomUUID(),
          email: `${randomUUID()}@example.test`,
          name: "External",
          isInternal: false,
        },
      }),
      external = async () => ({ id: user.id }),
      forbidden = createGachaService(db, external);
    await expect(forbidden.configure(f.input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      forbidden.simulate({ configurationId: b.configurationId, count: 10 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      createGachaQueries(db, external).detail(b.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      forbidden.grant({
        bannerId: b.id,
        configurationId: b.configurationId,
        operationKey: randomUUID(),
        customerReference: "X",
        reason: "Test",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.grant({
        bannerId: b.id,
        configurationId: b.configurationId,
        operationKey: randomUUID(),
        customerReference: "X",
        reason: "Test",
        mode: "PAID",
      }),
    ).rejects.toThrow();
    const p = await grant(b);
    await expect(
      service.grant({
        bannerId: b.id,
        configurationId: b.configurationId,
        operationKey: p.operationKey,
        customerReference: "Another recipient",
        reason: "Test",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      forbidden.finalize({ pullId: p.id, action: "CONSUME", reason: "Test" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
