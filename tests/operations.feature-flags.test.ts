import { afterEach, describe, expect, it, vi } from "vitest";
import { paymentConfiguration, stripeProvider } from "../src/modules/commerce/stripe";
import { gachaPolicy } from "../src/modules/gacha/validation";
import { customerGachaEnabled } from "../src/modules/gacha/customer-service";
import { verificationRequired } from "../src/modules/customers/service";

/**
 * Every switch here must fail closed in the domain layer, not merely hide a control in the
 * admin or storefront UI. A flag that is only respected by a React component is not an off
 * switch: an HTTP client that never renders that component would still reach the capability.
 */
describe("safe off switches", () => {
  afterEach(() => vi.unstubAllEnvs());

  const stripeTestKeys = () => {
    vi.stubEnv("STRIPE_SECRET_KEY", `sk_test_${"x".repeat(24)}`);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", `whsec_${"y".repeat(24)}`);
    vi.stubEnv("COMMERCE_GATEWAY_SECRET", "g".repeat(48));
    vi.stubEnv("STOREFRONT_BASE_URL", "https://shop.example");
  };

  it("COMMERCE_TEST_CHECKOUT_ENABLED=false disables checkout even with valid test keys", () => {
    stripeTestKeys();
    vi.stubEnv("COMMERCE_TEST_CHECKOUT_ENABLED", "false");
    expect(paymentConfiguration().enabled).toBe(false);
    // The provider itself must refuse to construct, so no code path can obtain one anyway.
    expect(() => stripeProvider()).toThrow();
  });

  it("only an explicit 'true' enables checkout", () => {
    stripeTestKeys();
    for (const value of ["", "1", "yes", "TRUE", "on"]) {
      vi.stubEnv("COMMERCE_TEST_CHECKOUT_ENABLED", value);
      expect(paymentConfiguration().enabled).toBe(false);
    }
    vi.stubEnv("COMMERCE_TEST_CHECKOUT_ENABLED", "true");
    expect(paymentConfiguration().enabled).toBe(true);
  });

  it("refuses live Stripe keys regardless of the enable flag", () => {
    stripeTestKeys();
    vi.stubEnv("COMMERCE_TEST_CHECKOUT_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", `sk_live_${"x".repeat(24)}`);
    expect(paymentConfiguration().enabled).toBe(false);
    expect(() => stripeProvider()).toThrow();
  });

  it("GACHA_DRAWS_ENABLED=false disables draws globally", () => {
    vi.stubEnv("GACHA_DRAWS_ENABLED", "false");
    expect(gachaPolicy().drawsEnabled).toBe(false);
    // Customer execution cannot re-enable draws that the global switch has turned off.
    vi.stubEnv("GACHA_CUSTOMER_EXECUTION_ENABLED", "true");
    expect(customerGachaEnabled()).toBe(false);
  });

  it("GACHA_CUSTOMER_EXECUTION_ENABLED=false disables customer pulls", () => {
    vi.stubEnv("GACHA_DRAWS_ENABLED", "true");
    vi.stubEnv("GACHA_CUSTOMER_EXECUTION_ENABLED", "false");
    expect(customerGachaEnabled()).toBe(false);
  });

  it("paid gacha stays unavailable under every combination of switches", () => {
    for (const draws of ["true", "false"])
      for (const customer of ["true", "false"]) {
        vi.stubEnv("GACHA_DRAWS_ENABLED", draws);
        vi.stubEnv("GACHA_CUSTOMER_EXECUTION_ENABLED", customer);
        expect(gachaPolicy().paidDrawsEnabled).toBe(false);
      }
  });

  it("CUSTOMER_VERIFICATION_POLICY selects which actions are gated", () => {
    vi.stubEnv("CUSTOMER_VERIFICATION_POLICY", "all");
    expect(verificationRequired("CHECKOUT")).toBe(true);
    expect(verificationRequired("GACHA")).toBe(true);
    vi.stubEnv("CUSTOMER_VERIFICATION_POLICY", "gacha");
    expect(verificationRequired("CHECKOUT")).toBe(false);
    expect(verificationRequired("GACHA")).toBe(true);
    vi.stubEnv("CUSTOMER_VERIFICATION_POLICY", "off");
    expect(verificationRequired("GACHA")).toBe(false);
  });
});
