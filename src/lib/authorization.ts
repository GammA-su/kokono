import "server-only";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertInternalAccount } from "@/modules/auth/authorization";

export async function requireInternalUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  return assertInternalAccount(db, session?.user.id);
}
