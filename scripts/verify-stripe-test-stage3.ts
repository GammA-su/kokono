/**
 * Stripe TEST qualification, stage 3: session expiry, declined payment and recovery when the
 * webhook never arrives. TEST MODE ONLY.
 *
 *   npx tsx --env-file=.env scripts/verify-stripe-test-stage3.ts --slug <fixture-slug> --case <name>
 *
 * Cases: expired | declined | reconcile
 * Each case is separate because `reconcile` requires the webhook listener to be stopped.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Stripe from "stripe";
import { createDatabaseClient } from "../src/db/client";

const SITE = "http://localhost:5173";
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const slug = arg("slug");
const testCase = arg("case");
if (!slug) throw new Error("Pass --slug <listing slug>");
if (!["expired", "declined", "prepare-reconcile", "reconcile-verify", "reconcile"].includes(testCase ?? ""))
  throw new Error("Pass --case expired|declined|prepare-reconcile|reconcile-verify");
if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"))
  throw new Error("A Stripe TEST secret key is required. Live keys are refused.");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });
const db = createDatabaseClient(process.env.DATABASE_URL!);
const checks: { check: string; ok: boolean; detail: string }[] = [];
const assert = (check: string, ok: boolean, detail = "") => {
  checks.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const jar = new Map<string, string>();
async function site(path: string, init: RequestInit = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await fetch(`${SITE}${path}`, {
    ...init,
    redirect: "manual",
    headers: { "Content-Type": "application/json", Origin: SITE, ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) },
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

/** Fresh customer, quote, order and hosted session — the same path a real buyer takes. */
async function newPayableOrder() {
  const email = `stripe-${testCase}-${randomUUID().slice(0, 8)}@example.test`;
  const password = "Correct-horse-staple-2026";
  await site("/api/storefront/v1/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
  const listing = (await site(`/api/storefront/v1/listings/by-slug/${slug}`)).body as { listingId: string };
  const address = { name: "Qualification Buyer", line1: "12 rue de Test", line2: "", city: "Paris", postalCode: "75001", country: "FR" };
  const quote = (await site("/api/commerce/v1/quote", {
    method: "POST",
    body: JSON.stringify({ lines: [{ listingId: listing.listingId, quantity: 1 }], contact: { email, phone: "" }, shippingAddress: address }),
  })).body as { id: string };
  const order = ((await site("/api/commerce/v1/checkout", {
    method: "POST",
    body: JSON.stringify({ quoteId: quote.id, operationKey: randomUUID(), accepted: true }),
  })).body as { order: { id: string; number: string } }).order;
  const payment = (await site(`/api/commerce/v1/orders/${order.id}/payment`, { method: "POST", body: "{}" })).body as { url: string };
  const attempt = await db.paymentAttempt.findUniqueOrThrow({ where: { orderId: order.id } });
  return { email, password, order, checkoutUrl: payment.url, attempt };
}

try {
  if (testCase === "expired") {
    const { order, attempt } = await newPayableOrder();
    const heldBefore = await db.inventoryReservation.count({
      where: { orderItem: { orderId: order.id }, status: "HELD" },
    });
    assert("expiry_fixture_holds_stock", heldBefore === 1, `${heldBefore} HELD reservation`);

    // Expire the session at the provider; Stripe then emits a real checkout.session.expired.
    await stripe.checkout.sessions.expire(attempt.providerSessionId!);
    console.log("Expired the hosted session at Stripe; waiting for the webhook…");
    let final = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    for (let i = 0; i < 60 && final.paymentStatus === "UNPAID" && final.status === "PENDING"; i++) {
      await sleep(500);
      final = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    }
    assert(
      "expired_session_cancels_order",
      final.status === "CANCELLED" && final.paymentStatus === "FAILED",
      `${final.status}/${final.paymentStatus}`,
    );
    const released = await db.inventoryReservation.count({
      where: { orderItem: { orderId: order.id }, status: "RELEASED" },
    });
    assert("expired_session_releases_stock", released === 1, `${released} RELEASED reservation`);
    const paidEvents = await db.paymentEvent.count({ where: { attemptId: attempt.id, type: "PAID" } });
    assert("expired_session_records_no_payment", paidEvents === 0, "no PAID event for an expired session");
  }

  if (testCase === "declined") {
    const fixture = await newPayableOrder();
    await writeFile(
      resolve(".local/audit/stripe-stage3-handoff.json"),
      JSON.stringify({ orderId: fixture.order.id, attemptId: fixture.attempt.id, checkoutUrl: fixture.checkoutUrl }, null, 2),
    );
    console.log(`Declined-card fixture ready for order ${fixture.order.number}.`);
    console.log("Now run: npx tsx --env-file=.env scripts/stripe-pay-hosted.ts --card 4000000000000002 --handoff .local/audit/stripe-stage3-handoff.json");
    console.log("Then re-run this script with --case declined-verify");
  }

  if (testCase === "prepare-reconcile") {
    const fixture = await newPayableOrder();
    await writeFile(
      resolve(".local/audit/stripe-stage3-reconcile.json"),
      JSON.stringify(
        { orderId: fixture.order.id, number: fixture.order.number, attemptId: fixture.attempt.id, checkoutUrl: fixture.checkoutUrl },
        null,
        2,
      ),
    );
    console.log(`Reconciliation fixture ready: order ${fixture.order.number} (${fixture.order.id})`);
  }

  if (testCase === "reconcile-verify") {
    const handoff = JSON.parse(
      await readFile(resolve(".local/audit/stripe-stage3-reconcile.json"), "utf8"),
    ) as { orderId: string; attemptId: string };
    const order = await db.order.findUniqueOrThrow({ where: { id: handoff.orderId } });
    assert(
      "reconciliation_recovers_lost_webhook",
      order.paymentStatus === "PAID" && !!order.paidAt,
      `${order.status}/${order.paymentStatus}`,
    );
    const confirmed = await db.inventoryReservation.count({
      where: { orderItem: { orderId: handoff.orderId }, status: "CONFIRMED" },
    });
    assert("reconciliation_confirms_reservation", confirmed === 1, `${confirmed} CONFIRMED reservation`);
    const paidEvents = await db.paymentEvent.count({ where: { attemptId: handoff.attemptId, type: "PAID" } });
    assert("reconciliation_records_one_payment", paidEvents === 1, `${paidEvents} PAID event`);
  }

  if (testCase === "reconcile") {
    // The webhook listener must be stopped before this runs, so the provider's notification is
    // genuinely lost. Recovery must then come from the scheduled reconciliation job alone.
    const handoff = JSON.parse(
      await readFile(resolve(".local/audit/stripe-stage3-reconcile.json"), "utf8"),
    ) as { orderId: string; attemptId: string };
    const before = await db.order.findUniqueOrThrow({ where: { id: handoff.orderId } });
    assert(
      "webhook_was_lost_order_still_unpaid",
      before.paymentStatus === "UNPAID",
      `order is ${before.status}/${before.paymentStatus} before reconciliation`,
    );
    console.log("Run `npm run commerce:maintenance` now, then re-run with --case reconcile-verify.");
  }

  if (checks.length) {
    await mkdir(resolve(".local/audit"), { recursive: true });
    await writeFile(
      resolve(`.local/audit/stripe-qualification-${testCase}.json`),
      JSON.stringify({ at: new Date().toISOString(), case: testCase, checks }, null, 2),
    );
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} ${testCase} checks passed.`);
    if (failed.length) process.exitCode = 1;
  }
} finally {
  await db.$disconnect();
}
