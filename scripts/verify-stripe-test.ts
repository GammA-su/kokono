/**
 * Stripe TEST-mode end-to-end qualification.
 *
 * Drives a real customer purchase through both running applications and the real Stripe test
 * API: storefront -> quote -> checkout -> hosted Stripe Checkout -> test card -> real webhook
 * delivered by `stripe listen` -> order PAID -> reservation confirmed -> admin dispatch ->
 * exactly one SALE movement.
 *
 * TEST MODE ONLY. The adapter refuses live keys and live events; nothing here relaxes that.
 *
 * Prerequisites (all local):
 *   - backend on :3000, storefront on :5173
 *   - `stripe listen --forward-to http://localhost:3000/api/commerce/webhooks/stripe`
 *   - COMMERCE_TEST_CHECKOUT_ENABLED=true with sk_test_ / whsec_ configured
 *
 *   npx tsx --env-file=.env scripts/verify-stripe-test.ts --slug <fixture-slug>
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Stripe from "stripe";
import { createDatabaseClient } from "../src/db/client";

const SITE = "http://localhost:5173";
const slug = process.argv[process.argv.indexOf("--slug") + 1];
if (!process.argv.includes("--slug") || !slug || slug.startsWith("--"))
  throw new Error("Pass --slug <listing slug> from scripts/stripe-test-fixture.ts");

if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"))
  throw new Error("A Stripe TEST secret key is required. Live keys are refused.");
if (process.env.COMMERCE_TEST_CHECKOUT_ENABLED !== "true")
  throw new Error("COMMERCE_TEST_CHECKOUT_ENABLED must be true for this qualification.");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });
const db = createDatabaseClient(process.env.DATABASE_URL!);

type Check = { check: string; ok: boolean; detail: string };
const checks: Check[] = [];
function assert(check: string, ok: boolean, detail: string) {
  checks.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check}${detail ? ` — ${detail}` : ""}`);
}

// --- Storefront HTTP client that behaves like a browser (cookie jar, Origin) ----------------
const jar = new Map<string, string>();
async function site(path: string, init: RequestInit = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await fetch(`${SITE}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Origin: SITE,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const index = pair.indexOf("=");
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* HTML or empty */
  }
  return { status: response.status, body: body as Record<string, unknown> };
}

const evidence: Record<string, unknown> = {};
try {
  // ---------------------------------------------------------------- 1. mode and configuration
  const config = await site("/api/commerce/v1/config");
  const payment = (config.body as { payment?: { mode?: string; enabled?: boolean } }).payment;
  assert(
    "stripe_mode_is_test",
    payment?.mode === "TEST" && payment?.enabled === true,
    `mode=${payment?.mode} enabled=${payment?.enabled}`,
  );
  evidence.configuredMode = payment?.mode;

  // ---------------------------------------------------------------- 2. controlled test customer
  const email = `stripe-qual-${randomUUID().slice(0, 8)}@example.test`;
  const password = "Correct-horse-staple-2026";
  const registered = await site("/api/storefront/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  assert("customer_registered", registered.status === 200, `status ${registered.status}`);
  const customerRow = await db.customer.findUniqueOrThrow({ where: { email } });
  evidence.customerId = customerRow.id;

  // ---------------------------------------------------------------- 3. product and stock
  const listing = await site(`/api/storefront/v1/listings/by-slug/${slug}`);
  const product = listing.body as {
    listingId: string;
    price: { amount: number; currency: string };
    availability: { availableQuantity: number };
  };
  assert(
    "product_publicly_visible_with_france_stock",
    listing.status === 200 && product.availability.availableQuantity > 0,
    `${product.availability?.availableQuantity} available at ${product.price?.amount} ${product.price?.currency}`,
  );

  // ---------------------------------------------------------------- 4. quote
  const address = {
    name: "Qualification Buyer",
    line1: "12 rue de Test",
    line2: "",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
  };
  const quoted = await site("/api/commerce/v1/quote", {
    method: "POST",
    body: JSON.stringify({
      lines: [{ listingId: product.listingId, quantity: 1 }],
      contact: { email, phone: "" },
      shippingAddress: address,
    }),
  });
  const quote = quoted.body as { id: string; totalAmount: number; subtotalAmount: number; shippingAmount: number; taxAmount: number };
  assert("quote_created", quoted.status === 200 && !!quote.id, `total ${quote.totalAmount} EUR TTC (incl. ${quote.shippingAmount} shipping)`);
  evidence.quote = {
    quoteId: quote.id,
    subtotalAmount: quote.subtotalAmount,
    shippingAmount: quote.shippingAmount,
    taxAmount: quote.taxAmount,
    totalAmount: quote.totalAmount,
  };

  // The server is the only authority on price: a browser-supplied amount must be ignored.
  const tampered = await site("/api/commerce/v1/quote", {
    method: "POST",
    body: JSON.stringify({
      lines: [{ listingId: product.listingId, quantity: 1 }],
      contact: { email, phone: "" },
      shippingAddress: address,
      totalAmount: 1,
      subtotalAmount: 1,
    }),
  });
  assert(
    "browser_cannot_set_price",
    tampered.status >= 400,
    `injected totals rejected with ${tampered.status}`,
  );

  // ---------------------------------------------------------------- 5. checkout -> order
  const operationKey = randomUUID();
  const created = await site("/api/commerce/v1/checkout", {
    method: "POST",
    body: JSON.stringify({ quoteId: quote.id, operationKey, accepted: true }),
  });
  const order = (created.body as { order?: { id: string; number: string; totalAmount: number } }).order;
  const orderId = order?.id ?? "";
  assert("order_created", created.status === 200 && !!orderId, `order ${order?.number} total ${order?.totalAmount}`);
  evidence.orderId = orderId;

  // Same operation key must not create a second order.
  const replayCheckout = await site("/api/commerce/v1/checkout", {
    method: "POST",
    body: JSON.stringify({ quoteId: quote.id, operationKey, accepted: true }),
  });
  const replayOrder = (replayCheckout.body as { order?: { id: string } }).order;
  assert(
    "checkout_creation_is_idempotent",
    replayOrder?.id === orderId,
    "same operation key returned the same order",
  );
  assert(
    "orders_are_one_per_quote",
    (await db.order.count({ where: { quoteId: quote.id } })) === 1,
    "exactly one order exists for this quote",
  );

  // ---------------------------------------------------------------- 6. Stripe Checkout session
  const started = await site(`/api/commerce/v1/orders/${orderId}/payment`, { method: "POST", body: "{}" });
  const session = started.body as { url?: string };
  assert(
    "checkout_session_created",
    started.status === 200 && !!session.url?.startsWith("https://checkout.stripe.com/"),
    session.url ? new URL(session.url).host : `status ${started.status} ${JSON.stringify(started.body).slice(0, 200)}`,
  );
  const retryStart = await site(`/api/commerce/v1/orders/${orderId}/payment`, { method: "POST", body: "{}" });
  assert(
    "checkout_session_retry_is_idempotent",
    (retryStart.body as { url?: string }).url === session.url,
    "retry returned the same hosted session",
  );
  const attempt = await db.paymentAttempt.findUniqueOrThrow({ where: { orderId } });
  const stripeSession = await stripe.checkout.sessions.retrieve(attempt.providerSessionId!);
  assert(
    "session_is_test_mode_and_matches_order",
    stripeSession.livemode === false && stripeSession.amount_total === attempt.amount,
    `livemode=${stripeSession.livemode} amount=${stripeSession.amount_total}`,
  );
  evidence.checkoutSessionId = stripeSession.id;
  evidence.amountTotal = stripeSession.amount_total;

  // ---------------------------------------------------------------- 7. browser return alone
  const beforePay = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  await site(`/api/commerce/v1/orders/${orderId}`);
  // Hit the exact success_url the provider would send the browser to.
  await site(`/orders/${orderId}?payment=return`);
  const afterReturn = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  assert(
    "browser_return_alone_cannot_mark_paid",
    afterReturn.paymentStatus === "UNPAID" && beforePay.paymentStatus === "UNPAID",
    `paymentStatus still ${afterReturn.paymentStatus} after visiting success_url`,
  );

  await mkdir(resolve(".local/audit"), { recursive: true });
  await writeFile(
    resolve(".local/audit/stripe-qualification-stage1.json"),
    JSON.stringify({ at: new Date().toISOString(), evidence, checks }, null, 2),
  );
  console.log(
    `\nHosted Checkout URL written for the browser stage.\n${session.url}\n` +
      `Order ${orderId}\nAttempt ${attempt.id}\n`,
  );
  await writeFile(
    resolve(".local/audit/stripe-stage1-handoff.json"),
    JSON.stringify(
      {
        orderId,
        attemptId: attempt.id,
        sessionId: stripeSession.id,
        checkoutUrl: session.url,
        customerId: customerRow.id,
        email,
        password,
        listingId: product.listingId,
        cookies: [...jar],
      },
      null,
      2,
    ),
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`${checks.length - failed.length}/${checks.length} stage-1 checks passed.`);
  if (failed.length) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
