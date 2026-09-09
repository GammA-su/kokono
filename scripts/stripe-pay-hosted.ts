/**
 * Completes the hosted Stripe Checkout page with a TEST card.
 *
 * There is no API that pays a Checkout Session, so this is the only way to exercise the real
 * hosted flow: a browser fills the page exactly as a customer would. Test cards only — the
 * account is in test mode and the adapter refuses live sessions.
 *
 *   npx tsx --env-file=.env scripts/stripe-pay-hosted.ts [--card <number>]
 *
 * Card defaults to 4242… (immediate success). Pass 4000000000000002 for a declined card.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
// Playwright is installed in the storefront project, not here, so it is imported by path and
// has no reachable type declarations. This script is a local diagnostic, never shipped code.
// @ts-expect-error -- no type declarations for the cross-project import
import { chromium } from "../../kokoniv2/node_modules/playwright/index.mjs";

const handoffIndex = process.argv.indexOf("--handoff");
const handoffPath =
  handoffIndex > -1 ? process.argv[handoffIndex + 1] : ".local/audit/stripe-stage1-handoff.json";
const handoff = JSON.parse(await readFile(resolve(handoffPath), "utf8")) as {
  checkoutUrl: string;
  orderId: string;
};

const cardIndex = process.argv.indexOf("--card");
const card = cardIndex > -1 ? process.argv[cardIndex + 1] : "4242424242424242";
if (!/^\d{12,19}$/.test(card)) throw new Error("Invalid test card number.");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(handoff.checkoutUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log(`Opened hosted Checkout for order ${handoff.orderId}`);

  // Field ids are stable across Stripe's locales; placeholders are not (this account is FR,
  // so the hosted page renders in French).
  await page.locator("#cardNumber").fill(card, { timeout: 45000 });
  await page.locator("#cardExpiry").fill("12 / 34");
  await page.locator("#cardCvc").fill("123");
  for (const [selector, value] of [
    ["#billingName", "Qualification Buyer"],
    ["#billingPostalCode", "75001"],
  ] as const) {
    const field = page.locator(selector);
    if (await field.isVisible().catch(() => false)) await field.fill(value);
  }

  await page.getByTestId("hosted-payment-submit-button").click({ timeout: 30000 });
  console.log("Submitted test payment; waiting for the provider to settle…");

  try {
    await page.waitForURL(/payment=return/, { timeout: 90000 });
    console.log(`Provider redirected the browser to: ${new URL(page.url()).pathname}?payment=return`);
    console.log("RESULT: payment_submitted");
  } catch {
    const error = await page
      .locator('[data-testid="card-field-error"], .Error, [role="alert"]')
      .first()
      .textContent()
      .catch(() => null);
    console.log(`RESULT: not_redirected — page reported: ${error?.trim() ?? "no visible error"}`);
    console.log(`Current URL host: ${new URL(page.url()).host}`);
  }
} finally {
  await browser.close();
}
