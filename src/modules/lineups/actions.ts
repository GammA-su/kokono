"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createLineupService } from "./service";
import {
  lineupFromForm,
  lineupInputSchema,
  sourcesFromForm,
  sourcesSchema,
} from "./validation";
import { formError, type FormState } from "./action-state";
import { discardNewImage, saveImage } from "../media/storage";
import { catalog } from "@/lib/services";
import { itemFromForm } from "../catalog/item-form";
import { DomainError } from "../shared/errors";

const service = createLineupService(db, requireInternalUser);
const base = "/admin/merchandise/lineups";
function invalidate() {
  revalidatePath("/admin/merchandise", "layout");
}

export async function saveLineupForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let uploaded: string | null = null;
  let id: string;
  try {
    await requireInternalUser();
    const input = lineupFromForm(form);
    lineupInputSchema.parse(input); // Validate metadata before writing an upload.
    const image = form.get("imageFile");
    if (
      image instanceof File &&
      image.size > 0 &&
      form.get("removeImage") !== "on"
    ) {
      uploaded = await saveImage(image);
      input.mainImageStorageKey = uploaded;
    }
    const identity = form.get("id")
      ? { id: String(form.get("id")), updatedAt: String(form.get("updatedAt")) }
      : undefined;
    id = (await service.save(input, identity)).id;
  } catch (error) {
    if (uploaded) await discardNewImage(uploaded).catch(() => undefined);
    return formError(error);
  }
  invalidate();
  redirect(`${base}/${id}?notice=saved`);
}
export async function duplicateLineupForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    id = (await service.duplicate(form.get("id"))).id;
  } catch (error) {
    return formError(error);
  }
  invalidate();
  redirect(`${base}/${id}/edit?notice=duplicated`);
}
export async function deleteLineupForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let outcome: "archived" | "deleted";
  try {
    outcome = await service.remove(form.get("id"), form.get("confirmedName"));
  } catch (error) {
    return formError(error);
  }
  invalidate();
  redirect(`${base}?notice=${outcome}`);
}
export async function restoreLineupForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    id = (await service.restore(form.get("id"))).id;
  } catch (error) {
    return formError(error);
  }
  invalidate();
  redirect(`${base}/${id}`);
}
export async function saveItemSourcesForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let lineupId: string;
  try {
    await requireInternalUser();
    const item = await service.saveItemSources({
      lineupId: form.get("lineupId"),
      itemId: form.get("itemId"),
      updatedAt: form.get("updatedAt"),
      sources: sourcesFromForm(form),
    });
    lineupId = item.lineupId;
  } catch (error) {
    return formError(error);
  }
  invalidate();
  redirect(`${base}/${lineupId}?notice=sources`);
}
export async function createLineupItemForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let lineupId: string;
  try {
    await requireInternalUser();
    const lineup = await db.lineup.findUnique({
      where: { id: String(form.get("lineupId")) },
      include: { franchise: true },
    });
    if (!lineup || lineup.archivedAt || lineup.franchise.archivedAt)
      throw new DomainError(
        "ARCHIVED",
        "Restore the lineup and franchise before adding items.",
      );
    sourcesSchema.parse(sourcesFromForm(form));
    // Shared with the edit action so both paths accept exactly the same fields.
    const item = await catalog.createItem(
      itemFromForm(form, lineup.id),
      sourcesFromForm(form),
    );
    lineupId = item.lineupId;
  } catch (error) {
    return formError(error);
  }
  invalidate();
  redirect(`${base}/${lineupId}?notice=item`);
}
