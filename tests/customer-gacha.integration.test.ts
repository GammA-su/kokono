import {
  claimGachaReward,
  createRewardFulfillmentService,
} from "../src/modules/gacha/fulfillment";
import { createRewardFulfillmentQueries } from "../src/modules/gacha/fulfillment-queries";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { applyInventoryOperation } from "../src/modules/inventory/operations";
import { createGachaService } from "../src/modules/gacha/service";
import {
  createGachaCustomerAdmin,
  createCustomerGachaService,
} from "../src/modules/gacha/customer-service";
import { createCustomerGachaHandler } from "../src/modules/gacha/customer-http";
import {
  createCustomerService,
  setCustomerDisabled,
} from "../src/modules/customers/service";
import { publicGachaOdds } from "../src/modules/gacha/queries";
import { guardPgQueryConcurrency } from "./pg-query-guard";
import { makePublicationReady } from "./publication-fixture";
import { getPublicImage } from "../src/modules/publication/queries";
guardPgQueryConcurrency();
const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = async () => ({ id: actorId }),
  catalog = createCatalogService(db, authorize),
  domain = createGachaService(db, authorize),
  admin = createGachaCustomerAdmin(db, authorize),
  customerService = createCustomerService(db),
  service = createCustomerGachaService(db),
  http = createCustomerGachaHandler(db);
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
beforeEach(() => {
  vi.stubEnv("GACHA_CUSTOMER_EXECUTION_ENABLED", "true");
  vi.stubEnv("GACHA_DRAWS_ENABLED", "true");
  // Pin the verification policy explicitly. These cases exercise gacha mechanics, not the
  // verification gate, and CUSTOMER_VERIFICATION_POLICY takes precedence over the older
  // boolean — so leaving it to ambient configuration would make the suite depend on whichever
  // policy the developer happens to have configured.
  vi.stubEnv("CUSTOMER_REQUIRE_VERIFIED_EMAIL", "false");
  vi.stubEnv("CUSTOMER_VERIFICATION_POLICY", "off");
  vi.stubEnv("COMMERCE_GATEWAY_SECRET", "g".repeat(40));
  vi.stubEnv("STOREFRONT_BASE_URL", "https://shop.example");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
});
async function customer() {
  return customerService.register({
    email: `${randomUUID()}@example.test`,
    password: randomUUID(),
    displayName: "Customer",
  });
}
async function fixture(allocation = 2) {
  const slug = randomUUID(),
    franchise = await catalog.createFranchise({
      name: "Gacha franchise",
      slug,
    }),
    lineup = await catalog.createLineup({
      name: "Gacha release",
      slug,
      franchiseId: franchise.id,
    }),
    category = await catalog.createCategory({ name: "Stand", slug }),
    item = await catalog.createItem({
      name: "Rem stand",
      japaneseName: "レム",
      slug,
      internalSku: slug,
      lineupId: lineup.id,
      categoryId: category.id,
      privateNotes: "PRIVATE_SOURCING",
    }),
    location = await createLocationService(db, authorize).create({
      code: slug,
      name: "PRIVATE_FRANCE_LOCATION",
      type: "FRANCE_HOME",
      countryCode: "FR",
      fulfillmentEnabled: true,
    });
  await applyInventoryOperation(
    db,
    {
      merchandiseItemId: item.id,
      destinationLocationId: location.id,
      quantityDelta: allocation + 2,
      movementType: "PURCHASE",
      operationKey: randomUUID(),
    },
    actorId,
  );
  const config = {
    name: "Customer banner",
    slug,
    active: true,
    terms: "No-charge supervised test",
    termsVersion: "v1",
    prizes: [
      {
        merchandiseItemId: item.id,
        displayName: "レム / Rem",
        tier: "SR",
        weight: 1,
        allocation,
      },
    ],
  };
  const banner = await domain.configure(config),
    user = await customer();
  await admin.enable({
    bannerId: banner.id,
    enabled: true,
    reason: "Controlled test",
  });
  await allow(banner.id, user.customer.id, 100);
  const input = {
    bannerId: banner.id,
    configurationId: banner.configurationId,
    requestKey: randomUUID(),
    count: 1 as const,
  };
  return { item, location, config, banner, user, input };
}
function allow(bannerId: string, customerId: string, maxPulls = 1) {
  return admin.authorize({
    bannerId,
    customerId,
    maxPulls,
    operationKey: randomUUID(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    reason: "Explicit no-charge allowance",
  });
}
function request(
  path: string,
  token = "",
  input?: unknown,
  headers: Record<string, string> = {},
) {
  return http(
    new Request(`https://backend.example/api/storefront/v1/gacha/${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        "x-commerce-gateway-key": "g".repeat(40),
        "x-customer-session": token,
        "x-customer-client": "a".repeat(64),
        origin: "https://shop.example",
        "content-type": "application/json",
        ...headers,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }),
    path.split("?")[0].split("/"),
  );
}
const deliveryAddress = {
  name: "Test customer",
  line1: "12 rue des Fleurs",
  line2: "",
  city: "Paris",
  postalCode: "75001",
  country: "FR",
};
const fulfillment = createRewardFulfillmentService(db, authorize);
async function awarded() {
  const f = await fixture();
  const receipt = await service.pull(f.user.token, f.input);
  return { ...f, receipt, rewardId: receipt.prizes[0].rewardId };
}
describe("physical gacha fulfillment", () => {
  it("claim snapshots the address, reuses the reservation and concurrent duplicates create one request", async () => {
    const f = await awarded(),
      input = {
        rewardId: f.rewardId,
        operationKey: randomUUID(),
        address: deliveryAddress,
      };
    const before = await db.inventoryReservation.count({
      where: { merchandiseItemId: f.item.id },
    });
    const results = await Promise.all([
      claimGachaReward(db, f.user.token, input),
      claimGachaReward(db, f.user.token, input),
    ]);
    expect(results[0]).toEqual(results[1]);
    const r = await db.gachaReward.findUniqueOrThrow({
      where: { id: f.rewardId },
      include: { fulfillment: true, reservation: true },
    });
    expect(r.status).toBe("CLAIMED");
    expect(r.reservation.status).toBe("CONFIRMED");
    expect(r.fulfillment).toMatchObject({
      origin: "GACHA",
      orderId: null,
      address: deliveryAddress,
    });
    expect(
      await db.inventoryReservation.count({
        where: { merchandiseItemId: f.item.id },
      }),
    ).toBe(before);
    expect(
      await db.fulfillmentRequest.count({
        where: { originReference: f.rewardId },
      }),
    ).toBe(1);
    await expect(
      claimGachaReward(db, f.user.token, {
        ...input,
        address: { ...deliveryAddress, line1: "Changed address" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      db.fulfillmentRequest.update({
        where: { id: r.fulfillmentId! },
        data: { address: { ...deliveryAddress, city: "Changed" } },
      }),
    ).rejects.toThrow();
  });
  it("dispatch consumes the exact allocation once, reuses shipments and delivers without another movement", async () => {
    const f = await awarded(),
      claim = {
        rewardId: f.rewardId,
        operationKey: randomUUID(),
        address: deliveryAddress,
      };
    await claimGachaReward(db, f.user.token, claim);
    await fulfillment.transition({
      id: f.rewardId,
      action: "PREPARING",
      reason: "Pick verified",
    });
    const dispatch = {
      id: f.rewardId,
      action: "SHIPPED",
      carrier: "Recorded carrier",
      trackingNumber: "TEST-123",
      reason: "Handed to carrier",
    };
    await Promise.all([
      fulfillment.transition(dispatch),
      fulfillment.transition(dispatch),
    ]);
    let r = await db.gachaReward.findUniqueOrThrow({
      where: { id: f.rewardId },
      include: {
        fulfillment: { include: { shipment: true } },
        reservation: true,
      },
    });
    expect(r.status).toBe("SHIPPED");
    expect(r.reservation.status).toBe("CONSUMED");
    expect(r.fulfillment?.shipment?.trackingNumber).toBe(
      dispatch.trackingNumber,
    );
    const movements = await db.inventoryMovement.findMany({
      where: { merchandiseItemId: f.item.id, movementType: "GACHA" },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      quantityDelta: -1,
      sourceLocationId: f.location.id,
      referenceId: f.receipt.pullId,
    });
    expect(
      await db.order.count({ where: { customerId: f.user.customer.id } }),
    ).toBe(0);
    await expect(
      fulfillment.transition({ ...dispatch, trackingNumber: "Changed" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await fulfillment.transition({
      id: f.rewardId,
      action: "DELIVERED",
      reason: "Confirmed",
    });
    await fulfillment.transition({
      id: f.rewardId,
      action: "DELIVERED",
      reason: "Retry",
    });
    await fulfillment.transition(dispatch);
    r = await db.gachaReward.findUniqueOrThrow({
      where: { id: f.rewardId },
      include: {
        fulfillment: { include: { shipment: true } },
        reservation: true,
      },
    });
    expect(r.fulfillment?.shipment?.deliveredAt).toBeTruthy();
    expect(r.status).toBe("DELIVERED");
    expect(
      await db.inventoryMovement.count({
        where: { merchandiseItemId: f.item.id, movementType: "GACHA" },
      }),
    ).toBe(1);
    expect((await claimGachaReward(db, f.user.token, claim)).status).toBe(
      "DELIVERED",
    );
    expect(await service.recover(f.user.token, f.receipt.pullId)).toEqual(
      f.receipt,
    );
    expect(
      (await service.reward(f.user.token, f.rewardId)).fulfillment?.shipment
        ?.trackingNumber,
    ).toBe(dispatch.trackingNumber);
    await expect(
      fulfillment.transition({
        id: f.rewardId,
        action: "CANCELLED",
        reason: "Invalid",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
  it.each(["AWARDED", "CLAIMED", "PREPARING"])(
    "cancel at %s releases the unit without a physical stock change",
    async (status) => {
      const f = await awarded();
      if (status !== "AWARDED")
        await claimGachaReward(db, f.user.token, {
          rewardId: f.rewardId,
          operationKey: randomUUID(),
          address: deliveryAddress,
        });
      if (status === "PREPARING")
        await fulfillment.transition({
          id: f.rewardId,
          action: "PREPARING",
          reason: "Pack",
        });
      await fulfillment.transition({
        id: f.rewardId,
        action: "CANCELLED",
        reason: "Cancelled",
      });
      await fulfillment.transition({
        id: f.rewardId,
        action: "CANCELLED",
        reason: "Retry",
      });
      const r = await db.gachaReward.findUniqueOrThrow({
        where: { id: f.rewardId },
        include: { reservation: true, fulfillment: true },
      });
      expect(r.reservation.status).toBe("RELEASED");
      expect(r.fulfillment?.status ?? "CANCELLED").toBe("CANCELLED");
      expect(
        await db.inventoryMovement.count({
          where: { merchandiseItemId: f.item.id },
        }),
      ).toBe(1);
      await expect(
        claimGachaReward(db, f.user.token, {
          rewardId: f.rewardId,
          operationKey: randomUUID(),
          address: deliveryAddress,
        }),
      ).rejects.toThrow();
    },
  );
  it("unclaimed, inactive-location and missing-tracking dispatches fail atomically", async () => {
    const f = await awarded();
    await expect(
      fulfillment.transition({
        id: f.rewardId,
        action: "SHIPPED",
        reason: "Unclaimed",
      }),
    ).rejects.toMatchObject({ code: "CLAIM_REQUIRED" });
    await claimGachaReward(db, f.user.token, {
      rewardId: f.rewardId,
      operationKey: randomUUID(),
      address: deliveryAddress,
    });
    await fulfillment.transition({
      id: f.rewardId,
      action: "PREPARING",
      reason: "Pack",
    });
    await expect(
      fulfillment.transition({
        id: f.rewardId,
        action: "SHIPPED",
        reason: "Missing tracking",
      }),
    ).rejects.toMatchObject({ code: "TRACKING_REQUIRED" });
    await db.storageLocation.update({
      where: { id: f.location.id },
      data: { active: false },
    });
    await expect(
      fulfillment.transition({
        id: f.rewardId,
        action: "SHIPPED",
        carrier: "Carrier",
        trackingNumber: "T",
        reason: "Inactive",
      }),
    ).rejects.toMatchObject({ code: "LOCATION_UNAVAILABLE" });
    const r = await db.gachaReward.findUniqueOrThrow({
      where: { id: f.rewardId },
      include: {
        reservation: true,
        fulfillment: { include: { shipment: true } },
      },
    });
    expect(r.status).toBe("PREPARING");
    expect(r.reservation.status).toBe("CONFIRMED");
    expect(r.fulfillment?.shipment).toBeNull();
    expect(
      await db.inventoryMovement.count({
        where: { merchandiseItemId: f.item.id },
      }),
    ).toBe(1);
  });
  it("claim and queue authorization, ownership, address validation and CSRF", async () => {
    const f = await awarded(),
      other = await customer(),
      path = `rewards/${f.rewardId}/claim`,
      input = { operationKey: randomUUID(), address: deliveryAddress };
    expect((await request(path, "", input)).status).toBe(401);
    expect((await request(path, other.token, input)).status).toBe(404);
    expect(
      (
        await request(path, f.user.token, {
          ...input,
          address: { ...deliveryAddress, country: "JP" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(path, f.user.token, input, {
          origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);
    expect((await request(path, f.user.token, input)).status).toBe(200);
    await expect(
      createRewardFulfillmentService(db, async () => ({
        id: f.user.customer.id,
      })).transition({
        id: f.rewardId,
        action: "PREPARING",
        reason: "No admin",
      }),
    ).rejects.toThrow();
    await expect(
      createRewardFulfillmentQueries(db, async () => ({
        id: other.customer.id,
      })).list({}),
    ).rejects.toThrow();
    const queue = await createRewardFulfillmentQueries(db, authorize).list({
      status: "CLAIMED",
      q: f.user.customer.email,
    });
    expect(queue.items.map((r) => r.id)).toContain(f.rewardId);
  });
});
describe("customer gacha execution and ownership", () => {
  it("scopes the same client key to each customer and rejects expired authorizations", async () => {
    const f = await fixture(),
      other = await customer();
    await db.gachaAuthorization.create({
      data: {
        customerId: other.customer.id,
        bannerId: f.banner.id,
        operationKey: randomUUID(),
        maxPulls: 1,
        actorUserId: actorId,
        reason: "Expired fixture",
        createdAt: new Date(Date.now() - 7200000),
        expiresAt: new Date(Date.now() - 3600000),
      },
    });
    await expect(service.pull(other.token, f.input)).rejects.toMatchObject({
      code: "AUTHORIZATION_REQUIRED",
    });
    await allow(f.banner.id, other.customer.id);
    const first = await service.pull(f.user.token, f.input),
      second = await service.pull(other.token, f.input);
    expect(first.pullId).not.toBe(second.pullId);
    expect(
      await service.recover(other.token, f.input.requestKey, true),
    ).toEqual(second);
  });
  it("administrator authorization retry is idempotent and cannot increase an immutable allowance", async () => {
    const f = await fixture(),
      input = {
        customerId: f.user.customer.id,
        bannerId: f.banner.id,
        maxPulls: 2,
        operationKey: randomUUID(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        reason: "Reviewed free authorization",
      };
    const first = await admin.authorize(input);
    expect((await admin.authorize(input)).id).toBe(first.id);
    await expect(
      admin.authorize({ ...input, maxPulls: 3 }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      db.gachaAuthorization.update({
        where: { id: first.id },
        data: { maxPulls: 100 },
      }),
    ).rejects.toThrow();
  });
  it("snapshots approved managed prize images without a listing, never source URLs; revoking approval stops image delivery", async () => {
    const f = await fixture(),
      image = await makePublicationReady(db, f.item.id);
    expect(await getPublicImage(db, image.id)).toBeNull();
    const result = await service.pull(f.user.token, f.input);
    expect(result.prizes[0].image).toMatchObject({
      id: image.id,
      url: `/api/storefront/v1/images/${image.id}`,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_SOURCE|private-original|storageKey|originalUrl/,
    );
    expect(await getPublicImage(db, image.id)).not.toBeNull();
    await db.itemImage.update({
      where: { id: image.id },
      data: { approvedForPublicUse: false, caption: "Changed" },
    });
    expect(await getPublicImage(db, image.id)).toBeNull();
    expect(await service.recover(f.user.token, result.pullId)).toEqual(result);
  });
  it("executes existing secure engine, owns exact receipt and one physical reservation, with no costs or RNG in public data", async () => {
    const f = await fixture(),
      result = await service.pull(f.user.token, f.input);
    const pull = await db.gachaPull.findUniqueOrThrow({
      where: { id: result.pullId },
      include: { reward: true, reservation: true },
    });
    expect(pull.randomAlgorithm).toBe("node:crypto.randomInt/v1");
    expect(pull.actorUserId).toBeNull();
    expect(pull.customerId).toBe(f.user.customer.id);
    expect(pull.authorizationId).toBeTruthy();
    expect(pull.reward?.receipt).toEqual(result);
    expect(pull.reservation?.status).toBe("CONFIRMED");
    expect(pull.reward?.reservationId).toBe(pull.reservation?.id);
    expect(result.prizes[0]).toMatchObject({
      name: "レム / Rem",
      tier: "SR",
      rewardId: pull.reward!.id,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|random|weight|actor|operationKey|requestKey|cost|authorizationId|location/i,
    );
    expect(
      await db.inventoryMovement.count({
        where: { merchandiseItemId: f.item.id },
      }),
    ).toBe(1);
  });
  it("concurrent duplicate POSTs return the same receipt; request recovery and ID recovery never reroll, even after disabling", async () => {
    const f = await fixture(1),
      [one, two] = await Promise.all([
        service.pull(f.user.token, f.input),
        service.pull(f.user.token, f.input),
      ]);
    expect(one).toEqual(two);
    await admin.enable({
      bannerId: f.banner.id,
      enabled: false,
      reason: "Pause",
    });
    expect(
      await service.recover(f.user.token, f.input.requestKey, true),
    ).toEqual(one);
    expect(await service.recover(f.user.token, one.pullId)).toEqual(one);
    expect(await service.pull(f.user.token, f.input)).toEqual(one);
    expect(
      await db.gachaReward.count({ where: { customerId: f.user.customer.id } }),
    ).toBe(1);
    await expect(
      service.pull(f.user.token, { ...f.input, configurationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("one final physical unit across customers cannot be awarded twice", async () => {
    const f = await fixture(1),
      other = await customer();
    await allow(f.banner.id, other.customer.id);
    const results = await Promise.allSettled([
      service.pull(f.user.token, f.input),
      service.pull(other.token, { ...f.input, requestKey: randomUUID() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await db.gachaPull.count({ where: { bannerId: f.banner.id } })).toBe(
      1,
    );
    expect(
      await db.inventoryBalance.findUniqueOrThrow({
        where: {
          merchandiseItemId_storageLocationId: {
            merchandiseItemId: f.item.id,
            storageLocationId: f.location.id,
          },
        },
      }),
    ).toMatchObject({ quantity: 3 });
  });
  it("anonymous, admin session and another customer cannot access customer awards (IDOR)", async () => {
    const f = await fixture(),
      other = await customer(),
      result = await service.pull(f.user.token, f.input);
    for (const token of ["", actorId])
      expect((await request(`pulls/${result.pullId}`, token)).status).toBe(401);
    for (const path of [
      `pulls/${result.pullId}`,
      `requests/${f.input.requestKey}`,
      `rewards/${result.prizes[0].rewardId}`,
    ])
      expect((await request(path, other.token)).status).toBe(404);
    expect(
      (
        await request(`banners/${f.banner.id}/pulls`, "", {
          configurationId: f.banner.configurationId,
          requestKey: randomUUID(),
          count: 1,
        })
      ).status,
    ).toBe(401);
  });
  it.each([
    "paused",
    "future",
    "expired",
    "banner disabled",
    "global disabled",
    "draws disabled",
  ])("rejects %s without rewards", async (mode) => {
    const f = await fixture();
    if (mode === "paused")
      await db.gachaBanner.update({
        where: { id: f.banner.id },
        data: { active: false },
      });
    if (mode === "future")
      await db.gachaBanner.update({
        where: { id: f.banner.id },
        data: { startsAt: new Date(Date.now() + 3600000) },
      });
    if (mode === "expired")
      await db.gachaBanner.update({
        where: { id: f.banner.id },
        data: { endsAt: new Date(Date.now() - 1000) },
      });
    if (mode === "banner disabled")
      await admin.enable({
        bannerId: f.banner.id,
        enabled: false,
        reason: "Disabled",
      });
    if (mode === "global disabled")
      vi.stubEnv("GACHA_CUSTOMER_EXECUTION_ENABLED", "false");
    if (mode === "draws disabled") vi.stubEnv("GACHA_DRAWS_ENABLED", "false");
    expect((await service.eligibility(f.user.token, f.banner.id)).enabled).toBe(
      false,
    );
    await expect(service.pull(f.user.token, f.input)).rejects.toBeTruthy();
    expect(await db.gachaPull.count({ where: { bannerId: f.banner.id } })).toBe(
      0,
    );
  });
  it("enforces free authorization allowance and does not infer payment from Stripe checkout", async () => {
    const f = await fixture(),
      other = await customer();
    await expect(service.pull(other.token, f.input)).rejects.toMatchObject({
      code: "AUTHORIZATION_REQUIRED",
    });
    await allow(f.banner.id, other.customer.id, 1);
    await service.pull(other.token, f.input);
    await expect(
      service.pull(other.token, { ...f.input, requestKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    expect(
      (await service.eligibility(other.token, f.banner.id)).remaining,
    ).toBe(0);
  });
  it("requires configured verification and rejects disabled customers", async () => {
    const f = await fixture();
    // Policy B: gacha requires a verified address even though checkout does not.
    vi.stubEnv("CUSTOMER_VERIFICATION_POLICY", "gacha");
    await expect(service.pull(f.user.token, f.input)).rejects.toMatchObject({
      code: "EMAIL_VERIFICATION_REQUIRED",
    });
    await setCustomerDisabled(db, authorize, {
      id: f.user.customer.id,
      disabled: true,
    });
    await expect(service.pull(f.user.token, f.input)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("keeps the snapshot immutable after new odds, banner and catalog edits; stale odds cannot draw", async () => {
    const f = await fixture(),
      first = await service.pull(f.user.token, f.input);
    const next = await domain.configure({
      ...f.config,
      id: f.banner.id,
      expectedConfigurationId: f.banner.configurationId,
      name: "New banner",
      prizes: [
        { ...f.config.prizes[0], displayName: "Changed name", weight: 9 },
      ],
    });
    expect((await publicGachaOdds(db, f.config.slug))?.configurationId).toBe(
      next.configurationId,
    );
    await expect(
      service.pull(f.user.token, { ...f.input, requestKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
    expect(await service.recover(f.user.token, first.pullId)).toEqual(first);
    await expect(
      db.gachaReward.update({
        where: { id: first.prizes[0].rewardId },
        data: { receipt: { corrupt: true } },
      }),
    ).rejects.toThrow();
    await expect(
      db.gachaReward.delete({ where: { id: first.prizes[0].rewardId } }),
    ).rejects.toThrow();
  });
  it("history is paginated and reward status stays aligned with existing internal finalization", async () => {
    const f = await fixture(21);
    // Separate legitimate windows avoid testing the mutation throttle here.
    const receipts = [];
    for (let n = 0; n < 21; n++) {
      if (n === 20) await db.customerRateLimit.deleteMany();
      receipts.push(
        await service.pull(f.user.token, {
          ...f.input,
          requestKey: randomUUID(),
        }),
      );
    }
    const page = await service.history(f.user.token, 1),
      second = await service.history(f.user.token, 2);
    expect(page.items).toHaveLength(20);
    expect(second.items).toHaveLength(1);
    expect(page.pageInfo).toMatchObject({ total: 21, pageCount: 2 });
    await domain.finalize({
      pullId: receipts[0].pullId,
      action: "CANCEL",
      reason: "Customer cancellation",
    });
    const cancelled = await service.history(f.user.token, 1, "CANCELLED");
    expect(cancelled.items).toHaveLength(1);
    expect(
      (await service.reward(f.user.token, receipts[0].prizes[0].rewardId))
        .status,
    ).toBe("CANCELLED");
    expect(await service.recover(f.user.token, receipts[0].pullId)).toEqual(
      receipts[0],
    );
    await expect(
      domain.finalize({
        pullId: receipts[1].pullId,
        action: "CONSUME",
        reason: "Must use customer fulfillment",
      }),
    ).rejects.toMatchObject({ code: "USE_REWARD_QUEUE" });
  });
  it("rejects unsupported multi-pull, injected prize, excessive request body, untrusted gateway and CSRF", async () => {
    const f = await fixture(),
      path = `banners/${f.banner.id}/pulls`,
      input = {
        configurationId: f.banner.configurationId,
        count: 1,
        requestKey: randomUUID(),
      };
    expect(
      (await request(path, f.user.token, { ...input, count: 10 })).status,
    ).toBe(400);
    expect(
      (await request(path, f.user.token, { ...input, prizeId: randomUUID() }))
        .status,
    ).toBe(400);
    expect(
      (await request(path, f.user.token, { ...input, data: "x".repeat(5000) }))
        .status,
    ).toBe(409);
    expect(
      (
        await request(path, f.user.token, input, {
          origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(path, f.user.token, input, {
          "x-commerce-gateway-key": "invalid",
        })
      ).status,
    ).toBe(401);
    expect(await db.gachaPull.count({ where: { bannerId: f.banner.id } })).toBe(
      0,
    );
  });
  it("rate limits rejected mutations and protects internal enablement", async () => {
    const f = await fixture(),
      other = await customer();
    for (let n = 0; n < 20; n++)
      await expect(service.pull(other.token, f.input)).rejects.toMatchObject({
        code: "AUTHORIZATION_REQUIRED",
      });
    await expect(service.pull(other.token, f.input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await expect(
      createGachaCustomerAdmin(db, async () => ({
        id: f.user.customer.id,
      })).enable({ bannerId: f.banner.id, enabled: true, reason: "No admin" }),
    ).rejects.toThrow();
  });
});
