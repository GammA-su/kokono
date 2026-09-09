/** Both real applications, dedicated test database/schema, no payments, controlled gacha awards only. */
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
import { createGachaCustomerAdmin } from "../src/modules/gacha/customer-service";
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
        GACHA_CUSTOMER_EXECUTION_ENABLED: "true",
        GACHA_DRAWS_ENABLED: "true",
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
  const banner = await createGachaService(db, authorize).configure({
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
        allocation: 3,
      },
    ],
  });

  const customerAdmin = createGachaCustomerAdmin(db, authorize);
  await customerAdmin.enable({
    bannerId: banner.id,
    enabled: true,
    reason: "Isolated E2E test only",
  });
  const { chromium } = await import(
    pathToFileURL(resolve(website, "node_modules/playwright/index.mjs")).href
  );
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge",
  });
  try {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    const email = `${randomUUID()}@example.test`;
    const registered = await context.request.post(
      base + "/api/storefront/v1/auth/register",
      {
        headers: { origin: base },
        data: {
          email,
          password: randomUUID(),
          displayName: "Gacha E2E customer",
        },
      },
    );
    assert.equal(registered.status(), 200);
    const customer = (await registered.json()).customer;
    await customerAdmin.authorize({
      bannerId: banner.id,
      customerId: customer.id,
      maxPulls: 3,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      reason: "Controlled test units, no payment",
      operationKey: randomUUID(),
    });
    await page.goto(base + "/gacha/account-test");
    const open = page.getByRole("button", { name: "Open ×1", exact: true });
    await page
      .getByText("Administrator-authorized free pull.", { exact: false })
      .waitFor();
    assert.ok(await open.isEnabled());
    assert.ok(
      await page
        .getByRole("button", { name: "Open ×10", exact: true })
        .isDisabled(),
    );
    let posts = 0;
    page.on("request", (request: { method(): string; url(): string }) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith(`/banners/${banner.id}/pulls`)
      )
        posts++;
    });
    const responsePromise = page.waitForResponse(
      (r: { url(): string; request(): { method(): string } }) =>
        r.url().endsWith(`/banners/${banner.id}/pulls`) &&
        r.request().method() === "POST",
    );
    await open.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const first = await response.json();
    assert.equal(posts, 1);
    assert.equal(await db.gachaPull.count(), 1);
    assert.equal(await db.gachaReward.count(), 1);
    const firstReward = await db.gachaReward.findUniqueOrThrow({
      where: { id: first.prizes[0].rewardId },
      include: { reservation: true },
    });
    assert.deepEqual(firstReward.receipt, first);
    assert.equal(firstReward.customerId, customer.id);
    assert.equal(firstReward.reservation.status, "CONFIRMED");
    assert.equal(
      (await context.request.get(base + first.prizes[0].image.url)).status(),
      200,
    );
    await mkdir(".local/customer-gacha-check", { recursive: true });
    await page.getByRole("button", { name: /Skip/i }).waitFor();
    await page.screenshot({
      path: resolve(".local/customer-gacha-check/real-portal.png"),
    });
    // Refresh while the Claude-designed portal is still running: GET existing receipt only.
    await page.reload();
    await page
      .getByRole("heading", { name: "Account prize", exact: true })
      .waitFor();
    assert.equal(posts, 1);
    assert.equal(await db.gachaPull.count(), 1);
    assert.ok(page.url().includes(first.pullId));
    await page.screenshot({
      path: resolve(".local/customer-gacha-check/recovered-result.png"),
    });
    await page.getByRole("button", { name: /Replay/i }).click();
    await page
      .getByRole("heading", { name: first.prizes[0].name, exact: true })
      .waitFor();
    await page
      .getByText(`${first.prizes[0].tier}: ${first.prizes[0].name}`, {
        exact: true,
      })
      .waitFor({ state: "attached" });
    await page.waitForFunction(
      (name: string) =>
        [...document.querySelectorAll("h2")].some(
          (el) =>
            el.textContent === name &&
            Number(getComputedStyle(el).opacity) >= 0.99,
        ),
      first.prizes[0].name,
    );
    await page
      .getByRole("button", { name: "View summary", exact: true })
      .waitFor();
    await page.screenshot({
      path: resolve(".local/customer-gacha-check/real-prize-reveal.png"),
    });
    await page.getByRole("button", { name: /Skip/i }).click();
    assert.equal(await db.gachaPull.count(), 1);
    // Capture server success, drop its response. Browser must recover by the saved request key.
    await page.goto(base + "/gacha/account-test");
    await page.evaluate(() => {
      sessionStorage.removeItem("kokoni:gacha:latest-pull:v1");
    });
    await page.goto(base + "/gacha/account-test");
    let dropped = false;
    await page.route(
      `**/api/storefront/v1/gacha/banners/${banner.id}/pulls`,
      async (route: {
        fetch(): Promise<{ status(): number }>;
        abort(): Promise<void>;
      }) => {
        const actual = await route.fetch();
        assert.equal(actual.status(), 200);
        dropped = true;
        await route.abort();
      },
    );
    await page
      .getByText("Administrator-authorized free pull.", { exact: false })
      .waitFor();
    await open.click();
    await page.getByRole("alert").waitFor();
    assert.ok(dropped);
    assert.equal(await db.gachaReward.count(), 2);
    const pending = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("kokoni:gacha:pending:v1")!),
    );
    assert.ok(pending.requestKey);
    await page.unrouteAll({ behavior: "wait" });
    await page.reload();
    await page
      .getByRole("heading", { name: "Account prize", exact: true })
      .waitFor();
    const secondPull = await db.gachaPull.findUniqueOrThrow({
      where: {
        customerId_requestKey: {
          customerId: customer.id,
          requestKey: pending.requestKey,
        },
      },
    });
    assert.ok(page.url().includes(secondPull.id));
    assert.equal(posts, 2);
    assert.equal(await db.gachaPull.count(), 2);
    // Third real result takes the reduced-motion path at a narrow viewport.
    await page.evaluate(() => {
      sessionStorage.removeItem("kokoni:gacha:latest-pull:v1");
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + "/gacha/account-test");
    await page
      .getByText("Administrator-authorized free pull.", { exact: false })
      .waitFor();
    await open.focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("heading", { name: "Account prize", exact: true })
      .waitFor();
    assert.equal(posts, 3);
    assert.equal(await db.gachaReward.count(), 3);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: resolve(".local/customer-gacha-check/mobile-reduced-result.png"),
    });
    await page.reload();
    await page
      .getByRole("heading", { name: "Account prize", exact: true })
      .waitFor();
    assert.equal(posts, 3);
    const rewards = await context.request.get(
      base + "/api/storefront/v1/gacha/rewards",
    );
    assert.equal(rewards.status(), 200);
    const owned = await rewards.json();
    assert.equal(owned.items.length, 3);
    assert.doesNotMatch(
      JSON.stringify(owned),
      /randomTicket|actorUser|operationKey|requestKey|authorizationId|storageLocation|purchaseCost/,
    );
    for (const row of owned.items) {
      const detail = await context.request.get(
        base + `/api/storefront/v1/gacha/rewards/${row.id}`,
      );
      assert.equal(detail.status(), 200);
      assert.deepEqual((await detail.json()).receipt, row.receipt);
    }
    await page.goto(base + "/gacha/account-test");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Pull history" })
      .getByRole("link", { name: /Account prize/ })
      .first()
      .waitFor();
    assert.equal(
      await db.inventoryMovement.count({ where: { movementType: "GACHA" } }),
      0,
    );
    assert.equal(
      (
        await db.inventoryBalance.findFirstOrThrow({
          where: { merchandiseItemId: item.id },
        })
      ).quantity,
      5,
    );
    assert.equal(
      await db.inventoryReservation.count({
        where: { gachaPullId: { not: null }, status: "CONFIRMED" },
      }),
      3,
    );
    // Real customer claim form, followed by the real internal packing/dispatch queue.
    const rewardId = first.prizes[0].rewardId;
    await page.goto(base + `/gacha/rewards?reward=${rewardId}`);
    await page.getByRole("heading", { name: "Prize delivery" }).waitFor();
    await page
      .getByLabel("Full name", { exact: true })
      .fill("Gacha test customer");
    await page.getByLabel("Address", { exact: true }).fill("12 rue des Fleurs");
    await page.getByLabel("City", { exact: true }).fill("Paris");
    await page.getByLabel("Postcode", { exact: true }).fill("75001");
    await page
      .getByLabel("I confirm this delivery address.", { exact: true })
      .check();
    await page
      .getByRole("button", { name: "Claim for delivery", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Confirmed delivery address" })
      .waitFor();
    await page.reload();
    await page
      .getByRole("heading", { name: "Confirmed delivery address" })
      .waitFor();
    await page.screenshot({
      path: resolve(".local/customer-gacha-check/claimed-mobile.png"),
      fullPage: true,
    });
    const claimed = await db.gachaReward.findUniqueOrThrow({
      where: { id: rewardId },
    });
    assert.equal(claimed.status, "CLAIMED");
    assert.equal(
      await db.fulfillmentRequest.count({
        where: { originReference: rewardId },
      }),
      1,
    );
    const adminContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const login = await adminContext.request.post(
        backendBase + "/api/auth/sign-in/email",
        {
          headers: {
            origin: new URL(
              process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
            ).origin,
          },
          data: { email: actor.email, password },
        },
      );
      assert.equal(login.status(), 200);
      const adminPage = await adminContext.newPage();
      adminPage.on("pageerror", (error: Error) => errors.push(error.message));
      await adminPage.goto(backendBase + "/admin/gacha/rewards?status=CLAIMED");
      await adminPage
        .getByRole("heading", { name: "Gacha rewards", exact: true })
        .waitFor();
      await adminPage.screenshot({
        path: resolve(".local/customer-gacha-check/fulfillment-queue.png"),
        fullPage: true,
      });
      await adminPage.goto(backendBase + `/admin/gacha/rewards/${rewardId}`);
      let form = adminPage
        .locator("form")
        .filter({
          has: adminPage.getByRole("button", {
            name: "Prepare for packing",
            exact: true,
          }),
        });
      await form
        .getByLabel("Reason / dispatch note")
        .fill("Pick checked against reserved SKU");
      await form.getByRole("checkbox").check();
      await form
        .getByRole("button", { name: "Prepare for packing", exact: true })
        .click();
      await adminPage
        .getByRole("button", { name: "Record dispatch", exact: true })
        .waitFor();
      form = adminPage
        .locator("form")
        .filter({
          has: adminPage.getByRole("button", {
            name: "Record dispatch",
            exact: true,
          }),
        });
      await form.getByLabel("Actual carrier").fill("Test carrier");
      await form.getByLabel("Tracking number").fill("CONTROLLED-TEST-123");
      await form
        .getByLabel("Reason / dispatch note")
        .fill("Controlled test dispatch");
      await form.getByRole("checkbox").check();
      await form
        .getByRole("button", { name: "Record dispatch", exact: true })
        .click();
      await adminPage
        .getByRole("button", { name: "Mark delivered", exact: true })
        .waitFor();
      await adminPage.screenshot({
        path: resolve(".local/customer-gacha-check/dispatched-admin.png"),
        fullPage: true,
      });
      form = adminPage
        .locator("form")
        .filter({
          has: adminPage.getByRole("button", {
            name: "Mark delivered",
            exact: true,
          }),
        });
      await form
        .getByLabel("Reason / dispatch note")
        .fill("Controlled delivery confirmation");
      await form.getByRole("checkbox").check();
      await form
        .getByRole("button", { name: "Mark delivered", exact: true })
        .click();
      await adminPage.getByText("DELIVERED", { exact: true }).waitFor();
    } finally {
      await adminContext.close();
    }
    await page.reload();
    await page.getByText("DELIVERED", { exact: true }).waitFor();
    await page.getByText("Test carrier", { exact: false }).waitFor();
    assert.equal(
      await db.inventoryMovement.count({ where: { movementType: "GACHA" } }),
      1,
    );
    assert.equal(
      (
        await db.inventoryBalance.findFirstOrThrow({
          where: { merchandiseItemId: item.id },
        })
      ).quantity,
      4,
    );
    assert.equal(
      await db.inventoryReservation.count({
        where: { gachaPullId: { not: null }, status: "CONFIRMED" },
      }),
      2,
    );
    assert.equal(await db.order.count(), 0);
    assert.equal(
      (await db.gachaReward.findUniqueOrThrow({ where: { id: rewardId } }))
        .status,
      "DELIVERED",
    );
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
  assert.doesNotMatch(output, /DeprecationWarning|Application error/);
  console.log(
    "Customer gacha E2E passed: both production builds, real authenticated pulls and owned rewards, exact portal/reveal, duplicate click, refresh, lost-response request recovery, Skip/replay, mobile reduced motion, history, images, customer claims, admin prepare/dispatch/delivery and PostgreSQL inventory verification. No payments or production inventory used.",
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
