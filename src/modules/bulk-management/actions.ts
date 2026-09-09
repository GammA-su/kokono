"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createBulkManagementService } from "./service";
import { formError } from "../lineups/action-state";

function service() {
  return createBulkManagementService(
    db,
    requireInternalUser,
    process.env.BETTER_AUTH_SECRET ?? "",
  );
}
export async function prepareMerchandiseBatch(input: unknown) {
  try {
    return { review: await service().prepare(input) };
  } catch (error) {
    return { error: formError(error).error };
  }
}
export async function executeMerchandiseBatch(input: unknown) {
  try {
    const result = await service().execute(input);
    revalidatePath("/admin", "layout");
    return { result };
  } catch (error) {
    return { error: formError(error).error };
  }
}
