import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, inject, it, vi } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import {
  createCustomerService,
  requireCustomer,
  secretHash,
  setCustomerDisabled,
  customerRateLimit,
  type CustomerMail,
} from "../src/modules/customers/service";
import { createCustomerHandler } from "../src/modules/customers/http";
import { createCommerceHandler } from "../src/modules/commerce/http";
import { createAuth } from "../src/lib/auth-config";
import { assertInternalAccount } from "../src/modules/auth/authorization";
// This suite covers account mail, which is the only kind the customer service issues.
// Order mail is raised by the commerce module and is asserted in its own suite.
type AccountMail = Extract<Parameters<CustomerMail>[0], { token: string }>;
const db = createDatabaseClient(inject("testDatabaseUrl")),
  sent: AccountMail[] = [];
const collect = async (m: Parameters<CustomerMail>[0]) => {
  if (!("token" in m))
    throw new Error(`Customer service must not raise ${m.purpose} mail.`);
  sent.push(m);
};
const service = createCustomerService(db, collect),
  handler = createCustomerHandler(db, collect);
const password = "Correct-horse-staple-2026",
  email = () => `${randomUUID()}@example.test`;
let actor: string;
beforeAll(async () => {
  actor = (
    await db.user.create({
      data: {
        id: randomUUID(),
        email: email(),
        name: "Customer manager",
        isInternal: true,
      },
    })
  ).id;
  vi.stubEnv("COMMERCE_GATEWAY_SECRET", "c".repeat(48));
  vi.stubEnv("STOREFRONT_BASE_URL", "http://localhost:5173");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
});
const register = () => service.register({ email: email(), password });
function request(
  path: string,
  body?: unknown,
  token = "",
  origin = "http://localhost:5173",
) {
  return handler(
    new Request(`http://localhost/api/storefront/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Commerce-Gateway-Key": "c".repeat(48),
        "X-Customer-Client": secretHash(randomUUID()),
        "X-Customer-Session": token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    path.split("/"),
  );
}
it("registers normalized unique customers with library hashes and separate identity", async () => {
  const mail = email(),
    r = await service.register({
      email: ` ${mail.toUpperCase()} `,
      password,
      displayName: "Rem",
    });
  expect(r.customer.email).toBe(mail);
  expect(r.customer.emailVerified).toBe(false);
  const c = await db.customer.findUniqueOrThrow({
    where: { id: r.customer.id },
  });
  expect(c.passwordHash).not.toContain(password);
  expect(c.status).toBe("PENDING_VERIFICATION");
  expect(await db.user.findUnique({ where: { email: mail } })).toBeNull();
  await expect(
    service.register({ email: mail, password }),
  ).rejects.toMatchObject({ code: "REGISTRATION_UNAVAILABLE" });
  await expect(
    service.register({ email: email(), password: "short" }),
  ).rejects.toThrow();
  await expect(assertInternalAccount(db, c.id)).rejects.toThrow();
  expect(JSON.stringify(r.customer)).not.toMatch(
    /password|commerceKey|token|isInternal/,
  );
});
it("logs in generically, rotates sessions, expires and revokes them", async () => {
  const a = await register();
  for (const input of [
    { email: a.customer.email, password: "wrong-password" },
    { email: email(), password },
  ])
    await expect(service.login(input)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      message: "Email or password is incorrect.",
    });
  const b = await service.login({ email: a.customer.email, password }, a.token);
  expect(b.token).not.toBe(a.token);
  expect((await service.session(a.token)).authenticated).toBe(false);
  expect((await service.session(b.token)).authenticated).toBe(true);
  expect(
    await db.customerSession.findUnique({ where: { tokenHash: b.token } }),
  ).toBeNull();
  await db.customerSession.update({
    where: { tokenHash: secretHash(b.token) },
    data: { expiresAt: new Date(0) },
  });
  await expect(requireCustomer(db, b.token)).rejects.toThrow();
  const c = await service.login({ email: a.customer.email, password });
  await service.logout(c.token);
  expect((await service.session(c.token)).authenticated).toBe(false);
});
it("disables/re-enables without destroying records; admin/customer sessions never cross", async () => {
  const a = await register();
  await expect(
    setCustomerDisabled(db, async () => ({ id: a.customer.id }), {
      id: a.customer.id,
      disabled: true,
    }),
  ).rejects.toThrow();
  await setCustomerDisabled(db, async () => ({ id: actor }), {
    id: a.customer.id,
    disabled: true,
  });
  await expect(
    service.login({ email: a.customer.email, password }),
  ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  await expect(requireCustomer(db, a.token)).rejects.toThrow();
  await setCustomerDisabled(db, async () => ({ id: actor }), {
    id: a.customer.id,
    disabled: false,
  });
  const b = await service.login({ email: a.customer.email, password });
  expect(b.customer.id).toBe(a.customer.id);
  const auth = createAuth(db, {
    baseURL: "http://localhost:3000",
    secret: "a".repeat(48),
  });
  expect(
    await auth.api.getSession({
      headers: new Headers({ cookie: `kokoni_customer=${b.token}` }),
    }),
  ).toBeNull();
  await expect(requireCustomer(db, "admin-session")).rejects.toThrow();
  expect(
    await db.customerEvent.count({ where: { customerId: a.customer.id } }),
  ).toBeGreaterThan(3);
});
it("uses expiring, single-use hashed reset tokens and revokes every session", async () => {
  const a = await register();
  const result = await service.requestReset({ email: a.customer.email });
  expect(await service.requestReset({ email: email() })).toEqual(result);
  const m = sent.findLast(
    (m) => m.email === a.customer.email && m.purpose === "RESET",
  )!;
  expect(
    await db.customerToken.findUnique({ where: { tokenHash: m.token } }),
  ).toBeNull();
  await service.redeem("RESET", { token: m.token, password: password + "new" });
  await expect(
    service.redeem("RESET", { token: m.token, password }),
  ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  expect((await service.session(a.token)).authenticated).toBe(false);
  await service.login({ email: a.customer.email, password: password + "new" });
  await service.requestReset({ email: a.customer.email });
  const next = sent.at(-1)!;
  await db.customerToken.update({
    where: { tokenHash: secretHash(next.token) },
    data: { expiresAt: new Date(0) },
  });
  await expect(
    service.redeem("RESET", { token: next.token, password }),
  ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
});
it("verification tokens are single-use and never auto-verify without delivery", async () => {
  const a = await register(),
    m = sent.findLast(
      (m) => m.email === a.customer.email && m.purpose === "VERIFY",
    )!;
  // Policy A gates checkout; the boolean alone no longer decides this.
  vi.stubEnv("CUSTOMER_VERIFICATION_POLICY", "all");
  await expect(requireCustomer(db, a.token, "CHECKOUT")).rejects.toMatchObject({
    code: "EMAIL_VERIFICATION_REQUIRED",
  });
  await service.redeem("VERIFY", { token: m.token });
  expect(
    (await requireCustomer(db, a.token, "CHECKOUT")).emailVerifiedAt,
  ).toBeTruthy();
  await expect(
    service.redeem("VERIFY", { token: m.token }),
  ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  const b = await register(),
    expired = sent.at(-1)!;
  await db.customerToken.update({
    where: { tokenHash: secretHash(expired.token) },
    data: { expiresAt: new Date(0) },
  });
  await expect(
    service.redeem("VERIFY", { token: expired.token }),
  ).rejects.toThrow();
  await expect(
    service.redeem("VERIFY", { token: "x".repeat(43) }),
  ).rejects.toThrow();
  const noMail = createCustomerService(db),
    c = await noMail.register({ email: email(), password });
  expect(c.customer.emailVerified).toBe(false);
  expect(
    await db.customerToken.count({ where: { customerId: c.customer.id } }),
  ).toBe(0);
  expect((await service.session(b.token)).customer?.emailVerified).toBe(false);
  vi.stubEnv("CUSTOMER_REQUIRE_VERIFIED_EMAIL", "false");
});
it("enforces address ownership, default uniqueness and France policy", async () => {
  const a = await register(),
    b = await register(),
    input = {
      label: "Home",
      name: "Test Customer",
      line1: "10 rue de Test",
      city: "Paris",
      postalCode: "75001",
      country: "FR",
      defaultShipping: true,
    };
  const first = await service.saveAddress(a.token, input),
    second = await service.saveAddress(a.token, { ...input, label: "Other" });
  expect(
    (await service.addresses(a.token)).filter((a) => a.defaultShipping),
  ).toHaveLength(1);
  await expect(
    service.saveAddress(b.token, { ...input, id: first.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(service.deleteAddress(b.token, first.id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(await service.addresses(b.token)).toHaveLength(0);
  await service.deleteAddress(a.token, second.id);
  await expect(
    service.saveAddress(a.token, { ...input, country: "JP" }),
  ).rejects.toThrow();
  await expect(
    service.saveAddress(a.token, { ...input, postalCode: "97100" }),
  ).rejects.toThrow();
  await expect(
    service.profile(a.token, { displayName: "x", status: "ACTIVE" }),
  ).rejects.toThrow();
  expect(
    (
      await service.profile(a.token, {
        displayName: "Emilia",
        lastName: "Test",
      })
    ).displayName,
  ).toBe("Emilia");
});
it("protects API origin, gateway, requests, anonymous access and private DTOs", async () => {
  expect(
    (
      await request(
        "auth/register",
        { email: email(), password },
        "",
        "https://evil.test",
      )
    ).status,
  ).toBe(403);
  expect((await request("customer/orders")).status).toBe(401);
  const response = await request("auth/register", { email: email(), password }),
    value = await response.json(),
    token = response.headers.get("x-customer-session")!;
  expect(response.status).toBe(200);
  expect(JSON.stringify(value)).not.toMatch(
    /password|token|commerceKey|status|isInternal/,
  );
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect((await request("auth/session", undefined, token)).status).toBe(200);
  const invalid = new Request(
    "http://localhost/api/storefront/v1/auth/session",
    { headers: { cookie: `better-auth.session_token=${token}` } },
  );
  expect((await handler(invalid, ["auth", "session"])).status).toBe(401);
  expect(
    (
      await request("auth/register", {
        email: email(),
        password,
        role: "admin",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("auth/register", {
        email: email(),
        password: "x".repeat(20000),
      })
    ).status,
  ).toBe(409);
  const commerce = createCommerceHandler(db);
  expect(
    (
      await commerce(
        new Request("http://localhost/api/commerce/v1/checkout", {
          method: "POST",
          headers: {
            origin: "http://localhost:5173",
            "x-commerce-gateway-key": "c".repeat(48),
            "content-type": "application/json",
          },
          body: "{}",
        }),
        ["checkout"],
      )
    ).status,
  ).toBe(401);
  expect(
    (await request("auth/logout", {}, token)).headers.get("x-customer-session"),
  ).toBe("clear");
});
it("rate limits concurrent attempts durably", async () => {
  const key = randomUUID();
  const result = await Promise.allSettled(
    Array.from({ length: 12 }, () => customerRateLimit(db, key, 4)),
  );
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(4);
});
