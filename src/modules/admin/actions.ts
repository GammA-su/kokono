"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { catalog } from "@/lib/services";
import { generatedSlug } from "../lineups/service";
import { formError, type FormState } from "../lineups/action-state";
export async function createFranchiseForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    await catalog.createFranchise({
      name: form.get("name"),
      japaneseName: form.get("japaneseName"),
      slug: generatedSlug(String(form.get("name"))),
    });
  } catch (error) {
    return formError(error);
  }
  revalidatePath("/admin/merchandise", "layout");
  redirect("/admin/merchandise/franchises?notice=created");
}

export async function updateFranchiseForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    await catalog.updateFranchise(
      {
        name: form.get("name"),
        japaneseName: form.get("japaneseName"),
        description: form.get("description"),
      },
      {
        id: String(form.get("id") ?? ""),
        updatedAt: String(form.get("updatedAt") ?? ""),
      },
    );
  } catch (error) {
    return formError(error);
  }
  revalidatePath("/admin/merchandise", "layout");
  redirect("/admin/merchandise/franchises?notice=saved");
}

/** Archives when lineups or characters remain; deletes only a franchise nothing references. */
export async function deleteFranchiseForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let outcome: string;
  try {
    outcome = await catalog.removeFranchise(
      form.get("id"),
      form.get("confirmedName"),
    );
  } catch (error) {
    return formError(error);
  }
  revalidatePath("/admin/merchandise", "layout");
  redirect(`/admin/merchandise/franchises?notice=${outcome}`);
}

export async function restoreFranchiseForm(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    await catalog.restoreFranchise(form.get("id"));
  } catch (error) {
    return formError(error);
  }
  revalidatePath("/admin/merchandise", "layout");
  redirect("/admin/merchandise/franchises?notice=restored");
}
