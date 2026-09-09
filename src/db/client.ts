import { SequentialPrismaPg } from "./sequential-pg";
import { PrismaClient } from "../generated/prisma/client";

export function createDatabaseClient(connectionString: string) {
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const url = new URL(connectionString);
  const schema = url.searchParams.get("schema") ?? "public";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Use a lowercase SQL identifier for the database schema.");
  url.searchParams.delete("schema");
  return new PrismaClient({
    adapter: new SequentialPrismaPg({ connectionString: url.toString(), max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, options: `-c search_path=${schema}` }, { schema }),
  });
}
