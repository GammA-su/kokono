/**
 * Operator status snapshot. Safe internal diagnostics only: it reports whether things work,
 * never the values that make them work. No secret, connection string, customer record or
 * stack trace is printed, so the output can be pasted into an incident note.
 *
 * This is a command, not an HTTP route, precisely so it is not publicly reachable: running it
 * already requires shell access to the host.
 *
 *   npm run ops:status
 */
import "dotenv/config";
import { readFile, access, writeFile, unlink, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "../src/db/client";

type Check = {
  check: string;
  ok: boolean | null;
  detail: string;
};
const checks: Check[] = [];
const add = (check: string, ok: boolean | null, detail: string) =>
  checks.push({ check, ok, detail });

// --- Application version -----------------------------------------------------------------
try {
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  add("version", true, `${pkg.name} ${pkg.version} on Node ${process.version}`);
} catch {
  add("version", false, "package.json unreadable");
}

// --- Media mount -------------------------------------------------------------------------
const mediaDir = process.env.MERCHANDISE_UPLOAD_DIR || resolve(".local/uploads");
try {
  await access(mediaDir, constants.R_OK | constants.W_OK);
  // Readable/writable is what actually matters after a restart or a remounted volume, so it
  // is proven with a real round trip rather than a permissions bit.
  const probe = join(mediaDir, `.ops-status-${randomUUID()}`);
  await writeFile(probe, "ok");
  await unlink(probe);
  const count = (await readdir(mediaDir)).length;
  add("media_mount", true, `readable and writable, ${count} entries`);
} catch {
  add("media_mount", false, "not readable/writable by this user");
}

const db = createDatabaseClient(process.env.DATABASE_URL ?? "");
try {
  // --- Database connectivity --------------------------------------------------------------
  let connected = false;
  try {
    const [row] = await db.$queryRaw<{ role: string; database: string }[]>`
      SELECT current_user AS role, current_database() AS database`;
    connected = true;
    add("database", true, `connected as ${row.role} to ${row.database}`);
    // A runtime role that owns the schema would be able to rewrite it; worth surfacing.
    const [owner] = await db.$queryRaw<{ owns: boolean }[]>`
      SELECT bool_or(tableowner = current_user) AS owns
      FROM pg_tables WHERE schemaname = current_schema()`;
    add(
      "runtime_role_is_non_owner",
      owner?.owns === false,
      owner?.owns === false
        ? "runtime role does not own application tables"
        : "runtime role owns application tables (expected only in development)",
    );
  } catch {
    add("database", false, "connection failed");
  }

  if (connected) {
    // --- Pending migrations -----------------------------------------------------------------
    try {
      const applied = await db.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      const known = new Set(applied.map((row) => row.migration_name));
      const onDisk = (
        await readdir(resolve("prisma/migrations"), { withFileTypes: true })
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      const pending = onDisk.filter((name) => !known.has(name));
      add(
        "migrations",
        pending.length === 0,
        pending.length
          ? `${pending.length} pending: ${pending.join(", ")}`
          : `${known.size} applied, none pending`,
      );
    } catch {
      // The production runtime role is deliberately denied _prisma_migrations, so this is a
      // known and acceptable gap rather than a failure: the release job checks it instead.
      add("migrations", null, "not visible to this role (expected for kokoni_runtime)");
    }

    // --- Last maintenance outcomes ----------------------------------------------------------
    // These are derived from durable domain records rather than a status table, so they cannot
    // report success for a job that did not actually change anything.
    try {
      const [reservation] = await db.$queryRaw<{ at: Date | null }[]>`
        SELECT MAX(updated_at) AS at FROM inventory_reservations WHERE status = 'RELEASED'`;
      add(
        "last_reservation_expiry",
        null,
        reservation?.at ? reservation.at.toISOString() : "no released reservation recorded",
      );
      const [session] = await db.$queryRaw<{ expired: bigint }[]>`
        SELECT COUNT(*)::bigint AS expired FROM customer_sessions WHERE expires_at <= now()`;
      add(
        "expired_sessions_awaiting_cleanup",
        Number(session?.expired ?? 0) === 0,
        `${Number(session?.expired ?? 0)} expired customer sessions still stored`,
      );
      const [order] = await db.$queryRaw<{ review: bigint }[]>`
        SELECT COUNT(*)::bigint AS review FROM orders WHERE payment_status = 'REVIEW'`;
      add(
        "orders_awaiting_reconciliation",
        Number(order?.review ?? 0) === 0,
        `${Number(order?.review ?? 0)} orders in REVIEW`,
      );
    } catch {
      add("maintenance_signals", null, "not readable by this role");
    }

    // --- Inventory reconciliation ------------------------------------------------------------
    try {
      const [drift] = await db.$queryRaw<{ mismatches: bigint }[]>`
        SELECT COUNT(*)::bigint AS mismatches FROM (
          SELECT b.merchandise_item_id, b.storage_location_id, b.quantity,
            COALESCE(SUM(m.quantity_delta) FILTER (WHERE m.destination_location_id = b.storage_location_id), 0)
            - COALESCE(SUM(m.quantity_delta) FILTER (WHERE m.source_location_id = b.storage_location_id), 0) AS ledger
          FROM inventory_balances b
          LEFT JOIN inventory_movements m ON m.merchandise_item_id = b.merchandise_item_id
          GROUP BY b.merchandise_item_id, b.storage_location_id, b.quantity
        ) t WHERE t.quantity <> t.ledger`;
      const count = Number(drift?.mismatches ?? 0);
      add(
        "inventory_ledger_agreement",
        count === 0,
        count === 0
          ? "balances agree with the ledger"
          : `${count} balance/ledger disagreements — run npm run inventory:reconcile`,
      );
    } catch {
      add("inventory_ledger_agreement", null, "not readable by this role");
    }
  }

  // --- Capability switches ------------------------------------------------------------------
  // Names and states only. These are not secrets and an operator needs them during an incident.
  for (const flag of [
    "COMMERCE_TEST_CHECKOUT_ENABLED",
    "GACHA_DRAWS_ENABLED",
    "GACHA_CUSTOMER_EXECUTION_ENABLED",
    "CUSTOMER_VERIFICATION_POLICY",
    "CUSTOMER_EMAIL_PROVIDER",
  ])
    add(`flag:${flag}`, null, process.env[flag] ?? "(unset)");
  // Presence, never the value.
  for (const secret of ["STRIPE_SECRET_KEY", "RESEND_API_KEY", "COMMERCE_GATEWAY_SECRET"])
    add(`configured:${secret}`, null, process.env[secret] ? "present" : "absent");

  const failed = checks.filter((row) => row.ok === false);
  const width = Math.max(...checks.map((row) => row.check.length));
  for (const row of checks)
    console.log(
      `${row.ok === null ? "  --" : row.ok ? "  OK" : "FAIL"}  ${row.check.padEnd(width)}  ${row.detail}`,
    );
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks reported, ${failed.length} failing.`,
  );
  if (failed.length) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
