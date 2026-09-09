import { afterEach, describe, expect, it, vi } from "vitest";
import {
  verificationPolicy,
  verificationRequired,
} from "../src/modules/customers/service";

/**
 * The owner must be able to choose between the three documented policies with configuration
 * alone. These assertions exist so a future change cannot quietly collapse them back into one
 * switch: each policy has to keep producing a different combination of gates.
 */
describe("customer email verification policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  const scopes = () => ({
    checkout: verificationRequired("CHECKOUT"),
    gacha: verificationRequired("GACHA"),
  });

  it("C: 'off' lets unverified accounts check out and pull", () => {
    vi.stubEnv("CUSTOMER_VERIFICATION_POLICY", "off");
    expect(scopes()).toEqual({ checkout: false, gacha: false });
  });

  it("B: 'gacha' gates only gacha, leaving checkout open", () => {
    vi.stubEnv("CUSTOMER_VERIFICATION_POLICY", "gacha");
    expect(scopes()).toEqual({ checkout: false, gacha: true });
  });

  it("A: 'all' gates both checkout and gacha", () => {
    vi.stubEnv("CUSTOMER_VERIFICATION_POLICY", "all");
    expect(scopes()).toEqual({ checkout: true, gacha: true });
  });

  it("keeps the previous boolean meaning when no policy is configured", () => {
    vi.stubEnv("CUSTOMER_VERIFICATION_POLICY", "");
    vi.stubEnv("CUSTOMER_REQUIRE_VERIFIED_EMAIL", "true");
    expect(verificationPolicy()).toBe("all");
    vi.stubEnv("CUSTOMER_REQUIRE_VERIFIED_EMAIL", "false");
    expect(verificationPolicy()).toBe("off");
  });

  it("refuses an unrecognised policy instead of silently disabling verification", () => {
    // A typo must not fail open: silently degrading to "off" would remove the gate the
    // operator believed they had configured.
    vi.stubEnv("CUSTOMER_VERIFICATION_POLICY", "yes");
    expect(() => verificationPolicy()).toThrow(/CUSTOMER_VERIFICATION_POLICY/);
  });
});
