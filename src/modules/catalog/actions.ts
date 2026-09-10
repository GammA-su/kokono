"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { catalog } from "@/lib/services";
import { requireInternalUser } from "@/lib/authorization";
import { formError, type FormState } from "../lineups/action-state";
import { discardNewImage, saveImage } from "../media/storage";
import { db } from "@/lib/db";
import { DomainError } from "../shared/errors";
import { z } from "zod";
import { itemFromForm } from "./item-form";

const base = "/admin/merchandise/catalog";
function invalidate() {
  revalidatePath("/admin/merchandise", "layout");
}

/** Edits one catalog item. Sources, images, stock and publication have their own screens. */
export async function saveItemForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    await requireInternalUser();
    const itemId = String(form.get("id") ?? "");
    if (!itemId) throw new Error("Missing item identity.");
    const saved = await catalog.saveItem(
      itemFromForm(form, String(form.get("lineupId") ?? "")),
      { id: itemId, updatedAt: String(form.get("updatedAt") ?? "") },
    );
    id = saved.id;
  } catch (error) {
    return formError(error);
  }
  invalidate();
  redirect(`${base}/${id}?notice=saved`);
}

/**
 * Deletes an item, or archives it when anything depends on it. The service decides which;
 * the outcome is reported back so the operator is never told "deleted" about an archive.
 */
export async function deleteItemForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let destination: string;
  try {
    await requireInternalUser();
    const result = await catalog.removeItem(
      form.get("id"),
      form.get("confirmedName"),
    );
    if (typeof result === "string") {
      // Archived: the item still exists, so keep the operator on it.
      destination = `${base}/${String(form.get("id"))}?notice=${result}`;
    } else {
      // Deleted: its managed image files are now unreferenced. Removing them is best-effort
      // and happens only after the transaction committed, so a failed unlink cannot leave the
      // catalog pointing at a file that is already gone.
      for (const key of result.storageKeys)
        await discardNewImage(key).catch(() => undefined);
      destination = `${base}?notice=deleted`;
    }
  } catch (error) {
    return formError(error);
  }
  invalidate();
  redirect(destination);
}

export async function restoreItemForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    await requireInternalUser();
    id = (await catalog.restoreItem(form.get("id"))).id;
  } catch (error) {
    return formError(error);
  }
  invalidate();
  redirect(`${base}/${id}?notice=restored`);
}

/**
 * Adds one image to an item. The file goes through the same strict decoder as every other
 * ingestion path, and is discarded again if the database write fails, so a rejected upload
 * cannot leave an orphan file on the media volume.
 */
export async function addItemImageForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let stored: string | null = null;
  let itemId: string;
  try {
    await requireInternalUser();
    itemId = z.uuid().parse(form.get("itemId"));
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0)
      throw new DomainError("INVALID_IMAGE", "Choose a PNG, JPEG or WebP image.");
    stored = await saveImage(file);
    await catalog.addImage({
      merchandiseItemId: itemId,
      storageKey: stored,
      imageRole: form.get("imageRole") || "PRODUCT",
      caption: form.get("caption"),
      approvedForPublicUse: form.get("approvedForPublicUse") === "on",
    });
  } catch (error) {
    if (stored) await discardNewImage(stored).catch(() => undefined);
    return formError(error);
  }
  invalidate();
  redirect(`${base}/${itemId}/edit?notice=image-added`);
}

export async function setItemImageApprovalForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let itemId: string;
  try {
    await requireInternalUser();
    itemId = z.uuid().parse(form.get("itemId"));
    await catalog.setImageApproval({
      imageId: form.get("imageId"),
      approved: form.get("approved") === "true",
    });
  } catch (error) {
    return formError(error);
  }
  invalidate();
  redirect(`${base}/${itemId}/edit?notice=image-approval`);
}

export async function deleteItemImageForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let itemId: string;
  try {
    await requireInternalUser();
    itemId = z.uuid().parse(form.get("itemId"));
    const { storageKey } = await catalog.removeImage(form.get("imageId"));
    // Only after the row is gone: a failed unlink must never leave the catalog pointing at a
    // file that is already deleted.
    await discardNewImage(storageKey).catch(() => undefined);
  } catch (error) {
    return formError(error);
  }
  invalidate();
  redirect(`${base}/${itemId}/edit?notice=image-removed`);
}

/**
 * Creates a character in the item's franchise from the picker.
 *
 * Returns the new record instead of redirecting: the picker is mid-edit and the operator's
 * unsaved changes to the rest of the form must survive adding a character.
 */
export async function createCharacterForItem(input: {
  lineupId: string;
  name: string;
  japaneseName?: string;
}) {
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
    return { character: { id: character.id, name: character.name } };
  } catch (error) {
    return {
      error:
        error instanceof DomainError
          ? error.message
          : "Could not create the character.",
    };
  }
}
