/** Local disposable restore drill. Requires the existing local Docker PostgreSQL service. */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, cp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { createDatabaseClient } from "../src/db/client";
import { createCatalogService } from "../src/modules/catalog/service";
import { createLocationService } from "../src/modules/locations/service";
import { applyInventoryOperation, reconcileInventory } from "../src/modules/inventory/operations";
import { createPublicationService } from "../src/modules/publication/service";
import { createCommerceService } from "../src/modules/commerce/service";
import { createCustomerService, requireCustomer } from "../src/modules/customers/service";
import { createGachaService } from "../src/modules/gacha/service";
import { createGachaCustomerAdmin, createCustomerGachaService } from "../src/modules/gacha/customer-service";
import { saveImage } from "../src/modules/media/storage";

const url = new URL(process.env.TEST_DATABASE_URL ?? "");
if (process.env.NODE_ENV === "production" || !url.pathname.endsWith("_test") || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Local test database required");
const key = randomUUID().replaceAll("-", ""), schema = `test_restore_${key}`, target = `restore_${key}_test`, role = `test_runtime_${key}`;
const root = resolve(".local/audit"), sourceMedia = resolve(root, `source_${key}`), restoredMedia = resolve(root, `restored_${key}`);
url.searchParams.delete("schema");
const pool = new Pool({ connectionString: url.toString() });
url.searchParams.set("schema", schema);
const db = createDatabaseClient(url.toString());
let restored: ReturnType<typeof createDatabaseClient> | undefined, backend: ReturnType<typeof spawn> | undefined;
let site: { close: () => Promise<void>; server: { address: () => { port: number } } } | undefined;
let targetCreated = false, roleCreated = false;
const exec = promisify(execFile);
try {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await exec(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 60000 });
  process.env.MERCHANDISE_UPLOAD_DIR = sourceMedia;
  process.env.GACHA_DRAWS_ENABLED = "true";
  process.env.GACHA_CUSTOMER_EXECUTION_ENABLED = "true";
  process.env.CUSTOMER_REQUIRE_VERIFIED_EMAIL = "false";
  const actor = randomUUID();
  await db.user.create({ data: { id: actor, name: "Restore operator", email: `${actor}@example.test`, isInternal: true } });
  const authorize = async () => ({ id: actor }), catalog = createCatalogService(db, authorize);
  const franchise = await catalog.createFranchise({ name: "Restore franchise", slug: "restore" });
  const lineup = await catalog.createLineup({ franchiseId: franchise.id, name: "Restore release", slug: "restore", releaseDate: "2026-11" });
  const category = await catalog.createCategory({ name: "Restore category", slug: "restore" });
  const item = await catalog.createItem({ name: "Restore merchandise", japaneseName: "復元テスト", slug: "restore-item", internalSku: "RESTORE", lineupId: lineup.id, categoryId: category.id });
  const location = await createLocationService(db, authorize).create({ name: "Restore France", code: "RESTORE-FR", type: "FRANCE_HOME", fulfillmentEnabled: true });
  await applyInventoryOperation(db, { merchandiseItemId: item.id, destinationLocationId: location.id, movementType: "PURCHASE", quantityDelta: 10, acquisitionUnitCostAmount: 500, acquisitionUnitCostCurrency: "EUR", operationKey: randomUUID() }, actor);
  const mediaKey = await saveImage(new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNwWPX/PwgzwBgAY44LoVZSKggAAAAASUVORK5CYII=", "base64")], "restore.png"));
  const image = await db.itemImage.create({ data: { merchandiseItemId: item.id, storageKey: mediaKey, approvedForPublicUse: true } });
  const publicCategory = await db.publicCategory.findUniqueOrThrow({ where: { slug: "goods" } });
  await db.category.update({ where: { id: category.id }, data: { publicCategoryId: publicCategory.id } });
  const publication = createPublicationService(db, authorize);
  const listing = await publication.saveListing({ merchandiseItemId: item.id, slug: item.slug, sellingPriceAmount: 1500, sellingPriceCurrency: "EUR", sellingPriceTaxInclusion: "INCLUDED" });
  await publication.setPublished({ merchandiseItemId: item.id, published: true });
  const user = await createCustomerService(db).register({ email: `${key}@example.test`, password: randomUUID() });
  const owner = (await requireCustomer(db, user.token)).commerceKey, commerce = createCommerceService(db);
  const quote = await commerce.quote(owner, { lines: [{ listingId: listing.id, quantity: 1 }], contact: { email: "restore@example.test" }, shippingAddress: { name: "Restore customer", line1: "1 rue Test", city: "Paris", postalCode: "75001", country: "FR" } });
  const order = await commerce.checkout(owner, { quoteId: quote.id, operationKey: randomUUID(), accepted: true }, user.token);
  assert.equal(order.kind, "order");
  const banner = await createGachaService(db, authorize).configure({ name: "Restore banner", slug: "restore", active: true, terms: "No-charge restore fixture", termsVersion: "test", prizes: [{ merchandiseItemId: item.id, displayName: item.name, tier: "COMMON", weight: 1, allocation: 2 }] });
  const admin = createGachaCustomerAdmin(db, authorize);
  await admin.enable({ bannerId: banner.id, enabled: true, reason: "Restore fixture" });
  await admin.authorize({ bannerId: banner.id, customerId: user.customer.id, operationKey: randomUUID(), maxPulls: 1, expiresAt: new Date(Date.now() + 86400000).toISOString(), reason: "Restore fixture" });
  const receipt = await createCustomerGachaService(db).pull(user.token, { bannerId: banner.id, configurationId: banner.configurationId, count: 1, requestKey: randomUUID() });
  // No writes occur between this database snapshot and its paired media snapshot.
  const dump = await exec("docker", ["exec", "kokono-inv-postgres-1", "pg_dump", "-U", "kokono", "-d", url.pathname.slice(1), "-n", schema, "-Fc"], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, "restore-fixture.dump"), dump.stdout);
  await cp(sourceMedia, restoredMedia, { recursive: true });
  await pool.query(`CREATE DATABASE "${target}"`); targetCreated = true;
  await new Promise<void>((done, reject) => {
    const child = spawn("docker", ["exec", "-i", "kokono-inv-postgres-1", "pg_restore", "-U", "kokono", "-d", target, "--no-owner", "--no-privileges", "--exit-on-error"], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? done() : reject(new Error("Fixture restore failed")));
    child.stdin.end(dump.stdout);
  });
  const password = randomUUID() + randomUUID();
  await pool.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`); roleCreated = true;
  const restoredUrl = new URL(url); restoredUrl.pathname = "/" + target;
  const adminPool = new Pool({ connectionString: restoredUrl.toString() });
  try {
    await adminPool.query(`GRANT CONNECT ON DATABASE "${target}" TO "${role}"`);
    await adminPool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await adminPool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    await adminPool.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
    await adminPool.query(`REVOKE ALL ON "${schema}"._prisma_migrations FROM "${role}"`);
  } finally { await adminPool.end(); }
  restoredUrl.username = role; restoredUrl.password = password;
  restored = createDatabaseClient(restoredUrl.toString());
  assert.equal(await restored.order.count(), 1);
  assert.equal(await restored.gachaReward.count(), 1);
  assert.deepEqual(await reconcileInventory(restored, item.id), []);
  await assert.rejects(restored.$executeRawUnsafe(`CREATE TABLE "${schema}".forbidden(id int)`));
  // Also exercise a permitted ledger command under the non-owner role.
  await applyInventoryOperation(restored, { merchandiseItemId: item.id, destinationLocationId: location.id, movementType: "PURCHASE", quantityDelta: 1, operationKey: randomUUID() }, actor);
  await assert.rejects(restored.$executeRaw`UPDATE inventory_movements SET quantity_delta=99`);
  await restored.$disconnect();
  let output = "";
  backend = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "0"], { windowsHide: true, env: { ...process.env, DATABASE_URL: restoredUrl.toString(), MERCHANDISE_UPLOAD_DIR: restoredMedia, BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: "test-".repeat(10), STOREFRONT_BASE_URL: "http://localhost:5173", COMMERCE_GATEWAY_SECRET: "restore-test-".repeat(5), CUSTOMER_EMAIL_PROVIDER: "disabled", COMMERCE_TEST_CHECKOUT_ENABLED: "false", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" }, stdio: ["ignore", "pipe", "pipe"] });
  backend.stdout?.on("data", (b) => { output += b.toString(); }); backend.stderr?.on("data", (b) => { output += b.toString(); });
  for (let i = 0; i < 300 && !/Ready in/.test(output); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(output, /Ready in/);
  const port = /127\.0\.0\.1:(\d+)/.exec(output)?.[1] ?? /localhost:(\d+)/.exec(output)?.[1];
  assert.ok(port);
  const { startStorefront } = await import(pathToFileURL(resolve("../kokoniv2/server.mjs")).href);
  site = await startStorefront({ production: true, allowLoopbackTest: true, port: 0, siteOrigin: "http://localhost:5173", backendOrigin: `http://127.0.0.1:${port}`, gatewaySecret: "restore-test-".repeat(5) });
  const base = `http://127.0.0.1:${site!.server.address().port}`;
  for (const path of ["/readyz", "/products/restore-item", `/api/storefront/v1/images/${image.id}`, "/account/orders", `/gacha/rewards?reward=${receipt.prizes[0].rewardId}`]) {
    const response = await fetch(base + path, { headers: { cookie: `kokoni_customer=${user.token}` }, redirect: "manual" });
    assert.equal(response.status, 200, path); await response.arrayBuffer();
  }
  await writeFile(resolve(root, "restore-results.json"), JSON.stringify({ databaseRestored: true, mediaRestored: true, runtimeRoleNonOwner: true, createTableDenied: true, ledgerMutationTested: true, ledgerRewriteDenied: true, orders: 1, rewards: 1, backendAndFrontendStarted: true, httpMerchandiseImagesOrdersRewards: true, scope: "Disposable local Docker database, fixture media, HTTP loopback; not offsite/PITR or production restore evidence." }, null, 2));
  console.log("Restore drill passed: database, media, non-owner role, ledger and both applications.");
} finally {
  await site?.close(); backend?.kill();
  if (backend && backend.exitCode === null) await new Promise<void>((done) => { backend!.once("exit", () => done()); setTimeout(done, 5000); });
  await db.$disconnect(); await restored?.$disconnect();
  if (!/^restore_[a-f0-9]{32}_test$/.test(target) || !/^test_restore_[a-f0-9]{32}$/.test(schema) || !/^test_runtime_[a-f0-9]{32}$/.test(role)) throw new Error("Unsafe cleanup target");
  if (targetCreated) await pool.query(`DROP DATABASE "${target}" WITH (FORCE)`);
  if (roleCreated) await pool.query(`DROP ROLE "${role}"`);
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end();
  for (const dir of [sourceMedia, restoredMedia]) {
    if (!dir.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) throw new Error("Unsafe media cleanup");
    await rm(dir, { recursive: true, force: true });
  }
}
