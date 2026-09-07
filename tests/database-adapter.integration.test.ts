import { afterAll, expect, inject, it } from "vitest";
import { createDatabaseClient } from "../src/db/client";
import { guardPgQueryConcurrency } from "./pg-query-guard";

guardPgQueryConcurrency();
const db = createDatabaseClient(inject("testDatabaseUrl"));
afterAll(() => db.$disconnect());

it("serializes concurrent statements on a transaction connection", async () => {
  const rows = await db.$transaction(async (tx) => Promise.all(
    [1, 2, 3].map((value) => tx.$queryRaw<{ value: number }[]>`
      SELECT ${value}::int AS value FROM pg_sleep(0.01)
    `),
  ));
  expect(rows.flat().map((row) => row.value)).toEqual([1, 2, 3]);
});

it("rolls back after a failed statement and leaves the pool usable", async () => {
  await expect(db.$transaction(async (tx) => {
    await Promise.all([
      tx.$queryRaw`SELECT 1 / 0`,
      tx.$queryRaw`SELECT 2`,
    ]);
  })).rejects.toThrow();
  expect(await db.$queryRaw`SELECT 3::int AS value`).toEqual([{ value: 3 }]);
});

it("keeps independent transactions on independent pool connections", async () => {
  const rows = await Promise.all([1, 2].map(() => db.$transaction(async (tx) =>
    tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM pg_sleep(0.05)`,
  )));
  expect(new Set(rows.flat().map((row) => row.pid)).size).toBe(2);
});
