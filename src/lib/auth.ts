import "server-only";
import { db } from "@/lib/db";
import { createAuth } from "@/lib/auth-config";

export const auth = createAuth(db, {
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET ?? "",
});
