"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { setCustomerDisabled } from "@/modules/customers/service";
export async function changeCustomerStatus(form: FormData) {
  await setCustomerDisabled(db, requireInternalUser, {
    id: form.get("id"),
    disabled: form.get("disabled") === "true",
  });
  revalidatePath("/admin/customers");
}
