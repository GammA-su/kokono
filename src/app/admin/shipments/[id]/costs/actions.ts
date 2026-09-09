"use server";
import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createLandedCostService } from "@/modules/landed-costs/service";
import { formError, type FormState } from "@/modules/lineups/action-state";
import type { CostPreview } from "@/modules/landed-costs/validation";
const service = createLandedCostService(db, requireInternalUser);
function failure(error: unknown): FormState {
  return error instanceof z.ZodError
    ? {
        error: error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(" "),
      }
    : formError(error);
}
export async function reviewLandedCosts(
  input: unknown,
): Promise<{ review?: CostPreview; error?: string }> {
  try {
    return { review: await service.preview(input) };
  } catch (error) {
    return failure(error);
  }
}
export async function saveCostPolicy(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let shipmentId: string;
  try {
    shipmentId = z.uuid().parse(form.get("shipmentId"));
    const vat = z.enum(["include", "exclude"]).parse(form.get("vat"));
    await service.saveSettings({
      currency: String(form.get("currency")).toUpperCase(),
      importVatAsCost: vat === "include",
      version: form.get("version") || null,
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/shipments/${shipmentId}/costs`);
}
export async function finalizeLandedCosts(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string, shipmentId: string;
  try {
    await requireInternalUser();
    if (form.get("confirmed") !== "on")
      return { error: "Confirm the reviewed allocation." };
    const input = JSON.parse(String(form.get("input")));
    shipmentId = z.uuid().parse(input.shipmentId);
    id = (await service.finalize(input, form.get("hash"))).id;
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/shipments/${shipmentId}/costs/${id}`);
}
