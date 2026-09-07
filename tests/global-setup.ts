import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { Pool } from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext { testDatabaseUrl: string }
}

export default async function setup(project: TestProject) {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("TEST_DATABASE_URL is required; tests never fall back to the development database.");
  if (process.env.NODE_ENV === "production") throw new Error("Database tests are refused in production.");
  const url = new URL(raw);
  if (!url.pathname.endsWith("_test")) throw new Error("The test database name must end in _test.");
  const development = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  if (development && url.hostname === development.hostname && (url.port || "5432") === (development.port || "5432") && url.pathname === development.pathname) {
    throw new Error("The test database must be separate from DATABASE_URL.");
  }
  // Every run owns a new, explicitly named schema. It never truncates existing tables.
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  url.searchParams.delete("schema");
  const pool = new Pool({ connectionString: url.toString() });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const cleanup = async () => {
    if (!/^test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unsafe test schema cleanup target.");
    try { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await pool.end(); }
  };
  try {
    url.searchParams.set("schema", schema);
    const connectionString = url.toString();
    await promisify(execFile)(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: connectionString }, timeout: 60_000,
    });
    project.provide("testDatabaseUrl", connectionString);
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
