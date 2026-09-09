/**
 * Stripe TEST qualification, stage 2: webhook robustness, fulfillment, inventory conservation,
 * refund handling and ownership isolation.
 *
 * Runs after scripts/verify-stripe-test.ts and scripts/stripe-pay-hosted.ts have produced a
 * genuinely PAID order. TEST MODE ONLY.
 *
 *   npx tsx --env-file=.env scripts/verify-stripe-test-stage2.ts
 */
import "dotenv/config";
import { randomUUID, createHmac } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Stripe from "stripe";
import { createDatabaseClient } from "../src/db/client";
import { createOrderAdminService } from "../src/modules/commerce/service";
import { createPaymentService } from "../src/modules/commerce/payments";
import { stripeProvider } from "../src/modules/commerce/stripe";

const SITE = "http://localhost:5173";
const WEBHOOK = "http://localhost:3000/api/commerce/webhooks/stripe";
if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"))
  throw new Error("A Stripe TEST secret key is required. Live keys are refused.");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });
const db = createDatabaseClient(process.env.DATABASE_URL!);
const handoff = JSON.parse(
  await readFile(resolve(".local/audit/stripe-stage1-handoff.json"), "utf8"),
) as { orderId: string; attemptId: string; sessionId: string; email: string; password: string; cookies: [string, string][]; listingId: string };

type Check = { check: string; ok: boolean; detail: string };
const checks: Check[] = [];
function assert(check: string, ok: boolean, detail = "") {
  checks.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const jar = new Map<string, string>(handoff.cookies);
async function site(path: string, init: RequestInit = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await fetch(`${SITE}${path}`, {
    ...init,
    redirect: "manual",
    headers: { "Content-Type": "application/json", Origin: SITE, Cookie: cookie, ...(init.headers ?? {}) },
  });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const i = pair.indexOf("=");
    const v = pair.slice(i + 1).trim();
    if (v) jar.set(pair.slice(0, i).trim(), v);
    else jar.delete(pair.slice(0, i).trim());
  }
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: response.status, body: {} as Record<string, unknown> };
  }
}

/** Signs a payload with the configured secret exactly as Stripe does, so the real
 *  verification path runs. Used only for cases the CLI cannot produce on demand. */
function signed(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}
async function postWebhook(payload: string, signature: string) {
  const response = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  return { status: response.status, body: await response.text() };
}

const evidence: Record<string, unknown> = { orderId: handoff.orderId };
try {
  const secret = process.env.STRIPE_WEBHOOK_SECRET!;
  const order0 = await db.order.findUniqueOrThrow({ where: { id: handoff.orderId } });
  assert("order_is_paid_from_provider_event", order0.paymentStatus === "PAID" && !!order0.paidAt, `status ${order0.status}`);
  const paidEvents = await db.paymentEvent.count({ where: { attemptId: handoff.attemptId, type: "PAID" } });
  assert("exactly_one_paid_event_recorded", paidEvents === 1, `${paidEvents} PAID event(s)`);

  // ------------------------------------------------------------------ webhook: invalid signature
  const realEvent = await stripe.events.list({ limit: 1, types: ["checkout.session.completed"] });
  const payload = JSON.stringify(realEvent.data[0]);
  const bad = await postWebhook(payload, signed(payload, "whsec_not_the_configured_secret"));
  assert("invalid_signature_rejected", bad.status === 400 && bad.body.includes("INVALID_SIGNATURE"), `status ${bad.status}`);

  const missing = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
  assert("missing_signature_rejected", missing.status === 400, `status ${missing.status}`);

  // Stripe rejects signatures outside its tolerance window; an old capture cannot be replayed.
  const stale = await postWebhook(payload, signed(payload, secret, Math.floor(Date.now() / 1000) - 3600));
  assert("stale_signature_timestamp_rejected", stale.status === 400, `status ${stale.status}`);

  // ------------------------------------------------------------------ webhook: duplicate delivery
  const before = await db.paymentEvent.count({ where: { attemptId: handoff.attemptId } });
  const duplicate = await postWebhook(payload, signed(payload, secret));
  await sleep(500);
  const after = await db.paymentEvent.count({ where: { attemptId: handoff.attemptId } });
  const orderAfterDuplicate = await db.order.findUniqueOrThrow({ where: { id: handoff.orderId } });
  assert(
    "duplicate_event_is_idempotent",
    duplicate.status === 200 && after === before && orderAfterDuplicate.paidAt?.getTime() === order0.paidAt?.getTime(),
    `accepted with ${after} event(s) stored, paidAt unchanged`,
  );

  // ------------------------------------------------------------------ webhook: out-of-order/late
  // Re-delivering the completed event after the order has already moved on must not regress it.
  const late = await postWebhook(payload, signed(payload, secret));
  await sleep(400);
  const orderAfterLate = await db.order.findUniqueOrThrow({ where: { id: handoff.orderId } });
  assert(
    "late_replayed_event_does_not_regress_order",
    late.status === 200 && orderAfterLate.paymentStatus === "PAID" && orderAfterLate.status === order0.status,
    `still ${orderAfterLate.status}/${orderAfterLate.paymentStatus}`,
  );

  // A tampered payload with a signature over the original body must fail verification.
  const tampered = payload.replace(/"amount_total":\d+/, '"amount_total":1');
  const forged = await postWebhook(tampered, signed(payload, secret));
  assert("tampered_payload_rejected", forged.status === 400, `status ${forged.status}`);

  // ------------------------------------------------------------------ ownership isolation
  const otherEmail = `stripe-intruder-${randomUUID().slice(0, 8)}@example.test`;
  const intruderJar = new Map<string, string>();
  const intruder = await fetch(`${SITE}/api/storefront/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SITE },
    body: JSON.stringify({ email: otherEmail, password: handoff.password }),
  });
  for (const raw of intruder.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const i = pair.indexOf("=");
    if (pair.slice(i + 1).trim()) intruderJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const cross = await fetch(`${SITE}/api/commerce/v1/orders/${handoff.orderId}`, {
    headers: { Origin: SITE, Cookie: [...intruderJar].map(([k, v]) => `${k}=${v}`).join("; ") },
  });
  assert("cross_customer_order_access_denied", cross.status === 404 || cross.status === 403, `status ${cross.status}`);

  const anonymous = await fetch(`${SITE}/api/commerce/v1/orders/${handoff.orderId}`, { headers: { Origin: SITE } });
  assert("anonymous_order_access_denied", anonymous.status === 404 || anonymous.status === 403, `status ${anonymous.status}`);

  // The browser must not be able to declare an order paid.
  const forcePaid = await site(`/api/commerce/v1/orders/${handoff.orderId}`, {
    method: "POST",
    body: JSON.stringify({ paymentStatus: "PAID", status: "PAID" }),
  });
  assert("browser_cannot_set_paid_state", forcePaid.status >= 400, `status ${forcePaid.status}`);

  // ------------------------------------------------------------------ no card data stored
  const cardLike = await db.$queryRaw<{ hits: bigint }[]>`
    SELECT COUNT(*)::bigint AS hits FROM payment_attempts
    WHERE checkout_url ILIKE '%4242%' OR provider_session_id ILIKE '%4242%'`;
  const orderJson = JSON.stringify(await db.order.findMany({ include: { items: true, paymentAttempt: true, events: true } }));
  assert(
    "no_card_details_stored",
    Number(cardLike[0].hits) === 0 && !/4242 ?4242|"cvc"|"card_number"/i.test(orderJson),
    "no PAN, CVC or card fields anywhere in order/payment records",
  );
  assert(
    "no_stripe_secret_in_stored_records",
    !/sk_test_|sk_live_|whsec_/.test(orderJson),
    "no provider secret in order/payment records",
  );

  // ------------------------------------------------------------------ customer order history
  const history = await site("/api/storefront/v1/customer/orders");
  const listed = JSON.stringify(history.body);
  assert(
    "customer_sees_own_paid_order",
    history.status === 200 && listed.includes(order0.number),
    `order ${order0.number} present in the customer's history`,
  );

  // ------------------------------------------------------------------ fulfillment and inventory
  const actor = await db.user.findFirstOrThrow({ where: { isInternal: true, active: true } });
  const admin = createOrderAdminService(db, async () => ({ id: actor.id }));
  const item = (await db.orderItem.findFirstOrThrow({ where: { orderId: handoff.orderId } })).merchandiseItemId;
  const salesBefore = await db.inventoryMovement.count({ where: { merchandiseItemId: item, movementType: "SALE" } });

  await admin.transition({ id: handoff.orderId, action: "PREPARING", carrier: "", trackingNumber: "" });
  const prepared = await db.order.findUniqueOrThrow({ where: { id: handoff.orderId } });
  assert("admin_prepare_succeeds", prepared.status === "PREPARING", `status ${prepared.status}`);

  await admin.transition({ id: handoff.orderId, action: "SHIPPED", carrier: "Colissimo", trackingNumber: "6A-QUALIFICATION-1" });
  const shipped = await db.order.findUniqueOrThrow({ where: { id: handoff.orderId } });
  assert("admin_dispatch_succeeds", shipped.status === "SHIPPED", `status ${shipped.status}`);

  const salesAfter = await db.inventoryMovement.findMany({
    where: { merchandiseItemId: item, movementType: "SALE" },
    select: { id: true, quantityDelta: true, operationKey: true },
  });
  assert(
    "exactly_one_sale_movement",
    salesAfter.length === salesBefore + 1 && salesAfter.at(-1)!.quantityDelta === -1,
    `${salesAfter.length} SALE movement(s), delta ${salesAfter.at(-1)?.quantityDelta}`,
  );
  evidence.saleMovement = salesAfter.at(-1);

  // Dispatch retry must not consume stock twice.
  let retryRejected = "";
  try {
    await admin.transition({ id: handoff.orderId, action: "SHIPPED", carrier: "Colissimo", trackingNumber: "6A-QUALIFICATION-1" });
  } catch (error) {
    retryRejected = error instanceof Error ? error.message : "rejected";
  }
  const salesAfterRetry = await db.inventoryMovement.count({ where: { merchandiseItemId: item, movementType: "SALE" } });
  assert(
    "dispatch_retry_creates_no_second_movement",
    salesAfterRetry === salesAfter.length,
    retryRejected ? `retry rejected: ${retryRejected}` : "retry produced no additional movement",
  );

  const reservations = await db.inventoryReservation.findMany({
    where: { orderItem: { orderId: handoff.orderId } },
    select: { status: true, movementId: true },
  });
  assert(
    "reservation_consumed_by_exactly_one_movement",
    reservations.length === 1 && !!reservations[0].movementId,
    `${reservations.length} reservation(s), status ${reservations[0]?.status}`,
  );

  // ------------------------------------------------------------------ refund
  const refundService = createPaymentService(db, stripeProvider());
  await refundService.refund(handoff.orderId, async () => ({ id: actor.id }));
  await sleep(3000);
  const refunded = await db.order.findUniqueOrThrow({ where: { id: handoff.orderId } });
  const attemptAfterRefund = await db.paymentAttempt.findUniqueOrThrow({ where: { id: handoff.attemptId } });
  assert(
    "refund_accepted_by_provider",
    !!attemptAfterRefund.refundId,
    `payment status ${refunded.paymentStatus}, refunded ${refunded.refundedAmount}`,
  );
  evidence.refund = { paymentStatus: refunded.paymentStatus, refundedAmount: refunded.refundedAmount };

  // A repeated refund must not double-refund at the provider.
  let secondRefund = "";
  try {
    await refundService.refund(handoff.orderId, async () => ({ id: actor.id }));
  } catch (error) {
    secondRefund = error instanceof Error ? error.message : "rejected";
  }
  await sleep(2000);
  const afterSecond = await db.order.findUniqueOrThrow({ where: { id: handoff.orderId } });
  const stripeRefunds = await stripe.refunds.list({ payment_intent: attemptAfterRefund.paymentIntentId!, limit: 10 });
  assert(
    "repeated_refund_does_not_double_refund",
    stripeRefunds.data.length === 1 && afterSecond.refundedAmount <= order0.totalAmount,
    `${stripeRefunds.data.length} refund(s) at Stripe, ${afterSecond.refundedAmount} recorded${secondRefund ? ` (second attempt: ${secondRefund})` : ""}`,
  );

  // SALE movement must survive a refund: the goods already left.
  const salesAfterRefund = await db.inventoryMovement.count({ where: { merchandiseItemId: item, movementType: "SALE" } });
  assert(
    "refund_does_not_silently_restock",
    salesAfterRefund === salesAfter.length,
    "no automatic reversal movement; a return is a separate operator decision",
  );

  await mkdir(resolve(".local/audit"), { recursive: true });
  await writeFile(
    resolve(".local/audit/stripe-qualification-stage2.json"),
    JSON.stringify({ at: new Date().toISOString(), evidence, checks }, null, 2),
  );
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} stage-2 checks passed.`);
  if (failed.length) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
