"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createAssistedImportService, importFailure } from "./service";
function service() {
  return createAssistedImportService(
    db,
    requireInternalUser,
    process.env.BETTER_AUTH_SECRET ?? "",
  );
}
export async function assistedOptions() {
  try {
    return { options: await service().options() };
  } catch (error) {
    return { error: importFailure(error) };
  }
}
export async function extractMerchandise(input: unknown) {
  try {
    return { extraction: await service().extract(input) };
  } catch (error) {
    return { error: importFailure(error) };
  }
}
export async function reviewExtractedMerchandise(input: unknown) {
  try {
    return { review: await service().review(input) };
  } catch (error) {
    return { error: importFailure(error) };
  }
}
export async function importExtractedMerchandise(input: unknown) {
  try {
    const summary = await service().commit(input);
    revalidatePath("/admin", "layout");
    return { summary };
  } catch (error) {
    return { error: importFailure(error) };
  }
}
