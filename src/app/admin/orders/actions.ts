"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createOrderAdminService } from "@/modules/commerce/service";
import { createPaymentService } from "@/modules/commerce/payments";
import { stripeProvider } from "@/modules/commerce/stripe";
import { configuredCustomerMail } from "@/modules/customer-email/resend";
import { formError, type FormState } from "@/modules/lineups/action-state";
export async function changeOrder(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    await requireInternalUser();
    id = z.uuid().parse(form.get("id"));
    if (form.get("confirm") !== "on")
      return { error: "Confirm this full-order operation." };
    if (form.get("action") === "REFUND")
      await createPaymentService(db, stripeProvider()).refund(
        id,
        requireInternalUser,
      );
    else
      await createOrderAdminService(
        db,
        requireInternalUser,
        configuredCustomerMail(),
      ).transition({
        id,
        action: form.get("action"),
        carrier: form.get("carrier") || "",
        trackingNumber: form.get("trackingNumber") || "",
      });
  } catch (error) {
    return formError(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/orders/${id}`);
}
