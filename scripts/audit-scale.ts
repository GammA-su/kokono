/** Disposable scale audit. Never use development data or infer production capacity from these timings. */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { SequentialPrismaPg } from "../src/db/sequential-pg";
import { createCatalogQueries } from "../src/modules/catalog/queries";
import { createDashboardQueries } from "../src/modules/dashboard/queries";
import { getPublishedListings, getPublicListing, getPublicFacets } from "../src/modules/publication/queries";
import { latestAcquisitionSql } from "../src/modules/inventory/aggregates";
import { saveImage, discardNewImage } from "../src/modules/media/storage";
import { prepareOperationalLoad } from "./audit-load-fixture";

if (process.env.NODE_ENV === "production" || !process.env.TEST_DATABASE_URL) throw new Error("A separate TEST_DATABASE_URL is required.");
const url = new URL(process.env.TEST_DATABASE_URL);
if (!url.pathname.endsWith("_test")) throw new Error("Refusing a database not ending in _test.");
const dev = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
if (dev && dev.host === url.host && dev.pathname === url.pathname) throw new Error("Test and development databases must differ.");
url.searchParams.delete("schema");
const pool = new Pool({ connectionString: url.toString() });
const schema = `test_scale_${randomUUID().replaceAll("-", "")}`;
url.searchParams.set("schema", schema);
const connection = new URL(url);
connection.searchParams.delete("schema");
const runtimePool = new Pool({ connectionString: connection.toString(), max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, options: `-c search_path=${schema}` });
const db = new PrismaClient({ adapter: new SequentialPrismaPg(runtimePool, { schema, disposeExternalPool: true }), log: [{ emit: "event", level: "query" }] });
let phase = "";
const queries: { phase: string; duration: number; query: string; params: string }[] = [];
db.$on("query", (event) => {
  if (phase && /^(SELECT|WITH)\b/i.test(event.query.trim())) queries.push({ phase, duration: event.duration, query: event.query, params: event.params });
});
let media: string | undefined;
const result: Record<string, unknown> = { items: 50000, lineups: 5000, movements: 500000, balances: 150000, reservations: 0,
  caveat: "Synthetic local PostgreSQL. Base timings use one caller; --with-history adds real reservation/reward history and concurrent domain callers. No external provider calls. Timings are diagnostic, not HTTP/TLS capacity or an SLA benchmark." };
async function timed(name: string, work: () => Promise<unknown>) {
  phase = name;
  const start = performance.now();
  try { await work(); } catch (error) {
    result[`${name}_error`] = error instanceof Error ? error.message : "Failed";
    console.log(`${name}: FAILED (see result artifact)`);
    return;
  }
  const ms = Math.round(performance.now() - start);
  result[name] = ms;
  console.log(`${name}: ${ms} ms`);
  phase = "";
}
async function explain(name: string, sql: Prisma.Sql) {
  result[name] = await db.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
}
try {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await promisify(execFile)(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 60000,
  });
  const actor = randomUUID(), franchise = randomUUID(), category = randomUUID();
  await db.user.create({ data: { id: actor, email: `${actor}@example.test`, name: "Scale audit", isInternal: true } });
  await db.franchise.create({ data: { id: franchise, name: "Audit franchise", slug: "audit" } });
  const publicCategory = await db.publicCategory.findUniqueOrThrow({ where: { slug: "goods" } });
  await db.category.create({ data: { id: category, name: "Audit category", slug: "audit", publicCategoryId: publicCategory.id } });
  const locs = [];
  for (const [code, type, countryCode, fulfillmentEnabled] of [
    ["audit-jp", "JAPAN_WAREHOUSE", "JP", false], ["audit-fr", "FRANCE_HOME", "FR", true], ["audit-transit", "IN_TRANSIT", null, false],
  ] as const) locs.push(await db.storageLocation.create({ data: { code, name: code, type, countryCode, fulfillmentEnabled } }));
  console.log("Seeding isolated scale data...");
  // Synthetic ledger and matching balances are fixtures only, not a new inventory import pathway.
  await db.$executeRaw`INSERT INTO lineups(id,franchise_id,name,slug,release_date,release_date_precision,updated_at)
    SELECT gen_random_uuid(),${franchise}::uuid,'Audit release '||n,'audit-'||n,DATE '2026-11-01','MONTH',now() FROM generate_series(1,5000) n`;
  await db.$executeRaw`INSERT INTO merchandise_items(id,lineup_id,category_id,name,japanese_name,internal_sku,slug,updated_at)
    SELECT gen_random_uuid(),l.id,${category}::uuid,'Audit item '||n,'レム Ｍａｒｉｎｅ '||n,'audit-'||n,'audit-'||n,now()
    FROM generate_series(1,50000) n JOIN lineups l ON l.slug='audit-'||((n-1)%5000+1)`;
  for (const [index, quantity] of [[0,6],[1,3],[2,1]]) {
    await db.$executeRaw`INSERT INTO inventory_balances(merchandise_item_id,storage_location_id,quantity,updated_at)
      SELECT id,${locs[index].id}::uuid,${quantity},now() FROM merchandise_items`;
    await db.$executeRaw`INSERT INTO inventory_movements(id,merchandise_item_id,movement_type,quantity_delta,destination_location_id,operation_key,request_fingerprint,actor_user_id,acquisition_unit_cost_amount,acquisition_unit_cost_currency,created_at)
      SELECT gen_random_uuid(),i.id,'PURCHASE',1,${locs[index].id}::uuid,i.id::text||':'||${index}::text||':'||n,repeat('a',64),${actor},100,'JPY',now() - n * interval '1 day'
      FROM merchandise_items i CROSS JOIN generate_series(1,${quantity}::int) n`;
  }
  media = await saveImage(new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNwWPX/PwgzwBgAY44LoVZSKggAAAAASUVORK5CYII=", "base64")], "audit.png"));
  await db.$executeRaw`INSERT INTO item_images(id,merchandise_item_id,storage_key,approved_for_public_use)
    SELECT gen_random_uuid(),id,${media},true FROM merchandise_items`;
  await db.$executeRaw`INSERT INTO sale_listings(id,merchandise_item_id,slug,selling_price_amount,selling_price_currency,selling_price_tax_inclusion,published,published_at,updated_at)
    SELECT gen_random_uuid(),id,slug,1500,'EUR','INCLUDED',true,now(),now() FROM merchandise_items`;
  await db.$executeRaw`INSERT INTO sale_listing_images(listing_id,item_image_id,display_order)
    SELECT s.id,im.id,0 FROM sale_listings s JOIN item_images im ON im.merchandise_item_id=s.merchandise_item_id`;
  await db.$executeRaw`INSERT INTO purchase_watches(id,merchandise_item_id,target_quantity,updated_at)
    SELECT gen_random_uuid(),id,15,now() FROM merchandise_items WHERE substring(internal_sku from 7)::int % 5 = 0`;
  await db.$executeRawUnsafe("ANALYZE"); // Constant diagnostic command, no input interpolation.
  const load = process.argv.includes("--with-history") ? await prepareOperationalLoad(db, actor, locs[1].id) : null;
  if (load) result.reservations = await db.inventoryReservation.count();
  const authorize = async () => ({ id: actor });
  const catalog = createCatalogQueries(db, authorize);
  await timed("catalog_page_ms", () => catalog.list({}));
  await timed("catalog_search_ms", () => catalog.list({ q: "Marine 49999" }));
  await timed("catalog_deep_page_ms", () => catalog.list({ page: 2000 }));
  await timed("public_page_ms", () => getPublishedListings(db, {}));
  await timed("public_page_warm_ms", () => getPublishedListings(db, {}));
  await timed("public_facets_ms", () => getPublicFacets(db));
  await timed("public_detail_ms", () => getPublicListing(db, "audit-49999"));
  const dashboard = createDashboardQueries(db, authorize);
  await timed("dashboard_operational_ms", () => dashboard.overview());
  await timed("dashboard_valuation_ms", () => dashboard.valuation());
  phase = "";
  if (load) {
    const usage = { maxConnections: 0, maxActive: 0, maxWaiting: 0, samples: 0 };
    const sample = setInterval(() => {
      usage.samples++;
      usage.maxConnections = Math.max(usage.maxConnections, runtimePool.totalCount);
      usage.maxActive = Math.max(usage.maxActive, runtimePool.totalCount - runtimePool.idleCount);
      usage.maxWaiting = Math.max(usage.maxWaiting, runtimePool.waitingCount);
    }, 50);
    try { result.concurrentLoad = { ...await load(), poolUsage: usage }; } finally { clearInterval(sample); }
  }
  result.queryTimings = queries.map(({ phase, duration, query }) => ({ phase, duration, query }));
  const diagnostic = await pool.connect();
  try {
    await diagnostic.query(`SET search_path TO "${schema}"`);
    await diagnostic.query("SET statement_timeout TO '30s'");
    const plans = [];
    for (const query of queries.toSorted((a, b) => b.duration - a.duration).slice(0, 12)) {
      try { plans.push({ ...query, plan: (await diagnostic.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.query}`, JSON.parse(query.params))).rows }); }
      catch { plans.push({ ...query, error: "EXPLAIN failed or exceeded 30 seconds" }); }
    }
    result.slowPlans = plans;
  } finally { diagnostic.release(); }
  await explain("recent_activity", Prisma.sql`SELECT id,created_at FROM inventory_movements ORDER BY created_at DESC,id DESC LIMIT 10`);
  await explain("latest_acquisition", latestAcquisitionSql());
  await explain("normalized_search", Prisma.sql`SELECT id FROM merchandise_items WHERE normalize(japanese_name,NFKC) ILIKE '%Marine 49999%'`);
  await mkdir(resolve(".local/audit"), { recursive: true });
  await writeFile(resolve(".local/audit/scale-results.json"), JSON.stringify(result, null, 2));
  console.log("Saved .local/audit/scale-results.json");
} finally {
  await db.$disconnect();
  if (media) await discardNewImage(media);
  if (!/^test_scale_[a-f0-9]{32}$/.test(schema)) throw new Error("Unsafe cleanup target");
  // --keep leaves the disposable schema in place for plan inspection. Diagnostic only.
  if (process.argv.includes("--keep")) { console.log(`Kept schema ${schema}`); await pool.end(); }
  else try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
}
