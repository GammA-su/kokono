"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { catalog } from "@/lib/services";
import { requireInternalUser } from "@/lib/authorization";
import { formError, type FormState } from "../lineups/action-state";
import { discardNewImage } from "../media/storage";
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
