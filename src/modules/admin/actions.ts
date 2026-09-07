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
