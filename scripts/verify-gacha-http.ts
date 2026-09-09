/** Real route/form checks against a unique test schema; no live catalog or inventory changes. */
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
import { applyInventoryOperation } from "../src/modules/inventory/operations";
const url = new URL(process.env.TEST_DATABASE_URL ?? "");
assert.ok(
  url.pathname.endsWith("_test"),
  "Only a dedicated _test database is allowed.",
);
const development = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL)
  : null;
assert.ok(
  !development ||
    url.host !== development.host ||
    url.pathname !== development.pathname,
  "Refusing development database.",
);
url.searchParams.delete("schema");
const pool = new Pool({ connectionString: url.toString() }),
  schema = `test_${randomUUID().replaceAll("-", "")}`;
await pool.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("schema", schema);
const db = createDatabaseClient(url.toString());
let backend: ReturnType<typeof spawn> | undefined;
let storefront:
  | { server: { address(): { port: number } }; close(): Promise<void> }
  | undefined;
let output = "";
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
  const password = randomUUID() + randomUUID(),
    actor = await provisionInternalUser(db, {
      name: "Gacha browser verifier",
      email: `${randomUUID()}@example.test`,
      password,
    }),
    authorize = async () => ({ id: actor.id });
  const catalog = createCatalogService(db, authorize),
    locations = createLocationService(db, authorize),
    gacha = createGachaService(db, authorize),
    key = randomUUID();
  const franchise = await catalog.createFranchise({
      name: "Gacha HTTP fixture",
      slug: key,
    }),
    lineup = await catalog.createLineup({
      name: "Marine",
      slug: key,
      franchiseId: franchise.id,
    }),
    category = await catalog.createCategory({
      name: "Acrylic Stand",
      slug: key,
    });
  const item = await catalog.createItem({
    name: "Rem test stand",
    japaneseName: "レム アクリルスタンド",
    slug: key,
    internalSku: key,
    lineupId: lineup.id,
    categoryId: category.id,
    privateNotes: "PRIVATE_HTTP_GACHA",
  });
  const location = await locations.create({
    code: `FR-${key}`,
    name: "Private physical box",
    type: "FRANCE_HOME",
    countryCode: "FR",
    fulfillmentEnabled: true,
  });
  await applyInventoryOperation(
    db,
    {
      merchandiseItemId: item.id,
      destinationLocationId: location.id,
      quantityDelta: 10,
      movementType: "PURCHASE",
      operationKey: randomUUID(),
    },
    actor.id,
  );
  const banner = await gacha.configure({
    name: "Reviewed test banner",
    slug: "reviewed-test-banner",
    active: true,
    terms: "No-charge fixture terms",
    termsVersion: "1",
    prizes: [
      {
        merchandiseItemId: item.id,
        displayName: "Public Rem stand",
        tier: "Standard",
        weight: 1,
        allocation: 2,
      },
    ],
  });
  const pull = await gacha.grant({
    bannerId: banner.id,
    configurationId: banner.configurationId,
    operationKey: randomUUID(),
    customerReference: "PRIVATE_CUSTOMER_REFERENCE",
    reason: "Fixture award",
  });
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
        GACHA_DRAWS_ENABLED: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  backend.stdout?.on("data", (c) => {
    output += c.toString();
  });
  backend.stderr?.on("data", (c) => {
    output += c.toString();
  });
  for (let n = 0; n < 150 && !output.includes("Ready in"); n++) {
    if (backend.exitCode !== null) throw new Error("Server failed to start.");
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.match(output, /Ready in/);
  const port = output.match(/localhost:(\d+)/)?.[1];
  assert.ok(port);
  const base = `http://localhost:${port}`;
  const signin = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000")
        .origin,
    },
    body: JSON.stringify({ email: actor.email, password }),
  });
  assert.equal(signin.status, 200);
  const cookie = signin.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  for (const path of [
    "/admin/gacha",
    "/admin/gacha/new",
    `/admin/gacha/${banner.id}`,
    `/admin/gacha/${banner.id}/edit`,
    `/admin/gacha/${banner.id}/configurations/${banner.configurationId}`,
  ]) {
    const response = await fetch(base + path, { headers: { cookie } }),
      html = await response.text();
    assert.equal(response.status, 200, path);
    assert.doesNotMatch(html, /Application error|NEXT_HTTP_ERROR_FALLBACK;500/);
    const anonymous = await fetch(base + path, { redirect: "manual" });
    assert.ok(
      [302, 303, 307].includes(anonymous.status),
      "Admin route requires authorization.",
    );
  }
  const oddsPath = "/api/storefront/v1/gacha/by-slug/reviewed-test-banner/odds",
    api = await fetch(base + oddsPath);
  assert.equal(api.status, 200);
  assert.match(api.headers.get("cache-control") ?? "", /no-store/);
  const data = await api.json();
  assert.equal(data.prizes[0].probability.percentage, "100");
  assert.equal(data.prizes[0].remaining, 1);
  assert.doesNotMatch(
    JSON.stringify(data),
    /PRIVATE_CUSTOMER_REFERENCE|PRIVATE_HTTP_GACHA|actorUser|storageLocation/,
  );
  const publicPage = await fetch(`${base}/gacha/reviewed-test-banner/odds`),
    html = await publicPage.text();
  assert.equal(publicPage.status, 200);
  assert.match(html, /100/);
  assert.doesNotMatch(
    html,
    /PRIVATE_CUSTOMER_REFERENCE|PRIVATE_HTTP_GACHA|Private physical box/,
  );
  assert.equal((await fetch(`${base}/gacha/unknown-banner/odds`)).status, 404);
  assert.equal((await fetch(base + oddsPath, { method: "POST" })).status, 405);
  const { startStorefront } = await import(
    pathToFileURL(
      resolve(process.env.PUBLIC_WEBSITE_PATH ?? "../kokoniv2", "server.mjs"),
    ).href
  );
  storefront = await startStorefront({
    allowLoopbackTest: true,
    production: true,
    port: 0,
    siteOrigin: "http://localhost:5173",
    backendOrigin: base,
  });
  const publicBase = `http://127.0.0.1:${storefront!.server.address().port}`;
  const publicRoute = await fetch(`${publicBase}/gacha/reviewed-test-banner`);
  assert.equal(publicRoute.status, 200);
  const siteHtml = await publicRoute.text();
  assert.match(siteHtml, /Reviewed test banner/);
  assert.match(siteHtml, /Customer pulls are not available yet/);
  assert.doesNotMatch(
    siteHtml,
    /PRIVATE_CUSTOMER_REFERENCE|PRIVATE_HTTP_GACHA|actorUserId|randomTicket/,
  );
  const siteOdds = await fetch(publicBase + oddsPath);
  assert.equal(siteOdds.status, 200);
  assert.doesNotMatch(
    await siteOdds.text(),
    /totalWeight|randomTicket|PRIVATE_CUSTOMER_REFERENCE/,
  );
  assert.equal(
    (
      await fetch(
        `${publicBase}/api/storefront/v1/gacha/banners/${banner.id}/pull`,
        { method: "POST" },
      )
    ).status,
    404,
  );
  assert.equal(
    await db.gachaPull.count({ where: { bannerId: banner.id } }),
    1,
    "Public browsing must never execute a pull.",
  );
  if (process.argv.includes("--browser")) {
    const { chromium } = await import(
      pathToFileURL(
        resolve(
          process.env.PUBLIC_WEBSITE_PATH ?? "../kokoniv2",
          "node_modules/playwright/index.mjs",
        ),
      ).href
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
      });
      await context.request.post(`${base}/api/auth/sign-in/email`, {
        headers: {
          origin: new URL(
            process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
          ).origin,
        },
        data: { email: actor.email, password },
      });
      const page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await page.goto(`${base}/admin/gacha/new`);
      await page
        .getByLabel("Name", { exact: true })
        .fill("Browser created banner");
      await page
        .getByLabel("Slug", { exact: true })
        .fill("browser-created-banner");
      await page
        .getByLabel("Public terms", { exact: true })
        .fill("No-charge reviewed terms");
      await page.getByLabel("Find catalog merchandise").fill("Rem");
      await page
        .getByRole("button", { name: "Search catalog", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Add prize", exact: true })
        .click();
      await page.getByLabel("Allocation for Rem test stand").fill("2");
      await page.getByLabel("Activate administrator grants").check();
      await page.getByLabel("I reviewed the public fields").check();
      await page
        .getByRole("button", { name: "Create banner and reserve pool" })
        .click();
      await page.waitForURL(/\/admin\/gacha\/[a-f0-9-]+$/);
      const created = await db.gachaBanner.findUniqueOrThrow({
        where: { slug: "browser-created-banner" },
      });
      assert.ok(created.currentConfigurationId);
      const grantForm = page.locator("form").filter({
        has: page.getByRole("heading", {
          name: "Grant one draw",
          exact: true,
        }),
      });
      await grantForm
        .getByLabel("Customer reference")
        .fill("BROWSER_RECIPIENT");
      await grantForm
        .getByLabel("Reason / reference")
        .fill("Browser test grant");
      await grantForm.getByRole("checkbox").check();
      await grantForm
        .getByRole("button", { name: "Grant one draw", exact: true })
        .click();
      await page.getByText("BROWSER_RECIPIENT", { exact: false }).waitFor();
      await page
        .getByRole("button", { name: "Run simulation", exact: true })
        .click();
      await page
        .getByRole("columnheader", { name: "Observed count", exact: true })
        .waitFor();
      assert.equal(
        await db.gachaPull.count({ where: { bannerId: created.id } }),
        1,
      );
      await page.getByText("Finalize award", { exact: true }).click();
      const consume = page.locator("form").filter({
        has: page.getByRole("heading", {
          name: "Record physical handover / dispatch",
          exact: true,
        }),
      });
      await consume
        .getByLabel("Physical handover / dispatch reference and note")
        .fill("Browser handover");
      await consume.getByRole("checkbox").check();
      await consume
        .getByRole("button", {
          name: "Record physical handover / dispatch",
          exact: true,
        })
        .click();
      await page.getByText("Movement:", { exact: false }).waitFor();
      const actual = await db.gachaPull.findFirstOrThrow({
        where: { bannerId: created.id },
      });
      assert.equal(actual.status, "CONSUMED");
      await mkdir(resolve(".local/gacha-check"), { recursive: true });
      await page.screenshot({
        path: resolve(".local/gacha-check/admin-desktop.png"),
        fullPage: true,
      });
      await page.goto(`${base}/gacha/browser-created-banner/odds`);
      await page
        .getByRole("heading", { name: "Browser created banner", exact: true })
        .waitFor();
      await page.screenshot({
        path: resolve(".local/gacha-check/public-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: resolve(".local/gacha-check/public-mobile.png"),
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        "Public odds page overflows mobile viewport.",
      );
      await page.goto(`${base}/admin/gacha/${created.id}`);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        "Admin page overflows mobile viewport.",
      );
      assert.deepEqual(errors, [], "Browser runtime errors");
      const countBeforePublic = await db.gachaPull.count();
      await page.goto(`${publicBase}/gacha/reviewed-test-banner`);
      await page
        .getByRole("heading", { name: "Reviewed test banner", exact: true })
        .waitFor();
      assert.ok(
        await page
          .getByRole("button", { name: "Open ×1", exact: true })
          .isDisabled(),
      );
      await page
        .getByRole("button", { name: "Odds / Drop rates", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Odds / Drop rates", exact: true })
        .getByText("100%", { exact: true })
        .waitFor();
      await page.keyboard.press("Escape");
      await page.screenshot({
        path: resolve(".local/gacha-check/kokoniv2-live-mobile.png"),
        fullPage: true,
      });
      assert.equal(await db.gachaPull.count(), countBeforePublic);
      assert.deepEqual(errors, [], "Public gacha browser runtime errors");
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await gacha.finalize({
    pullId: pull.id,
    action: "CANCEL",
    reason: "Verification complete",
  });
  assert.doesNotMatch(output, /DeprecationWarning|Application error/);
  console.log(
    "Gacha verification passed: authenticated admin routes, public odds/privacy, immutable version page" +
      (process.argv.includes("--browser")
        ? ", browser creation/grant/simulation/consumption and responsive layouts."
        : "."),
  );
} finally {
  await storefront?.close();
  if (backend && backend.exitCode === null) {
    backend.kill();
    await new Promise<void>((done) => backend!.once("exit", () => done()));
  }
  await db.$disconnect();
  assert.match(schema, /^test_[a-f0-9]{32}$/);
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
}
