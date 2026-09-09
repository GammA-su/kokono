"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createPublicationService } from "@/modules/publication/service";
import { formError, type FormState } from "@/modules/lineups/action-state";
export async function saveCategoryMapping(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    await createPublicationService(db, requireInternalUser).mapCategory({
      categoryId: form.get("categoryId"),
      publicCategoryId: form.get("publicCategoryId") || null,
      expectedPublicCategoryId: form.get("expectedPublicCategoryId") || null,
    });
  } catch (error) {
    return formError(error);
  }
  revalidatePath("/admin", "layout");
  redirect("/admin/publication?mapped=1");
}
