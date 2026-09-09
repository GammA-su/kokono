import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createDatabaseClient } from "../src/db/client";
const db = createDatabaseClient(process.env.DATABASE_URL ?? "");
try {
  const settings = await db.$queryRaw`
    SELECT current_setting('server_version') AS version, current_setting('server_encoding') AS encoding,
      current_setting('ssl') AS "serverSsl", current_setting('statement_timeout') AS "statementTimeout",
      current_setting('idle_in_transaction_session_timeout') AS "idleTransactionTimeout",
      current_setting('max_connections') AS "maxConnections",
      r.rolsuper AS superuser, r.rolcreatedb AS "createDatabase", r.rolcreaterole AS "createRole", r.rolbypassrls AS "bypassRls",
      has_schema_privilege(current_user,current_schema(),'CREATE') AS "createInSchema",
      (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS "connectionTls"
    FROM pg_roles r WHERE rolname=current_user`;
  const files = (await readdir("prisma/migrations", { withFileTypes: true })).filter((f) => f.isDirectory()).map((f) => f.name).sort();
  let migrations: unknown = "Migration table not readable by this role; check separately with migration credentials.";
  try {
    const rows = await db.$queryRaw<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations`;
    migrations = await Promise.all(files.map(async (name) => {
      const hash = createHash("sha256").update(await readFile(`prisma/migrations/${name}/migration.sql`)).digest("hex");
      const row = rows.find((r) => r.migration_name === name && r.finished_at && !r.rolled_back_at);
      return { name, status: row ? "APPLIED" : "PENDING_OR_FAILED", checksumMatches: row ? hash === row.checksum : null };
    }));
  } catch { /* A runtime role should not receive migration-table access. */ }
  console.log(JSON.stringify({ settings, migrations }, null, 2));
} catch {
  console.error("Database audit could not complete; no connection details have been logged."); process.exitCode = 1;
} finally { await db.$disconnect(); }
