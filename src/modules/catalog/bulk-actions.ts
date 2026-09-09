"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { bulkEntry, catalog } from "@/lib/services";
import { formError, type FormState } from "../lineups/action-state";
import { saveImage } from "../media/storage";
import { DomainError } from "../shared/errors";
import { BulkEntryError } from "./bulk-entry";
import type { RowIssue } from "./bulk-validation";
import type { DuplicateWarning } from "./duplicates";

export type BulkFormState = FormState & {
  issues?: RowIssue[];
  warnings?: DuplicateWarning[];
  checked?: boolean;
  // Distinguishes repeated results with identical content so the UI can react to each run.
  at?: number;
};

function bulkError(error: unknown): BulkFormState {
  if (error instanceof BulkEntryError)
    return {
      error: error.message,
      issues: error.issues,
      warnings: error.warnings,
      at: Date.now(),
    };
  return { ...formError(error), at: Date.now() };
}
function failureMessage(error: unknown) {
  if (error instanceof DomainError) return error.message;
  console.error(
    "Bulk entry operation failed",
    error instanceof Error ? error.name : "Unknown error",
  );
  return "The operation could not be completed. Please try again.";
}

/** Validates rows and reports duplicates without writing anything. */
export async function reviewBulkItems(input: unknown): Promise<BulkFormState> {
  try {
    const { issues, warnings } = await bulkEntry.review(input);
    return { issues, warnings, checked: true, at: Date.now() };
  } catch (error) {
    return bulkError(error);
  }
}

/** Validates every row, then creates the whole batch in one transaction. */
export async function saveBulkItems(
  _state: BulkFormState,
  input: unknown,
): Promise<BulkFormState> {
  let saved: Awaited<ReturnType<typeof bulkEntry.save>>;
  try {
    saved = await bulkEntry.save(input);
  } catch (error) {
    return bulkError(error);
  }
  revalidatePath("/admin/merchandise", "layout");
  redirect(
    `/admin/merchandise/lineups/${saved.lineupId}?notice=bulk&created=${saved.created.length}`,
  );
}

/** Creates a missing character inside the lineup's franchise without leaving the editor. */
export async function createBulkCharacter(input: unknown) {
  try {
    await requireInternalUser();
    const data = z
      .object({
        lineupId: z.uuid(),
        name: z.string().trim().min(1).max(500),
        japaneseName: z.string().trim().max(500).optional(),
      })
      .strict()
      .parse(input);
    const lineup = await db.lineup.findFirst({
      where: {
        id: data.lineupId,
        archivedAt: null,
        franchise: { archivedAt: null },
      },
      select: { franchiseId: true },
    });
    if (!lineup)
      throw new DomainError(
        "LINEUP_UNAVAILABLE",
        "Restore the lineup and franchise before adding characters.",
      );
    const character = await catalog.createCharacter({
      franchiseId: lineup.franchiseId,
      name: data.name,
      japaneseName: data.japaneseName || null,
    });
    revalidatePath("/admin/merchandise", "layout");
    return { character: { id: character.id, name: character.name } };
  } catch (error) {
    return { error: failureMessage(error) };
  }
}

/** Stores one uploaded row image and returns its private reference. */
export async function uploadBulkItemImage(form: FormData) {
  try {
    await requireInternalUser();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0)
      throw new DomainError(
        "INVALID_IMAGE",
        "Choose a PNG, JPEG, or WebP image.",
      );
    return { storageKey: await saveImage(file) };
  } catch (error) {
    return { error: failureMessage(error) };
  }
}
