import "server-only";
import { redirect } from "next/navigation";
import { requireInternalUser } from "./authorization";
import { DomainError } from "@/modules/shared/errors";
import { db } from "./db";
import { createLineupQueries } from "@/modules/lineups/queries";

export async function requireAdminPage() {
  try {
    return await requireInternalUser();
  } catch (error) {
    if (error instanceof DomainError && error.code === "UNAUTHENTICATED")
      redirect("/login");
    if (error instanceof DomainError && error.code === "FORBIDDEN")
      redirect("/login?error=access");
    throw error;
  }
}
export const lineupQueries = createLineupQueries(db, requireAdminPage);
