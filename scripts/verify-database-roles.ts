/**
 * Proves the proposed production role model on a disposable local database before any VPS
 * deployment. It creates kokoni_migrator / kokoni_runtime / kokoni_backup, applies the grants
 * documented in docs/deployment.md, then asserts what each role can and cannot do.
 *
 * This never touches the development or test application databases: it creates and drops its
 * own database. Local passwords are throwaway and are never printed.
 *
 *   npx tsx --env-file=.env scripts/verify-database-roles.ts
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("TEST_DATABASE_URL is required.");
const admin = new URL(process.env.TEST_DATABASE_URL);
if (!admin.pathname.endsWith("_test"))
  throw new Error("Refusing a database not ending in _test.");
const database = `kokoni_roles_${randomBytes(6).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const roles = ["kokoni_migrator", "kokoni_runtime", "kokoni_backup"] as const;
const roleUrl = (role: string) => {
  const url = new URL(admin.toString());
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

type Result = {
  role: string;
  action: string;
  expected: "allowed" | "denied";
  actual: string;
  ok: boolean;
};
const results: Result[] = [];
async function expect(
  role: string,
  client: Client,
  action: string,
  sql: string,
  want: "allowed" | "denied",
) {
  let actual = "allowed";
  try {
    await client.query(sql);
  } catch {
    actual = "denied";
  }
  results.push({ role, action, expected: want, actual, ok: actual === want });
  console.log(
    `${actual === want ? "PASS" : "FAIL"}  ${role.padEnd(16)} ${want.padEnd(7)} ${action}`,
  );
}

const root = new Client({ connectionString: admin.toString() });
await root.connect();
try {
  await root.query(`CREATE DATABASE "${database}"`);
  for (const role of roles) {
    await root.query(`DROP ROLE IF EXISTS ${role}`);
    // No superuser, no CREATEDB, no CREATEROLE, no REPLICATION, no BYPASSRLS.
    await root.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
  }
  await root.query(`ALTER DATABASE "${database}" OWNER TO kokoni_migrator`);

  // Migrations run as the migrator, exactly as a release job would.
  await promisify(execFile)(
    process.execPath,
    [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: roleUrl("kokoni_migrator") },
      timeout: 180000,
    },
  );
  console.log("Migrations applied as kokoni_migrator.");

  const owner = new Client({ connectionString: roleUrl("kokoni_migrator") });
  await owner.connect();
  await owner.query(`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO kokoni_runtime, kokoni_backup;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kokoni_runtime;
    REVOKE ALL ON public._prisma_migrations FROM kokoni_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kokoni_runtime;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO kokoni_runtime;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO kokoni_backup;`);

  // One item and one ledger row the runtime role can legitimately work against.
  const seed = [
    `INSERT INTO franchises(id,name,slug,updated_at) VALUES ('11111111-1111-1111-1111-111111111111','Roles','roles',now())`,
    `INSERT INTO lineups(id,franchise_id,name,slug,updated_at) VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','L','l',now())`,
    `INSERT INTO categories(id,name,slug,public_category_id) SELECT '33333333-3333-3333-3333-333333333333','C','c',id FROM public_categories LIMIT 1`,
    `INSERT INTO merchandise_items(id,lineup_id,category_id,name,internal_sku,slug,updated_at) VALUES ('44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','Item','sku','slug',now())`,
    `INSERT INTO storage_locations(id,code,name,type,country_code,fulfillment_enabled,active,updated_at) VALUES ('55555555-5555-5555-5555-555555555555','fr','fr','FRANCE_HOME','FR',true,true,now())`,
    `INSERT INTO users(id,email,name,is_internal,updated_at) VALUES ('66666666-6666-6666-6666-666666666666','r@example.test','R',true,now())`,
    `INSERT INTO inventory_movements(id,merchandise_item_id,movement_type,quantity_delta,destination_location_id,operation_key,request_fingerprint,actor_user_id,created_at) VALUES ('77777777-7777-7777-7777-777777777777','44444444-4444-4444-4444-444444444444','PURCHASE',1,'55555555-5555-5555-5555-555555555555','k',repeat('a',64),'66666666-6666-6666-6666-666666666666',now())`,
  ];
  for (const statement of seed) await owner.query(statement);
  await owner.end();

  const runtime = new Client({ connectionString: roleUrl("kokoni_runtime") });
  await runtime.connect();
  // Ordinary application work must succeed.
  await expect("kokoni_runtime", runtime, "SELECT application data", `SELECT id FROM merchandise_items LIMIT 1`, "allowed");
  await expect("kokoni_runtime", runtime, "INSERT ledger movement", `INSERT INTO inventory_movements(id,merchandise_item_id,movement_type,quantity_delta,destination_location_id,operation_key,request_fingerprint,actor_user_id,created_at) VALUES (gen_random_uuid(),'44444444-4444-4444-4444-444444444444','PURCHASE',1,'55555555-5555-5555-5555-555555555555','k2',repeat('a',64),'66666666-6666-6666-6666-666666666666',now())`, "allowed");
  await expect("kokoni_runtime", runtime, "UPDATE catalog row", `UPDATE merchandise_items SET name='Renamed' WHERE id='44444444-4444-4444-4444-444444444444'`, "allowed");
  await expect("kokoni_runtime", runtime, "DELETE working row", `DELETE FROM purchase_watches WHERE false`, "allowed");
  // Schema authority must be refused.
  await expect("kokoni_runtime", runtime, "CREATE TABLE", `CREATE TABLE runtime_should_not_exist(id int)`, "denied");
  await expect("kokoni_runtime", runtime, "DROP TABLE", `DROP TABLE inventory_movements`, "denied");
  await expect("kokoni_runtime", runtime, "ALTER TABLE", `ALTER TABLE merchandise_items ADD COLUMN injected text`, "denied");
  await expect("kokoni_runtime", runtime, "TRUNCATE ledger", `TRUNCATE inventory_movements`, "denied");
  await expect("kokoni_runtime", runtime, "CREATE INDEX", `CREATE INDEX runtime_idx ON merchandise_items(name)`, "denied");
  // Migration internals must be unreachable.
  await expect("kokoni_runtime", runtime, "read _prisma_migrations", `SELECT * FROM _prisma_migrations LIMIT 1`, "denied");
  await expect("kokoni_runtime", runtime, "write _prisma_migrations", `DELETE FROM _prisma_migrations`, "denied");
  // Ledger immutability must be neither removable nor rewritable.
  await expect("kokoni_runtime", runtime, "disable ledger triggers", `ALTER TABLE inventory_movements DISABLE TRIGGER ALL`, "denied");
  await expect("kokoni_runtime", runtime, "drop protection function", `DROP FUNCTION reject_inventory_history_mutation() CASCADE`, "denied");
  await expect("kokoni_runtime", runtime, "rewrite ledger history", `UPDATE inventory_movements SET quantity_delta = 999 WHERE id='77777777-7777-7777-7777-777777777777'`, "denied");
  await expect("kokoni_runtime", runtime, "delete ledger history", `DELETE FROM inventory_movements WHERE id='77777777-7777-7777-7777-777777777777'`, "denied");
  // Role, database and extension authority must be refused.
  await expect("kokoni_runtime", runtime, "CREATE ROLE", `CREATE ROLE escalated LOGIN`, "denied");
  await expect("kokoni_runtime", runtime, "self-grant SUPERUSER", `ALTER ROLE kokoni_runtime SUPERUSER`, "denied");
  await expect("kokoni_runtime", runtime, "CREATE EXTENSION", `CREATE EXTENSION pg_trgm`, "denied");
  await runtime.end();

  const backup = new Client({ connectionString: roleUrl("kokoni_backup") });
  await backup.connect();
  await expect("kokoni_backup", backup, "SELECT for backup", `SELECT id FROM merchandise_items LIMIT 1`, "allowed");
  await expect("kokoni_backup", backup, "SELECT customer records", `SELECT id FROM customers LIMIT 1`, "allowed");
  await expect("kokoni_backup", backup, "INSERT anything", `INSERT INTO franchises(id,name,slug,updated_at) VALUES (gen_random_uuid(),'x','y',now())`, "denied");
  await expect("kokoni_backup", backup, "UPDATE anything", `UPDATE merchandise_items SET name='no'`, "denied");
  await expect("kokoni_backup", backup, "DELETE anything", `DELETE FROM merchandise_items`, "denied");
  await backup.end();

  const failed = results.filter((row) => !row.ok);
  await mkdir(resolve(".local/audit"), { recursive: true });
  await writeFile(
    resolve(".local/audit/database-roles.json"),
    JSON.stringify(
      { at: new Date().toISOString(), checks: results.length, failed: failed.length, results },
      null,
      2,
    ),
  );
  console.log(`\n${results.length - failed.length}/${results.length} role expectations held.`);
  if (failed.length) {
    console.log(`FAILURES: ${failed.map((row) => `${row.role}/${row.action}`).join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  await root.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
  for (const role of ["kokoni_runtime", "kokoni_backup", "kokoni_migrator"])
    await root.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  await root.end();
}
