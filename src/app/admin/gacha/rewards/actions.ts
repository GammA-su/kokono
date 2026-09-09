"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createRewardFulfillmentService } from "@/modules/gacha/fulfillment";
import { formError, type FormState } from "@/modules/lineups/action-state";
export async function changeReward(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    await requireInternalUser();
    if (form.get("confirm") !== "on")
      return { error: "Confirm this physical fulfillment operation." };
    const result = await createRewardFulfillmentService(
      db,
      requireInternalUser,
    ).transition({
      id: form.get("id"),
      action: form.get("action"),
      carrier: form.get("carrier") || "",
      trackingNumber: form.get("trackingNumber") || "",
      reason: form.get("reason"),
    });
    id = result.id;
  } catch (error) {
    return formError(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/gacha/rewards/${id}`);
}
