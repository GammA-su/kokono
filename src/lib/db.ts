import "server-only";
import { createDatabaseClient } from "@/db/client";

const globalForDb = globalThis as unknown as {
  kokonoDb?: ReturnType<typeof createDatabaseClient>;
};

export const db = globalForDb.kokonoDb ?? createDatabaseClient(process.env.DATABASE_URL ?? "");
if (process.env.NODE_ENV !== "production") globalForDb.kokonoDb = db;
