import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commerceError } from "../src/modules/commerce/http";
import { paymentConfiguration, stripeProvider } from "../src/modules/commerce/stripe";

/**
 * Route-level webhook handling. The service layer's event logic is covered by
 * commerce.integration.test.ts with a mocked provider; this file covers the boundary in front
 * of it — what an unauthenticated caller can learn or cause by POSTing to the public webhook
 * path. These invariants were confirmed against real Stripe deliveries during the TEST-mode
 * qualification (valid, duplicate, replayed, tampered, stale and unsigned requests).
 */
const SECRET = `whsec_${"a".repeat(32)}`;
const sign = (payload: string, secret: string, timestamp: number) =>
  `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")}`;

describe("stripe webhook route boundary", () => {
  afterEach(() => vi.unstubAllEnvs());

  const configure = () => {
    vi.stubEnv("COMMERCE_TEST_CHECKOUT_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", `sk_test_${"x".repeat(24)}`);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("COMMERCE_GATEWAY_SECRET", "g".repeat(48));
    vi.stubEnv("STOREFRONT_BASE_URL", "https://shop.example");
  };

  it("only reports TEST mode, and never enables without every required setting", () => {
    configure();
    expect(paymentConfiguration()).toMatchObject({ mode: "TEST", enabled: true });
    for (const missing of [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "COMMERCE_GATEWAY_SECRET",
      "STOREFRONT_BASE_URL",
    ]) {
      configure();
      vi.stubEnv(missing, "");
      expect(paymentConfiguration().enabled).toBe(false);
      // The provider must refuse to construct, so no caller can obtain one regardless.
      expect(() => stripeProvider()).toThrow();
    }
  });

  it("refuses to construct a provider from a live key even when everything else is set", () => {
    configure();
    vi.stubEnv("STRIPE_SECRET_KEY", `sk_live_${"x".repeat(24)}`);
    expect(paymentConfiguration().enabled).toBe(false);
    expect(() => stripeProvider()).toThrow();
  });

  /**
   * Signature verification runs inside the real Stripe SDK, so these assertions exercise the
   * same code the deployed route calls. A signature that does not verify must be rejected
   * before any order state is consulted.
   */
  it("accepts only a current signature produced with the configured secret", async () => {
    configure();
    const provider = stripeProvider();
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: "evt_test_route",
      type: "checkout.session.completed",
      livemode: false,
      data: { object: { id: "cs_test_1", mode: "payment", metadata: {} } },
    });

    // Correct signature: verification passes; the event is ignored only because its metadata
    // names no attempt of ours, which is exactly how a foreign event must behave.
    await expect(provider.verify(payload, sign(payload, SECRET, now))).resolves.toBeNull();

    for (const [name, body, signature] of [
      ["wrong secret", payload, sign(payload, `whsec_${"b".repeat(32)}`, now)],
      ["stale timestamp", payload, sign(payload, SECRET, now - 3600)],
      ["tampered body", payload.replace("cs_test_1", "cs_test_2"), sign(payload, SECRET, now)],
      ["empty signature", payload, ""],
      ["malformed signature", payload, "t=abc,v1=zzz"],
    ] as const)
      await expect(
        provider.verify(body, signature),
        `${name} must be refused`,
      ).rejects.toThrow();
  });

  it("refuses a live-mode event even when the signature verifies", async () => {
    configure();
    const provider = stripeProvider();
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: "evt_live",
      type: "checkout.session.completed",
      livemode: true,
      data: { object: { id: "cs_live_1", mode: "payment", metadata: {} } },
    });
    await expect(provider.verify(payload, sign(payload, SECRET, now))).rejects.toThrow(
      /Live payment events are disabled/,
    );
  });

  it("returns a generic error that names no provider internals", async () => {
    const body = await commerceError(
      new Error(`stripe request failed sk_test_secret whsec_secret cs_test_123`),
      "ref-webhook-1",
    ).text();
    expect(body).not.toMatch(/sk_test_|whsec_|cs_test_|stripe request failed/);
    expect(JSON.parse(body).error.reference).toBe("ref-webhook-1");
  });
});
