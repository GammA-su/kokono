/** Both real applications, dedicated test database/schema, no payments or gacha awards. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import { createDatabaseClient } from "../src/db/client";
import { provisionInternalUser } from "../src/modules/auth/provision";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { createGachaService } from "../src/modules/gacha/service";
import { createPublicationService } from "../src/modules/publication/service";
import { applyInventoryOperation } from "../src/modules/inventory/operations";
import { saveImage, discardNewImage } from "../src/modules/media/storage";
const url = new URL(process.env.TEST_DATABASE_URL ?? "");
assert.ok(url.pathname.endsWith("_test"));
const dev = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
assert.ok(!dev || dev.host !== url.host || dev.pathname !== url.pathname);
url.searchParams.delete("schema");
const pool = new Pool({ connectionString: url.toString() }),
  schema = `test_${randomUUID().replaceAll("-", "")}`;
await pool.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("schema", schema);
const db = createDatabaseClient(url.toString());
let imageKey: string | undefined;
let backend: ReturnType<typeof spawn> | undefined,
  storefront:
    | { server: { address(): { port: number } }; close(): Promise<void> }
    | undefined,
  output = "";
const website = resolve(process.env.PUBLIC_WEBSITE_PATH ?? "../kokoniv2"),
  gateway = randomUUID() + randomUUID();
try {
  await promisify(execFile)(
    process.execPath,
    [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
    {
      windowsHide: true,
      env: { ...process.env, DATABASE_URL: url.toString() },
      timeout: 60000,
    },
  );
  const websiteModule = await import(
    pathToFileURL(resolve(website, "server.mjs")).href
  );
  // Fixed configured origin is updated before requests; a random local listener is used.
  let base = "http://127.0.0.1:5173";
  storefront = await websiteModule.startStorefront({
    allowLoopbackTest: true,
    production: true,
    port: 0,
    siteOrigin: base,
    backendOrigin: "http://127.0.0.1:1",
    gatewaySecret: gateway,
  });
  const sitePort = storefront!.server.address().port;
  await storefront!.close();
  storefront = undefined;
  base = `http://127.0.0.1:${sitePort}`;
  backend = spawn(
    process.execPath,
    [resolve("node_modules/next/dist/bin/next"), "start", "-p", "0"],
    {
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: "production",
        CUSTOMER_EMAIL_PROVIDER: "disabled",
        DATABASE_URL: url.toString(),
        COMMERCE_GATEWAY_SECRET: gateway,
        STOREFRONT_BASE_URL: base,
        CUSTOMER_REQUIRE_VERIFIED_EMAIL: "false",
        COMMERCE_TEST_CHECKOUT_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  backend.stdout?.on("data", (c) => (output += c.toString()));
  backend.stderr?.on("data", (c) => (output += c.toString()));
  for (let n = 0; n < 200 && !output.includes("Ready in"); n++) {
    if (backend.exitCode !== null) throw new Error("Backend failed to start");
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(output, /Ready in/);
  const backendBase = `http://localhost:${output.match(/localhost:(\d+)/)![1]}`;
  storefront = await websiteModule.startStorefront({
    allowLoopbackTest: true,
    production: true,
    port: sitePort,
    host: "127.0.0.1",
    siteOrigin: base,
    backendOrigin: backendBase,
    gatewaySecret: gateway,
  });
  const password = randomUUID() + randomUUID(),
    actor = await provisionInternalUser(db, {
      email: `${randomUUID()}@example.test`,
      name: "Customer test operator",
      password,
    });
  const authorize = async () => ({ id: actor.id }),
    catalog = createCatalogService(db, authorize),
    key = randomUUID();
  const franchise = await catalog.createFranchise({
      name: "Account test franchise",
      slug: key,
    }),
    lineup = await catalog.createLineup({
      name: "Account test lineup",
      slug: key,
      franchiseId: franchise.id,
    }),
    category = await catalog.createCategory({ name: "Stand", slug: key });
  const item = await catalog.createItem({
    name: "Account test stand",
    slug: key,
    internalSku: key,
    lineupId: lineup.id,
    categoryId: category.id,
  });
  const location = await createLocationService(db, authorize).create({
    code: `FR-${key}`,
    name: "Test stock",
    type: "FRANCE_HOME",
    countryCode: "FR",
    fulfillmentEnabled: true,
  });
  await applyInventoryOperation(
    db,
    {
      merchandiseItemId: item.id,
      destinationLocationId: location.id,
      quantityDelta: 5,
      movementType: "PURCHASE",
      operationKey: randomUUID(),
    },
    actor.id,
  );
  const publicCategory = await db.publicCategory.findUniqueOrThrow({
    where: { slug: "goods" },
  });
  await db.category.update({
    where: { id: category.id },
    data: { publicCategoryId: publicCategory.id },
  });
  imageKey = await saveImage(
    new File(
      [
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNwWPX/PwgzwBgAY44LoVZSKggAAAAASUVORK5CYII=",
          "base64",
        ),
      ],
      "test.png",
      { type: "image/png" },
    ),
  );
  const image = await db.itemImage.create({
      data: {
        merchandiseItemId: item.id,
        storageKey: imageKey,
        approvedForPublicUse: true,
        caption: "Test stand",
      },
    }),
    fresh = await db.merchandiseItem.findUniqueOrThrow({
      where: { id: item.id },
    });
  await createPublicationService(db, authorize).publishReviewed({
    expectedItemUpdatedAt: fresh.updatedAt.toISOString(),
    expectedListingUpdatedAt: null,
    listing: {
      merchandiseItemId: item.id,
      slug: key,
      publicTitle: "Account test stand",
      sellingPriceAmount: 2490,
      sellingPriceCurrency: "EUR",
      sellingPriceTaxInclusion: "INCLUDED",
      imageIds: [image.id],
    },
  });
  await createGachaService(db, authorize).configure({
    name: "Account gacha banner",
    slug: "account-test",
    active: true,
    terms: "Test only",
    termsVersion: "1",
    prizes: [
      {
        merchandiseItemId: item.id,
        displayName: "Account prize",
        tier: "SR",
        weight: 1,
        allocation: 1,
      },
    ],
  });
  for (const path of [
    "/account",
    "/account/orders",
    "/account/addresses",
    "/gacha/rewards",
    "/checkout",
  ]) {
    const r = await fetch(base + path, { redirect: "manual" });
    assert.equal(r.status, 303, path);
    assert.ok(r.headers.get("location")?.startsWith("/login?returnTo="));
  }
  const anonymous = await fetch(base + "/api/commerce/v1/checkout", {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(anonymous.status, 401);
  const { chromium } = await import(
    pathToFileURL(resolve(website, "node_modules/playwright/index.mjs")).href
  );
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
  });
  try {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage(),
      errors: string[] = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    const email = `${randomUUID()}@example.test`,
      customerPassword = "Customer-browser-password-2026";
    await page.goto(base + "/register");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Display name (optional)").fill("Test customer");
    await page.getByLabel("Password", { exact: true }).fill(customerPassword);
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await page.waitForURL(base + "/account");
    await page.getByRole("heading", { name: "Your account" }).waitFor();
    const cookies = await context.cookies(),
      cookie = cookies.find(
        (c: { name: string }) => c.name === "kokoni_customer",
      )!;
    assert.ok(cookie.httpOnly);
    assert.equal(cookie.sameSite, "Lax");
    assert.equal(cookie.path, "/");
    assert.ok(
      !cookies.some((c: { name: string }) => c.name.includes("better-auth")),
    );
    const html = await (await context.request.get(base + "/account")).text();
    assert.match(html, /Test customer/);
    assert.doesNotMatch(html, new RegExp(cookie.value));
    assert.doesNotMatch(html, /passwordHash|commerceKey/);
    await page
      .getByLabel("Display name", { exact: true })
      .fill("Updated customer");
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.getByText("Profile saved.", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Addresses", exact: true }).click();
    await page.getByLabel("Label", { exact: true }).fill("Home");
    await page.getByLabel("Recipient name").fill("Test Customer");
    await page.getByLabel("Address", { exact: true }).fill("10 rue de Test");
    await page.getByLabel("Postcode").fill("75001");
    await page.getByLabel("City").fill("Paris");
    await page.getByLabel("Default shipping address").check();
    await page.getByRole("button", { name: "Save address" }).click();
    await page
      .getByRole("heading", { name: "Home · Default shipping" })
      .waitFor();
    await mkdir(resolve(".local/customer-check"), { recursive: true });
    await page.screenshot({
      path: resolve(".local/customer-check/account-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForURL(base + "/login");
    await page.goto(base + "/account");
    await page.waitForURL(/\/login\?returnTo=/);
    const revoked = await fetch(base + "/api/storefront/v1/auth/session", {
      headers: { cookie: `kokoni_customer=${cookie.value}` },
    });
    assert.equal((await revoked.json()).authenticated, false);
    await page.goto(base + `/products/${key}`);
    await page.getByRole("button", { name: /Add .* to cart/i }).click();
    await page.getByRole("button", { name: "Checkout", exact: true }).click();
    await page.waitForURL(/\/login\?returnTo=%2Fcheckout/);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(customerPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(base + "/checkout");
    await page.getByText("Account test stand", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Email", { exact: true }).inputValue(),
      email,
    );
    assert.equal(
      await page.getByLabel("Address", { exact: true }).first().inputValue(),
      "10 rue de Test",
    );
    await page.goto(base + "/account");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForURL(base + "/login");
    await page.goto(base + "/gacha/account-test");
    await page
      .getByRole("link", { name: "Sign in to prepare for pulling" })
      .click();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(customerPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(base + "/gacha/account-test");
    assert.ok(
      await page
        .getByRole("button", { name: "Open ×1", exact: true })
        .isDisabled(),
    );
    await page.goto(base + "/gacha/rewards");
    await page
      .getByText("Your awarded prizes are saved to your account", { exact: false })
      .waitFor();
    assert.equal(await db.gachaPull.count(), 0);
    await page.goto(base + "/account");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: resolve(".local/customer-check/account-mobile.png"),
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForURL(base + "/login");
    await page.screenshot({
      path: resolve(".local/customer-check/login-mobile.png"),
      fullPage: true,
    });
    await page.getByLabel("Email", { exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .getByLabel("Password", { exact: true })
        .evaluate((e: Element) => e === document.activeElement),
      true,
    );
    assert.deepEqual(errors, []);
    assert.equal(await db.customer.count(), 1);
    assert.equal(await db.customerAddress.count(), 1);
    await context.close();
  } finally {
    await browser.close();
  }
  assert.doesNotMatch(output, /DeprecationWarning|Application error/);
  console.log(
    "Customer E2E passed: real registration/session/profile/address/logout, protected SSR, cart preserved through login, checkout prefill, gacha login return without pulls, mobile/keyboard and DB verification.",
  );
} finally {
  await storefront?.close();
  if (backend && backend.exitCode === null) {
    backend.kill();
    await new Promise<void>((done) => backend!.once("exit", () => done()));
  }
  await db.$disconnect();
  if (imageKey) await discardNewImage(imageKey);
  assert.match(schema, /^test_[a-f0-9]{32}$/);
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
}
