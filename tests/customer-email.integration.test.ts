import { randomUUID } from "node:crypto";
import { afterAll, expect, inject, it, vi } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import {
  createCustomerService,
  secretHash,
} from "../src/modules/customers/service";
import { createResendCustomerMail } from "../src/modules/customer-email/resend";
import { createCustomerHandler } from "../src/modules/customers/http";
const db = createDatabaseClient(inject("testDatabaseUrl"));
const config = {
  apiKey: "re_ONLY_TEST",
  from: "Kokoni <account@example.test>",
  siteName: "Kokoni",
  siteOrigin: "https://shop.example.test",
};
const password = "Customer-email-password-2026";
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
});
it("delivers existing verification/reset tokens through the adapter without changing ownership or redemption rules", async () => {
  const messages: { text: string }[] = [],
    send = vi.fn<typeof fetch>(async (_url, init) => {
      messages.push(JSON.parse(String(init?.body)));
      return Response.json({ id: randomUUID() });
    });
  const service = createCustomerService(
      db,
      createResendCustomerMail(config, send),
    ),
    email = `${randomUUID()}@example.test`,
    a = await service.register({ email, password });
  expect(a.customer.emailVerified).toBe(false);
  expect(messages).toHaveLength(1);
  expect((await service.session(a.token)).emailDeliveryAvailable).toBe(true);
  const verification = messages[0].text.match(/#token=([A-Za-z0-9_-]{43})/)![1];
  const stored = await db.customerToken.findUniqueOrThrow({
    where: { tokenHash: secretHash(verification) },
  });
  expect(stored.purpose).toBe("VERIFY");
  expect(
    stored.expiresAt.getTime() - stored.createdAt.getTime(),
  ).toBeGreaterThan(23 * 3600000);
  await service.redeem("VERIFY", { token: verification });
  await expect(
    service.redeem("VERIFY", { token: verification }),
  ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  await service.requestReset({ email });
  const reset = messages[1].text.match(/#token=([A-Za-z0-9_-]{43})/)![1];
  expect(messages[1].text).toContain("/reset-password#");
  const row = await db.customerToken.findUniqueOrThrow({
    where: { tokenHash: secretHash(reset) },
  });
  expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(
    3601000,
  );
  await service.redeem("RESET", { token: reset, password: password + "new" });
  expect((await service.session(a.token)).authenticated).toBe(false);
  await service.login({ email, password: password + "new" });
  await expect(service.login({ email, password })).rejects.toMatchObject({
    code: "INVALID_CREDENTIALS",
  });
});
it("invalidates only the new failed token; safe acknowledgements and domain throttles remain in force", async () => {
  let fail = false;
  const service = createCustomerService(
    db,
    createResendCustomerMail(config, async () =>
      fail
        ? Response.json(
            { message: "PRIVATE_PROVIDER_FAILURE" },
            { status: 500 },
          )
        : Response.json({ id: "accepted" }),
    ),
  );
  const email = `${randomUUID()}@example.test`,
    a = await service.register({ email, password });
  const old = await db.customerToken.findFirstOrThrow({
    where: { customerId: a.customer.id },
  });
  fail = true;
  const response = await service.requestVerification(a.token);
  expect(response.message).not.toMatch(
    /sent|delivered|PRIVATE_PROVIDER_FAILURE/,
  );
  expect(
    await db.customerToken.findMany({ where: { customerId: a.customer.id } }),
  ).toEqual([old]);
  const known = await service.requestReset({ email }),
    unknown = await service.requestReset({
      email: `${randomUUID()}@example.test`,
    });
  expect(known).toEqual(unknown);
  expect(
    await db.customerToken.count({
      where: { customerId: a.customer.id, purpose: "RESET" },
    }),
  ).toBe(0);
  await service.requestVerification(a.token);
  await service.requestVerification(a.token);
  await expect(service.requestVerification(a.token)).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  expect((await service.session(a.token)).customer?.emailVerified).toBe(false);
});
it("exposes configured delivery capability through the existing HTTP DTO, never provider secrets", async () => {
  vi.stubEnv("COMMERCE_GATEWAY_SECRET", "g".repeat(40));
  vi.stubEnv("STOREFRONT_BASE_URL", config.siteOrigin);
  const handler = createCustomerHandler(
    db,
    createResendCustomerMail(config, async () =>
      Response.json({ id: "accepted" }),
    ),
  );
  const response = await handler(
    new Request("http://backend/api/storefront/v1/auth/session", {
      headers: { "x-commerce-gateway-key": "g".repeat(40) },
    }),
    ["auth", "session"],
  );
  expect(await response.json()).toEqual({
    authenticated: false,
    customer: null,
    emailDeliveryAvailable: true,
  });
});
