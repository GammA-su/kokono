import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { customerEmailConfig } from "../src/modules/customer-email/config";
import {
  CustomerEmailVerification,
  CustomerPasswordReset,
} from "../src/modules/customer-email/templates";
import {
  configuredCustomerMail,
  createResendCustomerMail,
  customerEmailIdempotencyKey,
} from "../src/modules/customer-email/resend";
const env = {
  NODE_ENV: "production",
  CUSTOMER_EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_TEST_SERVER_ONLY",
  CUSTOMER_EMAIL_FROM: "Kokoni <account@mail.example.test>",
  CUSTOMER_EMAIL_REPLY_TO: "support@example.test",
  SITE_ORIGIN: "https://shop.example.test",
  STOREFRONT_BASE_URL: "https://shop.example.test",
};
const config = customerEmailConfig(env)!;
const message = {
  email: "customer@example.test",
  token: "t".repeat(43),
  purpose: "VERIFY" as const,
};
afterEach(() => vi.restoreAllMocks());
describe("customer email configuration", () => {
  it("requires explicit opt-in and rejects incomplete or unsafe enabled production settings without leaking values", () => {
    expect(customerEmailConfig({})).toBeNull();
    expect(
      customerEmailConfig({ ...env, CUSTOMER_EMAIL_PROVIDER: "disabled" }),
    ).toBeNull();
    for (const patch of [
      { RESEND_API_KEY: "" },
      { CUSTOMER_EMAIL_FROM: "" },
      { CUSTOMER_EMAIL_FROM: "invalid\r\nBCC: secret" },
      { CUSTOMER_EMAIL_REPLY_TO: "not-email" },
      { SITE_ORIGIN: "http://shop.example.test" },
      { SITE_ORIGIN: "https://user:password@example.test" },
      { SITE_ORIGIN: "https://shop.example.test/path" },
      { SITE_ORIGIN: "https://shop.example.test?token=secret" },
      { SITE_ORIGIN: "https://evil.example.test" },
      { CUSTOMER_EMAIL_PROVIDER: "other" },
      { CUSTOMER_EMAIL_SITE_NAME: "x\r\ny" },
    ]) {
      expect(() => customerEmailConfig({ ...env, ...patch })).toThrow(
        /configuration/,
      );
      try {
        customerEmailConfig({ ...env, ...patch });
      } catch (e) {
        expect(String(e)).not.toMatch(
          /re_TEST_SERVER_ONLY|BCC: secret|user:password|token=secret/,
        );
      }
    }
    expect(
      customerEmailConfig({ ...env, SITE_ORIGIN: undefined })?.siteOrigin,
    ).toBe(env.STOREFRONT_BASE_URL);
    expect(
      customerEmailConfig({
        ...env,
        NODE_ENV: "development",
        SITE_ORIGIN: "http://localhost:5173",
        STOREFRONT_BASE_URL: "http://localhost:5173",
      })?.siteOrigin,
    ).toBe("http://localhost:5173");
  });
  it("disables runtime mail in automated tests even with configured credentials", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(
      configuredCustomerMail({ ...env, NODE_ENV: "test" }),
    ).toBeUndefined();
    expect(configuredCustomerMail({ ...env, VITEST: "true" })).toBeUndefined();
    expect(() => createResendCustomerMail(config)).toThrow(/automated tests/);
    expect(spy).not.toHaveBeenCalled();
  });
});
it("renders accessible HTML and text with configured fragment links, purpose, expiry and escaped branding", () => {
  const verify = CustomerEmailVerification(config, message.token),
    reset = CustomerPasswordReset(config, message.token);
  for (const [mail, path, expiry] of [
    [verify, "verify-email", "24 hours"],
    [reset, "reset-password", "one hour"],
  ] as const) {
    expect(mail.html).toContain(
      `https://shop.example.test/${path}#token=${message.token}`,
    );
    expect(mail.text).toContain(
      `https://shop.example.test/${path}#token=${message.token}`,
    );
    expect(mail.html).not.toContain("?token=");
    expect(mail.text).toContain(expiry);
    expect(mail.text).toContain("only once");
    expect(mail.text).toContain("ignore this email");
    expect(mail.html).toContain('role="presentation"');
    expect(mail.html).toContain('lang="en"');
    expect(mail.text).toContain("support@example.test");
    expect(mail.html).not.toMatch(
      /script|stylesheet|re_TEST_SERVER_ONLY|customer@example/,
    );
  }
  expect(verify.subject).toContain("Verify");
  expect(reset.subject).toContain("Reset");
  const escaped = CustomerEmailVerification(
    { ...config, siteName: "Kokoni <img src=x onerror=alert(1)> & friends" },
    message.token,
  );
  expect(escaped.html).not.toContain("<img");
  expect(escaped.html).toContain("&lt;img");
  expect(() => CustomerPasswordReset(config, "invalid")).toThrow();
});
it("sends the minimal Resend REST request with bounded timeout and a stable non-secret idempotency key", async () => {
  const send = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "resend-message-id" }),
    ),
    mail = createResendCustomerMail(config, send);
  await mail(message);
  await mail(message);
  const [url, init] = send.mock.calls[0],
    body = JSON.parse(String(init?.body));
  expect(url).toBe("https://api.resend.com/emails");
  expect(init?.method).toBe("POST");
  expect(init?.redirect).toBe("error");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(Object.keys(body).sort()).toEqual([
    "from",
    "html",
    "reply_to",
    "subject",
    "text",
    "to",
  ]);
  expect(body.to).toEqual([message.email]);
  expect(body.reply_to).toBe(config.replyTo);
  const headers = new Headers(init?.headers),
    key = headers.get("Idempotency-Key");
  expect(headers.get("Authorization")).toBe(`Bearer ${config.apiKey}`);
  expect(key).toBe(customerEmailIdempotencyKey(message));
  expect(key).not.toContain(message.token);
  expect(key).not.toContain(message.email);
  expect(key!.length).toBeLessThan(256);
  expect(
    new Headers(send.mock.calls[1][1]?.headers).get("Idempotency-Key"),
  ).toBe(key);
  expect(
    customerEmailIdempotencyKey({ ...message, purpose: "RESET" }),
  ).not.toBe(key);
  expect(
    customerEmailIdempotencyKey({ ...message, token: "u".repeat(43) }),
  ).not.toBe(key);
  expect(String(init?.body)).not.toContain(config.apiKey);
});
it("sanitizes rejected, malformed, redirected and uncertain provider responses without logging secrets", async () => {
  const logs = [
    vi.spyOn(console, "log"),
    vi.spyOn(console, "error"),
    vi.spyOn(console, "warn"),
  ];
  const providers: (typeof fetch)[] = [
    async () =>
      Response.json(
        { error: `${config.apiKey} ${message.token}` },
        { status: 429 },
      ),
    async () => Response.json({ error: "provider failure" }),
    async () => new Response("not json"),
    async () => {
      throw new Error(`network error ${message.token} ${config.apiKey}`);
    },
    async () => {
      throw new DOMException("timeout", "TimeoutError");
    },
  ];
  for (const provider of providers)
    await expect(
      createResendCustomerMail(config, provider)(message),
    ).rejects.toThrow("Customer email delivery could not be confirmed.");
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
it("keeps provider construction in a server-only module and both namespaces share it", async () => {
  const factory = await readFile("src/lib/customer-handler.ts", "utf8");
  expect(factory).toContain("server-only");
  expect(factory).toContain("configuredCustomerMail");
  for (const realm of ["auth", "customer"])
    expect(
      await readFile(
        `src/app/api/storefront/v1/${realm}/[...path]/route.ts`,
        "utf8",
      ),
    ).toContain("@/lib/customer-handler");
  for (const file of [
    "../kokoniv2/src/lib/customer.ts",
    "../kokoniv2/customer-proxy.mjs",
  ])
    expect(await readFile(file, "utf8")).not.toMatch(
      /RESEND_API_KEY|resend\.com/,
    );
});
