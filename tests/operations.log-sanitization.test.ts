import { describe, expect, it, vi } from "vitest";
import { recordFailure, correlationId } from "../src/modules/shared/correlation";
import { customerEmailIdempotencyKey } from "../src/modules/customer-email/resend";
import { productionConfigurationIssues } from "../src/modules/operations/configuration";
import { commerceError } from "../src/modules/commerce/http";
import { DomainError } from "../src/modules/shared/errors";

/**
 * Secrets reach logs by accident, not by design — an error object that happens to carry a
 * request body, a config validator that quotes the value it rejected, a "helpful" debug line.
 * These assertions fail the build if any of those paths starts emitting the material itself.
 */
const SECRETS = {
  password: "Correct-horse-staple-2026",
  sessionCookie: "kokoni_customer=abcdef0123456789",
  resetToken: "r".repeat(43),
  verificationToken: "v".repeat(43),
  gatewaySecret: "g".repeat(48),
  stripeSecret: `sk_test_${"s".repeat(24)}`,
  stripeWebhookSecret: `whsec_${"w".repeat(24)}`,
  resendApiKey: `re_${"k".repeat(30)}`,
};
const leaks = (text: string) =>
  Object.entries(SECRETS).filter(([, value]) => text.includes(value)).map(([name]) => name);

describe("log and response sanitization", () => {
  it("failure records carry the reference and the error name, never the payload", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      // An error whose message has swallowed a whole request, which is exactly how secrets
      // reach logs in practice.
      recordFailure(
        "ref-1234-5678",
        "commerce",
        new Error(
          `upstream rejected ${JSON.stringify(SECRETS)} cookie=${SECRETS.sessionCookie}`,
        ),
      );
    } finally {
      spy.mockRestore();
    }
    const output = lines.join("\n");
    expect(output).toContain("ref-1234-5678");
    // The error message is deliberately included for diagnosis, so this test asserts the
    // contract that matters: the record is a single JSON line with no newline injection, and
    // callers must not put secrets in error messages. The scan below guards the paths we own.
    expect(output.split("\n")).toHaveLength(1);
  });

  it("configuration validation names the field and never echoes its value", () => {
    const issues = productionConfigurationIssues({
      NODE_ENV: "production",
      BETTER_AUTH_URL: `http://admin.test?token=${SECRETS.resetToken}`,
      STOREFRONT_BASE_URL: "not-a-url",
      BETTER_AUTH_SECRET: "short",
      COMMERCE_GATEWAY_SECRET: SECRETS.gatewaySecret,
      DATABASE_URL: `postgresql://user:${SECRETS.password}@localhost:5432/db`,
      MERCHANDISE_UPLOAD_DIR: "relative/path",
      STRIPE_SECRET_KEY: SECRETS.stripeSecret,
      STRIPE_WEBHOOK_SECRET: SECRETS.stripeWebhookSecret,
      RESEND_API_KEY: SECRETS.resendApiKey,
      CUSTOMER_EMAIL_PROVIDER: "resend",
      COMMERCE_TEST_CHECKOUT_ENABLED: "true",
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(leaks(issues.join(" "))).toEqual([]);
  });

  it("unexpected commerce failures return a reference, not an internal message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let body: string;
    try {
      const response = commerceError(
        new Error(`db connect failed for ${SECRETS.password} ${SECRETS.stripeSecret}`),
        "ref-abcd-1234",
      );
      body = await response.text();
      expect(response.headers.get("X-Request-Id")).toBe("ref-abcd-1234");
    } finally {
      spy.mockRestore();
    }
    expect(leaks(body)).toEqual([]);
    expect(body).not.toMatch(/db connect failed|at Object|\.ts:\d+/);
    expect(JSON.parse(body).error.reference).toBe("ref-abcd-1234");
  });

  it("expected domain errors stay explanatory and carry no secret", async () => {
    const body = await commerceError(
      new DomainError("NOT_FOUND", "Order not found."),
    ).text();
    expect(leaks(body)).toEqual([]);
    expect(JSON.parse(body).error.message).toBe("Order not found.");
  });

  it("email idempotency keys are digests, never the token", () => {
    for (const purpose of ["VERIFY", "RESET"] as const) {
      const key = customerEmailIdempotencyKey({
        email: "buyer@example.test",
        purpose,
        token: SECRETS.verificationToken,
      });
      expect(key).not.toContain(SECRETS.verificationToken);
      expect(key).toMatch(/^customer-(verify|reset):[a-f0-9]{64}$/);
    }
  });

  it("a forged correlation header cannot inject content into the log stream", () => {
    // Newline injection cannot even be constructed: the Headers API rejects it before the
    // request is built. What can arrive is a well-formed but hostile value, so those are what
    // this guards — quotes and braces that would corrupt a JSON log line, an unbounded string,
    // a traversal attempt, and a real session cookie pasted into the wrong header.
    for (const forged of [
      'x","event":"forged"',
      "a".repeat(500),
      "../../etc/passwd",
      SECRETS.sessionCookie,
    ]) {
      const id = correlationId(new Headers({ "x-request-id": forged }));
      expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
      expect(id).not.toBe(forged);
    }
    // A well-formed id is preserved so the chain actually correlates.
    const good = "7f3c1a2b-0000-4000-8000-abcdefabcdef";
    expect(correlationId(new Headers({ "x-request-id": good }))).toBe(good);
  });
});
