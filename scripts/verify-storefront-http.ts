/** End-to-end HTTP verification against an isolated test schema; never seeds the live catalog. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { requireCustomer } from "../src/modules/customers/service";
import { createCommerceService } from "../src/modules/commerce/service";
import { provisionInternalUser } from "../src/modules/auth/provision";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { createPublicationService } from "../src/modules/publication/service";
import { applyInventoryOperation } from "../src/modules/inventory/operations";
import { saveImage, discardNewImage } from "../src/modules/media/storage";

const url = new URL(process.env.TEST_DATABASE_URL ?? "");
assert.ok(
  url.pathname.endsWith("_test"),
  "TEST_DATABASE_URL must end in _test.",
);
const development = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL)
  : null;
assert.ok(
  !development ||
    url.host !== development.host ||
    url.pathname !== development.pathname,
  "Refusing the development database.",
);
url.searchParams.delete("schema");
const pool = new Pool({ connectionString: url.toString() });
const schema = `test_${randomUUID().replaceAll("-", "")}`;
await pool.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("schema", schema);
const db = createDatabaseClient(url.toString());
let backend: ReturnType<typeof spawn> | undefined;
let site:
  | { server: { address(): { port: number } }; close(): Promise<void> }
  | undefined;
let imageKey: string | undefined;
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
  const password = randomUUID() + randomUUID();
  const actor = await provisionInternalUser(db, {
    name: "Storefront test",
    email: `${randomUUID()}@example.test`,
    password,
  });
  const authorize = async () => ({ id: actor.id });
  const catalog = createCatalogService(db, authorize),
    locations = createLocationService(db, authorize),
    publication = createPublicationService(db, authorize);
  const franchise = await catalog.createFranchise({
    name: "Re:Zero",
    slug: randomUUID(),
  });
  const category = await catalog.createCategory({
    name: "Acrylic Stand",
    slug: randomUUID(),
  });
  await publication.mapCategory({
    categoryId: category.id,
    expectedPublicCategoryId: null,
    publicCategoryId: "af100000-0000-4000-8000-000000000004",
  });
  const lineup = await catalog.createLineup({
    name: "Marine 2026",
    slug: randomUUID(),
    franchiseId: franchise.id,
    releaseDate: "2026-11",
  });
  const item = await catalog.createItem({
    name: "Rem Marine Acrylic Stand",
    slug: "rem-live-http",
    internalSku: randomUUID(),
    lineupId: lineup.id,
    categoryId: category.id,
    privateNotes: "PRIVATE_HTTP_SOURCE",
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNwWPX/PwgzwBgAY44LoVZSKggAAAAASUVORK5CYII=",
    "base64",
  );
  imageKey = await saveImage(
    new File([png], "test.png", { type: "image/png" }),
  );
  const image = await catalog.addImage({
    merchandiseItemId: item.id,
    storageKey: imageKey,
    caption: "Rem stand",
    approvedForPublicUse: true,
  });
  const jp = await locations.create({
    code: "JP-HTTP",
    name: "Japan",
    type: "JAPAN_WAREHOUSE",
    fulfillmentEnabled: true,
  });
  const fr = await locations.create({
    code: "FR-HTTP",
    name: "France",
    type: "FRANCE_HOME",
    fulfillmentEnabled: true,
  });
  for (const [locationId, quantity] of [
    [jp.id, 15],
    [fr.id, 3],
  ] as [string, number][])
    await applyInventoryOperation(
      db,
      {
        merchandiseItemId: item.id,
        destinationLocationId: locationId,
        quantityDelta: quantity,
        movementType: "PURCHASE",
        operationKey: randomUUID(),
      },
      actor.id,
    );
  const listing = await publication.saveListing({
    merchandiseItemId: item.id,
    slug: item.slug,
    publicTitle: item.name,
    sellingPriceAmount: 2490,
    sellingPriceCurrency: "EUR",
    sellingPriceTaxInclusion: "INCLUDED",
    imageIds: [image.id],
  });
  await publication.setPublished({
    merchandiseItemId: item.id,
    published: true,
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
        COMMERCE_GATEWAY_SECRET:
          "isolated-http-test-customer-gateway-32-plus-characters",
        STOREFRONT_BASE_URL: "http://localhost:5173",
        COMMERCE_TEST_CHECKOUT_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  backend.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  backend.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  for (let i = 0; i < 100 && !output.includes("Ready in"); i++) {
    if (backend.exitCode !== null) throw new Error("Backend failed to start.");
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.match(output, /Ready in/);
  const port = output.match(/localhost:(\d+)/)?.[1];
  assert.ok(port, "Backend port not reported.");
  const websitePath = resolve(process.env.PUBLIC_WEBSITE_PATH ?? "../kokoniv2");
  const { startStorefront } = await import(
    pathToFileURL(resolve(websitePath, "server.mjs")).href
  );
  site = await startStorefront({
    allowLoopbackTest: true,
    production: true,
    port: 0,
    siteOrigin: "http://localhost:5173",
    backendOrigin: `http://localhost:${port}`,
    gatewaySecret: "isolated-http-test-customer-gateway-32-plus-characters",
  });
  const base = `http://127.0.0.1:${site!.server.address().port}`;
  const get = (path: string) => fetch(base + path);
  let response = await get(`/products/${listing.slug}`),
    html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /November 2026/);
  assert.match(html, /"availableQuantity":3/);
  assert.match(html, /"price":"24.90"/);
  assert.doesNotMatch(
    html,
    /PRIVATE_HTTP_SOURCE|JP-HTTP|storageKey|purchaseWatch/,
  );
  assert.equal(
    (await get(`/api/storefront/v1/images/${image.id}`)).status,
    200,
  );
  assert.equal(
    (await get(`/api/admin/media/${imageKey.split("/")[1]}`)).status,
    404,
  );
  const signup = await fetch(base + "/api/storefront/v1/auth/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:5173",
    },
    body: JSON.stringify({
      email: `${randomUUID()}@example.test`,
      password: "HTTP-customer-test-password-2026",
    }),
  });
  assert.equal(signup.status, 200);
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const customerSession = cookie.split("=")[1];
  const owner = (await requireCustomer(db, customerSession)).commerceKey;
  const quoteResponse = await fetch(base + "/api/commerce/v1/quote", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:5173",
      cookie,
    },
    body: JSON.stringify({
      lines: [{ listingId: listing.id, quantity: 2 }],
      contact: { email: "isolated@example.test" },
      shippingAddress: {
        name: "HTTP Customer",
        line1: "10 rue de Test",
        city: "Paris",
        postalCode: "75001",
        country: "FR",
      },
    }),
  });
  assert.equal(quoteResponse.status, 200);
  const quote = await quoteResponse.json();
  assert.equal(quote.totalAmount, 5570);
  assert.equal(quote.taxAmount, 928);
  const disabled = await fetch(base + "/api/commerce/v1/checkout", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:5173",
      cookie,
    },
    body: JSON.stringify({
      quoteId: quote.id,
      operationKey: randomUUID(),
      accepted: true,
    }),
  });
  assert.equal(disabled.status, 503);
  // Exercise the actual persistence/read boundary without inventing a payment provider.
  const commerce = createCommerceService(db),
    checkout = await commerce.checkout(
      owner,
      {
        quoteId: quote.id,
        operationKey: randomUUID(),
        accepted: true,
      },
      customerSession,
    );
  assert.equal(checkout.kind, "order");
  if (checkout.kind === "order") {
    const signedIn = await fetch(
      `http://localhost:${port}/api/auth/sign-in/email`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: new URL(
            process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
          ).origin,
        },
        body: JSON.stringify({ email: actor.email, password }),
      },
    );
    assert.equal(signedIn.status, 200);
    const adminCookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    for (const path of [
      "/admin/orders",
      `/admin/orders/${checkout.order.id}`,
    ]) {
      const adminResponse: Response = await fetch(
        `http://localhost:${port}${path}`,
        {
          headers: { cookie: adminCookie },
        },
      );
      assert.equal(adminResponse.status, 200);
      const adminHtml = await adminResponse.text();
      assert.match(adminHtml, /Customer orders|Order operations/);
      assert.doesNotMatch(
        adminHtml,
        /Application error|NEXT_HTTP_ERROR_FALLBACK;500/,
      );
    }
    const customer = await fetch(
      `${base}/api/commerce/v1/orders/${checkout.order.id}`,
      { headers: { cookie } },
    );
    assert.equal(customer.status, 200);
    const customerText = await customer.text();
    assert.doesNotMatch(
      customerText,
      /guestHash|PRIVATE_HTTP_SOURCE|storageLocationId|actorUser/,
    );
    assert.equal(
      (await fetch(`${base}/api/commerce/v1/orders/${checkout.order.id}`))
        .status,
      404,
    );
    assert.match(
      await (await get(`/products/${listing.slug}`)).text(),
      /"availableQuantity":1/,
    );
    const cancelled = await fetch(
      `${base}/api/commerce/v1/orders/${checkout.order.id}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5173",
          cookie,
        },
        body: "{}",
      },
    );
    assert.equal(cancelled.status, 200);
    assert.match(
      await (await get(`/products/${listing.slug}`)).text(),
      /"availableQuantity":3/,
    );
  }
  assert.equal(
    (await fetch(`http://localhost:${port}/api/commerce/v1/config`)).status,
    401,
  );
  const adminOrders = await fetch(`http://localhost:${port}/admin/orders`, {
    redirect: "manual",
  });
  assert.ok([302, 303, 307].includes(adminOrders.status));
  await publication.setSellingPrice({
    merchandiseItemId: item.id,
    sellingPriceAmount: 2990,
    sellingPriceCurrency: "EUR",
  });
  html = await (await get(`/products/${listing.slug}`)).text();
  assert.match(html, /"price":"29.90"/);
  // Small real two-application concurrency smoke; large-history domain load is separate.
  const concurrentReads = await Promise.all(Array.from({ length: 4 }, async () => {
    for (const path of ["/api/storefront/v1/listings", "/api/storefront/v1/facets", `/products/${listing.slug}`]) {
      const start = performance.now();
      const result = await get(path);
      assert.equal(result.status, 200, `Concurrent HTTP read failed: ${path}`);
      await result.arrayBuffer();
      if (performance.now() - start > 10000) throw new Error("Concurrent HTTP read exceeded gateway budget");
    }
    return true;
  }));
  assert.equal(concurrentReads.length, 4);
  await locations.update({
    id: fr.id,
    updatedAt: fr.updatedAt.toISOString(),
    values: {
      code: fr.code,
      name: fr.name,
      type: fr.type,
      parentId: fr.parentId,
      countryCode: fr.countryCode,
      fulfillmentEnabled: fr.fulfillmentEnabled,
      active: false,
      notes: fr.notes,
    },
  });
  html = await (await get(`/products/${listing.slug}`)).text();
  assert.match(html, /Out of stock/);
  assert.match(html, /"availableQuantity":0/);
  await publication.setPublished({
    merchandiseItemId: item.id,
    published: false,
  });
  response = await get(`/products/${listing.slug}`);
  assert.equal(response.status, 404);
  assert.equal(
    (await get(`/api/storefront/v1/images/${image.id}`)).status,
    404,
  );
  const resolved = await fetch(`${base}/api/storefront/v1/listings/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listingIds: [listing.id] }),
  });
  assert.deepEqual((await resolved.json()).unavailableListingIds, [listing.id]);
  assert.equal(
    (
      await db.inventoryBalance.aggregate({
        where: { merchandiseItemId: item.id },
        _sum: { quantity: true },
      })
    )._sum.quantity,
    18,
  );
  assert.doesNotMatch(output, /DeprecationWarning/);
  console.log(
    "Real two-application integration passed: catalog/publication, France stock, quotes, customer isolation, authenticated order admin, disabled payments, reservation availability/release, images, price refresh and unpublication; physical inventory preserved.",
  );
} finally {
  await site?.close();
  if (backend && backend.exitCode === null) {
    backend.kill();
    await new Promise<void>((done) => backend!.once("exit", () => done()));
  }
  if (imageKey) await discardNewImage(imageKey);
  await db.$disconnect();
  assert.match(schema, /^test_[a-f0-9]{32}$/);
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
}
