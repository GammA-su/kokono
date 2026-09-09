import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import Stripe from "stripe";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { createPublicationService } from "../src/modules/publication/service";
import { resolvePublicListings } from "../src/modules/publication/queries";
import {
  applyInventoryOperation,
  getOwnedQuantity,
} from "../src/modules/inventory/operations";
import {
  createCommerceService,
  createOrderAdminService,
  expireReservations,
} from "../src/modules/commerce/service";
import { createPaymentService } from "../src/modules/commerce/payments";
import { createOrderQueries } from "../src/modules/commerce/admin-queries";
import { createCommerceHandler } from "../src/modules/commerce/http";
import {
  addressSchema,
  includedVat,
  policySchema,
  quoteTotals,
} from "../src/modules/commerce/policy";
import {
  stripeProvider,
  type PaymentProvider,
  type VerifiedPaymentEvent,
} from "../src/modules/commerce/stripe";
import { makePublicationReady } from "./publication-fixture";
import { guardPgQueryConcurrency } from "./pg-query-guard";
import {
  createCustomerService,
  requireCustomer,
} from "../src/modules/customers/service";
guardPgQueryConcurrency();
const db = createDatabaseClient(inject("testDatabaseUrl"));
let actorId: string;
const authorize = async () => ({ id: actorId }),
  catalog = createCatalogService(db, authorize),
  locations = createLocationService(db, authorize),
  publication = createPublicationService(db, authorize),
  commerce = createCommerceService(db),
  admin = createOrderAdminService(db, authorize);
const token = () => randomBytes(32).toString("base64url");
const address = {
  name: "Test Customer",
  line1: "10 rue de Test",
  line2: "",
  city: "Paris",
  postalCode: "75001",
  country: "FR",
};
const provider: PaymentProvider = {
  create: vi.fn<PaymentProvider["create"]>(async (attempt) => ({
    sessionId: `cs_test_${attempt.id}`,
    url: `https://checkout.stripe.com/c/pay/${attempt.id}`,
  })),
  verify: async () => {
    throw new Error("Bad signature");
  },
  reconcile: async () => null,
  expire: vi.fn(async () => {}),
  refund: vi.fn<PaymentProvider["refund"]>(async (attempt) => ({
    id: `re_${attempt.id}`,
    event: {
      eventId: `refund_${attempt.id}`,
      attemptId: attempt.id,
      type: "REFUNDED",
      amount: attempt.amount,
      currency: "EUR",
      paymentIntentId: attempt.paymentIntentId,
      live: false,
    },
  })),
};
const payments = createPaymentService(db, provider);
beforeAll(async () => {
  actorId = (
    await db.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        name: "Order operator",
        isInternal: true,
      },
    })
  ).id;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
});
async function fixture(quantity = 3, price = 2490) {
  const key = randomUUID(),
    franchise = await catalog.createFranchise({ name: "Re:Zero", slug: key }),
    lineup = await catalog.createLineup({
      name: "Marine",
      slug: key,
      franchiseId: franchise.id,
      releaseDate: "2026-11",
    }),
    category = await catalog.createCategory({ name: "Acrylic", slug: key });
  const item = await catalog.createItem({
    name: "Rem Stand",
    japaneseName: "レム アクリルスタンド",
    slug: key,
    internalSku: key,
    lineupId: lineup.id,
    categoryId: category.id,
    privateNotes: "SECRET_COST_NOTES",
  });
  const image = await makePublicationReady(db, item.id),
    fresh = await db.merchandiseItem.findUniqueOrThrow({
      where: { id: item.id },
    });
  const listing = await publication.publishReviewed({
    expectedItemUpdatedAt: fresh.updatedAt.toISOString(),
    expectedListingUpdatedAt: null,
    listing: {
      merchandiseItemId: item.id,
      slug: key,
      publicTitle: "Rem public stand",
      sellingPriceAmount: price,
      sellingPriceCurrency: "EUR",
      sellingPriceTaxInclusion: "INCLUDED",
      imageIds: [image.id],
    },
  });
  const fr = await locations.create({
      code: `FR-${key}`,
      name: "France box",
      type: "FRANCE_HOME",
      countryCode: "FR",
      fulfillmentEnabled: true,
    }),
    jp = await locations.create({
      code: `JP-${key}`,
      name: "Japan box",
      type: "JAPAN_WAREHOUSE",
      countryCode: "JP",
    });
  await receive(item.id, fr.id, quantity);
  await receive(item.id, jp.id, 10);
  return { item, listing, fr, jp };
}
async function receive(item: string, location: string, quantity: number) {
  return applyInventoryOperation(
    db,
    {
      merchandiseItemId: item,
      destinationLocationId: location,
      quantityDelta: quantity,
      movementType: "PURCHASE",
      operationKey: randomUUID(),
    },
    actorId,
  );
}
function request(listingId: string, quantity = 1) {
  return {
    lines: [{ listingId, quantity }],
    contact: { email: "customer@example.test" },
    shippingAddress: address,
  };
}
async function reserve(
  f: Awaited<ReturnType<typeof fixture>>,
  quantity = 1,
  owner = token(),
) {
  const quote = await commerce.quote(owner, request(f.listing.id, quantity)),
    operationKey = randomUUID();
  const result = await commerce.checkout(owner, {
    quoteId: quote.id,
    operationKey,
    accepted: true,
  });
  if (result.kind !== "order") throw new Error("Unexpected price change");
  return { owner, quote, operationKey, order: result.order };
}
async function paid(
  orderId: string,
  owner: string,
  patch: Partial<VerifiedPaymentEvent> = {},
) {
  await payments.start(owner, orderId);
  const attempt = await db.paymentAttempt.findUniqueOrThrow({
    where: { orderId },
  });
  const event: VerifiedPaymentEvent = {
    eventId: `evt_${randomUUID()}`,
    attemptId: attempt.id,
    type: "PAID",
    amount: attempt.amount,
    currency: "EUR",
    paymentIntentId: `pi_${attempt.id}`,
    sessionId: attempt.providerSessionId!,
    live: false,
    ...patch,
  };
  await payments.applyVerifiedEvent(event);
  return event;
}
describe("TTC policy", () => {
  it("extracts included VAT and applies shipping threshold without adding tax twice", () => {
    expect(includedVat(2490, 2000)).toBe(415);
    expect(includedVat(590, 2000)).toBe(98);
    for (const [subtotal, shipping, total] of [
      [7400, 590, 7990],
      [7999, 590, 8589],
      [8000, 0, 8000],
      [8400, 0, 8400],
    ]) {
      const quote = quoteTotals(
        [
          {
            listingId: randomUUID(),
            merchandiseItemId: randomUUID(),
            title: "Item",
            quantity: 1,
            unitPriceAmount: subtotal,
            currency: "EUR",
            taxRateBps: 2000,
            taxAmount: includedVat(subtotal, 2000),
            totalAmount: subtotal,
          },
        ],
        policySchema.parse({}),
      );
      expect(quote.shippingAmount).toBe(shipping);
      expect(quote.totalAmount).toBe(total);
      expect(quote.taxAmount).toBe(
        includedVat(subtotal, 2000) + includedVat(shipping, 2000),
      );
    }
  });
  it("rejects overseas, Corsica and non-France addresses", () => {
    for (const patch of [
      { postalCode: "97100" },
      { postalCode: "20000" },
      { postalCode: "98000" },
      { country: "BE" },
    ])
      expect(addressSchema.safeParse({ ...address, ...patch }).success).toBe(
        false,
      );
    expect(addressSchema.safeParse(address).success).toBe(true);
  });
});
describe("authoritative checkout and reservations", () => {
  it("reserves only France, excludes reserved units publicly, preserves physical stock and snapshots", async () => {
    const f = await fixture(),
      r = await reserve(f, 2);
    expect(r.quote.totalAmount).toBe(5570);
    expect(r.quote.taxAmount).toBe(928);
    const allocations = await db.inventoryReservation.findMany({
      where: { orderItem: { orderId: r.order.id } },
    });
    expect(
      allocations.map((a) => [a.storageLocationId, a.quantity, a.status]),
    ).toEqual([[f.fr.id, 2, "HELD"]]);
    expect(await getOwnedQuantity(db, f.item.id)).toBe(13);
    expect(
      (await resolvePublicListings(db, { listingIds: [f.listing.id] })).items[0]
        .availability.availableQuantity,
    ).toBe(1);
    await publication.setSellingPrice({
      merchandiseItemId: f.item.id,
      sellingPriceAmount: 5000,
      sellingPriceCurrency: "EUR",
    });
    expect(
      (await commerce.get(r.owner, r.order.id)).items[0].unitPriceAmount,
    ).toBe(2490);
    await expect(
      db.orderItem.updateMany({
        where: { orderId: r.order.id },
        data: { unitPriceAmount: 100 },
      }),
    ).rejects.toThrow();
    const serialized = JSON.stringify(await commerce.get(r.owner, r.order.id));
    for (const secret of [
      "SECRET_COST_NOTES",
      "storageLocationId",
      "guestHash",
      "acquisition",
      "paymentIntent",
      "actorUser",
    ])
      expect(serialized).not.toContain(secret);
  });
  it("requires explicit acceptance of a fresh quote after price changes", async () => {
    const f = await fixture(),
      owner = token(),
      quote = await commerce.quote(owner, request(f.listing.id));
    await publication.setSellingPrice({
      merchandiseItemId: f.item.id,
      sellingPriceAmount: 2700,
      sellingPriceCurrency: "EUR",
    });
    const result = await commerce.checkout(owner, {
      quoteId: quote.id,
      operationKey: randomUUID(),
      accepted: true,
    });
    expect(result.kind).toBe("quote_changed");
    expect(await db.order.count({ where: { quoteId: quote.id } })).toBe(0);
    if (result.kind === "quote_changed")
      expect(result.quote.lines[0].unitPriceAmount).toBe(2700);
  });
  it("makes retries idempotent and isolates guest orders and internal authorization", async () => {
    const f = await fixture(),
      r = await reserve(f),
      again = await commerce.checkout(r.owner, {
        quoteId: r.quote.id,
        operationKey: r.operationKey,
        accepted: true,
      });
    expect(again.kind === "order" && again.order.id).toBe(r.order.id);
    expect(await db.order.count({ where: { quoteId: r.quote.id } })).toBe(1);
    await expect(commerce.get(token(), r.order.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(commerce.cancel(token(), r.order.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const outsider = await db.user.create({
        data: {
          id: randomUUID(),
          name: "Guest",
          email: `${randomUUID()}@example.test`,
        },
      }),
      noAuth = async () => ({ id: outsider.id });
    await expect(
      createOrderAdminService(db, noAuth).transition({
        id: r.order.id,
        action: "CANCELLED",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createOrderQueries(db, noAuth).list({})).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
  });
  it("serializes concurrent orders for the last unit with one complete winner", async () => {
    const f = await fixture(1),
      a = token(),
      b = token(),
      qa = await commerce.quote(a, request(f.listing.id)),
      qb = await commerce.quote(b, request(f.listing.id));
    const result = await Promise.allSettled([
      commerce.checkout(a, {
        quoteId: qa.id,
        operationKey: randomUUID(),
        accepted: true,
      }),
      commerce.checkout(b, {
        quoteId: qb.id,
        operationKey: randomUUID(),
        accepted: true,
      }),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.inventoryReservation.count({
        where: { merchandiseItemId: f.item.id, status: "HELD" },
      }),
    ).toBe(1);
    expect(await getOwnedQuantity(db, f.item.id)).toBe(11);
  });
  it("rolls back the complete multi-item checkout when a later item is unavailable", async () => {
    const a = await fixture(1),
      b = await fixture(1),
      owner = token(),
      quote = await commerce.quote(owner, {
        ...request(a.listing.id),
        lines: [
          { listingId: a.listing.id, quantity: 1 },
          { listingId: b.listing.id, quantity: 1 },
        ],
      });
    await reserve(b);
    await expect(
      commerce.checkout(owner, {
        quoteId: quote.id,
        operationKey: randomUUID(),
        accepted: true,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(
      await db.inventoryReservation.count({
        where: { merchandiseItemId: a.item.id },
      }),
    ).toBe(0);
  });
  it("protects reserved stock in every outgoing ledger command and releases on cancellation", async () => {
    const f = await fixture(1),
      r = await reserve(f);
    for (const type of [
      "SALE",
      "DAMAGED",
      "LOST",
      "GIFT",
      "GACHA",
      "RETURN",
      "ADJUSTMENT",
      "OTHER",
      "TRANSFER",
    ])
      await expect(
        applyInventoryOperation(
          db,
          {
            merchandiseItemId: f.item.id,
            sourceLocationId: f.fr.id,
            ...(type === "TRANSFER" ? { destinationLocationId: f.jp.id } : {}),
            quantityDelta: type === "TRANSFER" ? 1 : -1,
            movementType: type,
            notes: "Test stock protection",
            operationKey: randomUUID(),
          },
          actorId,
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    await commerce.cancel(r.owner, r.order.id);
    await commerce.cancel(r.owner, r.order.id);
    expect(
      (await resolvePublicListings(db, { listingIds: [f.listing.id] })).items[0]
        .availability.availableQuantity,
    ).toBe(1);
  });
  it("rejects tampered browser prices and mixed currencies or unconfirmed tax", async () => {
    const f = await fixture(),
      owner = token();
    await expect(
      commerce.quote(owner, { ...request(f.listing.id), totalAmount: 1 }),
    ).rejects.toThrow();
    await db.saleListing.update({
      where: { id: f.listing.id },
      data: { sellingPriceCurrency: "JPY" },
    });
    await expect(
      commerce.quote(owner, request(f.listing.id)),
    ).rejects.toMatchObject({ code: "CURRENCY_UNSUPPORTED" });
    await db.saleListing.update({
      where: { id: f.listing.id },
      data: {
        sellingPriceCurrency: "EUR",
        sellingPriceTaxInclusion: "UNKNOWN",
      },
    });
    await expect(
      commerce.quote(owner, request(f.listing.id)),
    ).rejects.toMatchObject({ code: "TAX_UNCONFIRMED" });
  });
});
describe("payments, dispatch and refund", () => {
  it("does not mistake a charge refund notification for successful settlement of a pending refund", async () => {
    vi.stubEnv("COMMERCE_TEST_CHECKOUT_ENABLED", "true");
    vi.stubEnv("COMMERCE_GATEWAY_SECRET", "test-gateway-secret-at-least-32-characters");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixture");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_fixture");
    vi.stubEnv("STOREFRONT_BASE_URL", "http://localhost:5173");
    try {
      const stripe = new Stripe("sk_test_fixture"),
        attemptId = randomUUID();
      vi.spyOn(stripe.paymentIntents, "retrieve").mockResolvedValue({
        id: "pi_refund",
        metadata: { attemptId },
        livemode: false,
      } as unknown as Stripe.Response<Stripe.PaymentIntent>);
      const refunds = vi.spyOn(stripe.refunds, "list").mockResolvedValue({
        data: [
          {
            id: "re_pending",
            amount: 3080,
            currency: "eur",
            status: "pending",
          },
        ],
        has_more: false,
      } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Refund>>);
      const adapter = stripeProvider(stripe),
        body = JSON.stringify({
          id: "evt_charge_refund",
          type: "charge.refunded",
          livemode: false,
          data: {
            object: {
              id: "ch_refund",
              payment_intent: "pi_refund",
              amount_refunded: 3080,
              currency: "eur",
              livemode: false,
            },
          },
        }),
        signature = stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: "whsec_fixture",
        });
      expect(await adapter.verify(body, signature)).toBeNull();
      refunds.mockResolvedValue({
        data: [
          { id: "re_done", amount: 3080, currency: "eur", status: "succeeded" },
        ],
        has_more: false,
      } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Refund>>);
      expect(await adapter.verify(body, signature)).toMatchObject({
        type: "REFUNDED",
        amount: 3080,
        attemptId,
      });
      vi.spyOn(stripe.refunds, "retrieve").mockResolvedValue({
        id: "re_done",
        payment_intent: "pi_refund",
        metadata: { attemptId },
        currency: "eur",
        amount: 3080,
        status: "succeeded",
      } as unknown as Stripe.Response<Stripe.Refund>);
      const older = JSON.stringify({
        id: "evt_old_refund",
        type: "refund.failed",
        livemode: false,
        data: { object: { id: "re_done", status: "failed" } },
      });
      expect(
        await adapter.verify(
          older,
          stripe.webhooks.generateTestHeaderString({
            payload: older,
            secret: "whsec_fixture",
          }),
        ),
      ).toMatchObject({ type: "REFUNDED", amount: 3080 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("releases failed payments and reconciles a refund whose network response was lost", async () => {
    const f = await fixture(),
      r = await reserve(f);
    await payments.start(r.owner, r.order.id);
    const attempt = await db.paymentAttempt.findUniqueOrThrow({
      where: { orderId: r.order.id },
    });
    await payments.applyVerifiedEvent({
      eventId: randomUUID(),
      attemptId: attempt.id,
      type: "FAILED",
      amount: attempt.amount,
      currency: "EUR",
      paymentIntentId: null,
      sessionId: attempt.providerSessionId!,
      live: false,
    });
    expect((await commerce.get(r.owner, r.order.id)).paymentStatus).toBe(
      "FAILED",
    );
    expect(
      (await resolvePublicListings(db, { listingIds: [f.listing.id] })).items[0]
        .availability.availableQuantity,
    ).toBe(3);
    const next = await reserve(f),
      paidEvent = await paid(next.order.id, next.owner);
    const failedResponse = createPaymentService(db, {
      ...provider,
      refund: async () => {
        throw new Error("Refund response lost");
      },
    });
    await expect(
      failedResponse.refund(next.order.id, authorize),
    ).rejects.toThrow("Refund response lost");
    let duplicateRefund = false;
    const reconcile = createPaymentService(db, {
      ...provider,
      reconcile: async (row) =>
        row.orderId === next.order.id
          ? { ...paidEvent, eventId: randomUUID(), type: "REFUNDED" }
          : null,
      refund: async (row) => {
        if (row.orderId === next.order.id) duplicateRefund = true;
        return provider.refund(row);
      },
    });
    await reconcile.reconcile(1000);
    expect(duplicateRefund).toBe(false);
    expect((await commerce.get(next.owner, next.order.id)).paymentStatus).toBe(
      "REFUNDED",
    );
    expect(await getOwnedQuantity(db, f.item.id)).toBe(13);
    await payments.applyVerifiedEvent({
      ...paidEvent,
      eventId: randomUUID(),
      type: "REFUND_FAILED",
    });
    expect((await commerce.get(next.owner, next.order.id)).paymentStatus).toBe(
      "REVIEW",
    );
    expect(await getOwnedQuantity(db, f.item.id)).toBe(13);
  });
  it("retains partial refund facts without treating them as a full refund or releasing a paid allocation", async () => {
    const f = await fixture(),
      r = await reserve(f),
      event = await paid(r.order.id, r.owner);
    await payments.applyVerifiedEvent({
      ...event,
      eventId: randomUUID(),
      type: "REFUNDED",
      amount: 100,
    });
    let order = await commerce.get(r.owner, r.order.id);
    expect(order.status).toBe("PAID");
    expect(order.paymentStatus).toBe("REVIEW");
    expect(order.refundedAmount).toBe(100);
    await payments.applyVerifiedEvent({ ...event, eventId: randomUUID() });
    order = await commerce.get(r.owner, r.order.id);
    expect(order.paymentStatus).toBe("REVIEW");
    expect(order.status).toBe("PAID");
    expect(
      await db.inventoryReservation.count({
        where: { orderItem: { orderId: r.order.id }, status: "CONFIRMED" },
      }),
    ).toBe(1);
    await expect(payments.refund(r.order.id, authorize)).rejects.toMatchObject({
      code: "PARTIAL_REFUND_UNSUPPORTED",
    });
  });
  it("reuses a durable payment attempt after a network failure and handles cancellation during session creation", async () => {
    const f = await fixture(),
      r = await reserve(f);
    let calls = 0;
    const attempts: string[] = [];
    const flaky = createPaymentService(db, {
      ...provider,
      create: async (attempt, order) => {
        attempts.push(attempt.id);
        if (++calls === 1) throw new Error("Connection lost");
        return provider.create(attempt, order);
      },
    });
    await expect(flaky.start(r.owner, r.order.id)).rejects.toThrow(
      "Connection lost",
    );
    const first = await flaky.start(r.owner, r.order.id),
      second = await flaky.start(r.owner, r.order.id);
    expect(first).toEqual(second);
    expect(new Set(attempts).size).toBe(1);
    expect(
      await db.paymentAttempt.count({ where: { orderId: r.order.id } }),
    ).toBe(1);
    const next = await reserve(f),
      cancelling = createPaymentService(db, {
        ...provider,
        create: async (attempt, order) => {
          await commerce.cancel(next.owner, next.order.id);
          return provider.create(attempt, order);
        },
      });
    await expect(
      cancelling.start(next.owner, next.order.id),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PAYABLE" });
    expect((await commerce.get(next.owner, next.order.id)).status).toBe(
      "CANCELLED",
    );
  });
  it("dispatches across multiple France locations once per allocation and excludes transit", async () => {
    const f = await fixture(1),
      box = await locations.create({
        code: randomUUID(),
        name: "Second France box",
        type: "BOX",
        parentId: f.fr.id,
        fulfillmentEnabled: true,
      }),
      transit = await locations.create({
        code: randomUUID(),
        name: "Transit",
        type: "IN_TRANSIT",
      });
    await receive(f.item.id, box.id, 2);
    await receive(f.item.id, transit.id, 7);
    const r = await reserve(f, 3);
    await paid(r.order.id, r.owner);
    await admin.transition({
      id: r.order.id,
      action: "SHIPPED",
      carrier: "Test carrier",
      trackingNumber: "MULTI",
    });
    expect(
      await db.inventoryMovement.count({
        where: {
          referenceType: "ORDER",
          referenceId: r.order.id,
          movementType: "SALE",
        },
      }),
    ).toBe(2);
    expect(await getOwnedQuantity(db, f.item.id)).toBe(17);
    expect(
      (await resolvePublicListings(db, { listingIds: [f.listing.id] })).items[0]
        .availability.availableQuantity,
    ).toBe(0);
  });
  it("confirms signed-provider facts only once, then dispatches once through the SALE ledger", async () => {
    const f = await fixture(),
      r = await reserve(f, 2),
      event = await paid(r.order.id, r.owner);
    await payments.applyVerifiedEvent(event);
    await payments.applyVerifiedEvent({
      ...event,
      eventId: "repeat_" + randomUUID(),
    });
    expect((await commerce.get(r.owner, r.order.id)).status).toBe("PAID");
    expect(await getOwnedQuantity(db, f.item.id)).toBe(13);
    await admin.transition({ id: r.order.id, action: "PREPARING" });
    const command = {
      id: r.order.id,
      action: "SHIPPED",
      carrier: "Actual test carrier",
      trackingNumber: "TEST-1",
    };
    await admin.transition(command);
    await admin.transition(command);
    expect(await getOwnedQuantity(db, f.item.id)).toBe(11);
    expect(
      await db.inventoryMovement.count({
        where: {
          referenceType: "ORDER",
          referenceId: r.order.id,
          movementType: "SALE",
        },
      }),
    ).toBe(1);
    await admin.transition({ id: r.order.id, action: "DELIVERED" });
    expect(
      (await commerce.get(r.owner, r.order.id)).shipment?.deliveredAt,
    ).toBeTruthy();
    await payments.refund(r.order.id, authorize);
    expect((await commerce.get(r.owner, r.order.id)).status).toBe("REFUNDED");
    expect(await getOwnedQuantity(db, f.item.id)).toBe(11);
  });
  it("releases a paid cancellation and refunds without a stock movement", async () => {
    const f = await fixture(1),
      r = await reserve(f);
    await paid(r.order.id, r.owner);
    await admin.transition({ id: r.order.id, action: "CANCELLED" });
    expect((await commerce.get(r.owner, r.order.id)).paymentStatus).toBe(
      "REFUND_PENDING",
    );
    expect(
      (await resolvePublicListings(db, { listingIds: [f.listing.id] })).items[0]
        .availability.availableQuantity,
    ).toBe(1);
    await payments.refund(r.order.id, authorize);
    await payments.refund(r.order.id, authorize);
    expect(await getOwnedQuantity(db, f.item.id)).toBe(11);
  });
  it("quarantines late payment after cancellation and ignores out-of-order failure after payment", async () => {
    const f = await fixture(),
      r = await reserve(f);
    await payments.start(r.owner, r.order.id);
    await commerce.cancel(r.owner, r.order.id);
    const attempt = await db.paymentAttempt.findUniqueOrThrow({
      where: { orderId: r.order.id },
    });
    await payments.applyVerifiedEvent({
      eventId: randomUUID(),
      attemptId: attempt.id,
      type: "PAID",
      amount: attempt.amount,
      currency: "EUR",
      paymentIntentId: `pi_${attempt.id}`,
      sessionId: attempt.providerSessionId!,
      live: false,
    });
    expect((await commerce.get(r.owner, r.order.id)).paymentStatus).toBe(
      "REVIEW",
    );
    expect(
      await db.fulfillmentRequest.count({ where: { orderId: r.order.id } }),
    ).toBe(0);
    const next = await reserve(f),
      event = await paid(next.order.id, next.owner);
    await payments.applyVerifiedEvent({
      ...event,
      eventId: randomUUID(),
      type: "FAILED",
    });
    expect((await commerce.get(next.owner, next.order.id)).status).toBe("PAID");
  });
  it("rejects dispatch after a location becomes ineligible and never accepts partial shipping", async () => {
    const f = await fixture(),
      r = await reserve(f),
      event = await paid(r.order.id, r.owner);
    expect(event.type).toBe("PAID");
    await db.storageLocation.update({
      where: { id: f.fr.id },
      data: { active: false },
    });
    await expect(
      admin.transition({
        id: r.order.id,
        action: "SHIPPED",
        carrier: "Test",
        trackingNumber: "1",
      }),
    ).rejects.toMatchObject({ code: "ALLOCATION_INVALID" });
    expect(await getOwnedQuantity(db, f.item.id)).toBe(13);
    await expect(
      admin.transition({ id: r.order.id, action: "SHIPPED", quantity: 1 }),
    ).rejects.toThrow();
  });
  it("records provider mismatches for review and rejects forged webhooks", async () => {
    const f = await fixture(),
      r = await reserve(f);
    await paid(r.order.id, r.owner, { amount: 1 });
    expect((await commerce.get(r.owner, r.order.id)).paymentStatus).toBe(
      "REVIEW",
    );
    await expect(payments.webhook("{}", "forged")).rejects.toThrow();
  });
  it("expires abandoned reservations and ignores expired holds before cleanup", async () => {
    // A short policy is injected only for this test; production schema enforces Stripe-compatible windows.
    const fast = createCommerceService(db, () => ({
        ...policySchema.parse({}),
        reservationMinutes: 0.001,
      })),
      f = await fixture(1),
      owner = token(),
      quote = await fast.quote(owner, request(f.listing.id));
    const result = await fast.checkout(owner, {
      quoteId: quote.id,
      operationKey: randomUUID(),
      accepted: true,
    });
    expect(result.kind).toBe("order");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      (await resolvePublicListings(db, { listingIds: [f.listing.id] })).items[0]
        .availability.availableQuantity,
    ).toBe(1);
    expect(await expireReservations(db)).toBeGreaterThan(0);
    if (result.kind === "order")
      expect((await commerce.get(owner, result.order.id)).status).toBe(
        "CANCELLED",
      );
  });
  it("validates actual Stripe test webhook signatures without network access", async () => {
    vi.stubEnv("COMMERCE_TEST_CHECKOUT_ENABLED", "true");
    vi.stubEnv("COMMERCE_GATEWAY_SECRET", "test-gateway-secret-at-least-32-characters");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixture");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_fixture");
    vi.stubEnv("STOREFRONT_BASE_URL", "http://localhost:5173");
    const stripe = new Stripe("sk_test_fixture"),
      p = stripeProvider(),
      event = {
        id: "evt_signed",
        type: "checkout.session.completed",
        livemode: false,
        data: {
          object: {
            id: "cs_test_signed",
            mode: "payment",
            metadata: { attemptId: randomUUID() },
            payment_status: "paid",
            status: "complete",
            amount_total: 3080,
            currency: "eur",
            payment_intent: "pi_test",
            livemode: false,
          },
        },
      },
      body = JSON.stringify(event),
      signature = stripe.webhooks.generateTestHeaderString({
        payload: body,
        secret: "whsec_fixture",
      });
    expect((await p.verify(body, signature))?.amount).toBe(3080);
    await expect(p.verify(body + " ", signature)).rejects.toThrow();
    vi.unstubAllEnvs();
  });
  it("requires the website gateway, guest credential and exact origin for HTTP mutation", async () => {
    vi.stubEnv("COMMERCE_GATEWAY_SECRET", "test-gateway-secret-at-least-32-characters");
    vi.stubEnv("STOREFRONT_BASE_URL", "http://localhost:5173");
    const handler = createCommerceHandler(db);
    expect(
      (
        await handler(new Request("http://localhost/api/commerce/v1/config"), [
          "config",
        ])
      ).status,
    ).toBe(401);
    const response = await handler(
      new Request("http://localhost/api/commerce/v1/quote", {
        method: "POST",
        headers: {
          "x-commerce-gateway-key": "test-gateway-secret-at-least-32-characters",
          origin: "https://attacker.test",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      ["quote"],
    );
    expect(response.status).toBe(403);
    vi.unstubAllEnvs();
  });
});

it("links new checkout to durable customers and isolates account order history across sessions", async () => {
  const customers = createCustomerService(db),
    password = "Customer-test-password-2026";
  const a = await customers.register({
      email: `${randomUUID()}@example.test`,
      password,
    }),
    b = await customers.register({
      email: `${randomUUID()}@example.test`,
      password,
    });
  const ac = await requireCustomer(db, a.token),
    bc = await requireCustomer(db, b.token),
    f = await fixture();
  const quote = await commerce.quote(ac.commerceKey, request(f.listing.id));
  const result = await commerce.checkout(
    ac.commerceKey,
    { quoteId: quote.id, operationKey: randomUUID(), accepted: true },
    a.token,
  );
  expect(result.kind).toBe("order");
  if (result.kind !== "order") throw new Error("Expected order");
  expect(
    (await db.order.findUniqueOrThrow({ where: { id: result.order.id } }))
      .customerId,
  ).toBe(ac.id);
  await expect(
    commerce.get(bc.commerceKey, result.order.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await customers.orders(b.token, 1)).items).toHaveLength(0);
  expect((await customers.orders(a.token, 1)).items.map((o) => o.id)).toContain(
    result.order.id,
  );
  await customers.logout(a.token);
  const again = await customers.login({ email: a.customer.email, password });
  expect((await customers.orders(again.token, 1)).items[0].id).toBe(
    result.order.id,
  );
  await expect(
    db.order.update({
      where: { id: result.order.id },
      data: { customerId: bc.id },
    }),
  ).rejects.toThrow();
  await expect(
    commerce.checkout(
      ac.commerceKey,
      { quoteId: quote.id, operationKey: randomUUID(), accepted: true },
      b.token,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
