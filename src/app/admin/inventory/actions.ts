"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { locations } from "@/lib/services";
import { createInventoryCommands } from "@/modules/inventory/commands";
import { formError, type FormState } from "@/modules/lineups/action-state";

export type InventoryCommandState = FormState & {
  success?: string;
  movementId?: string;
};
export async function recordInventory(
  _state: InventoryCommandState,
  form: FormData,
): Promise<InventoryCommandState> {
  try {
    const input = Object.fromEntries(
      [...form.entries()].filter(([key]) => !key.startsWith("$ACTION_")),
    );
    const result = await createInventoryCommands(
      db,
      requireInternalUser,
    ).execute(input);
    revalidatePath("/admin", "layout");
    return {
      success: result.replayed
        ? "This operation was already recorded. Stock was not changed again."
        : "Inventory movement recorded successfully.",
      movementId: result.movement.id,
    };
  } catch (error) {
    if (error instanceof z.ZodError)
      return {
        error: error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(" "),
      };
    return formError(error);
  }
}

export async function saveLocation(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    const values = {
      code: String(form.get("code") ?? ""),
      name: String(form.get("name") ?? ""),
      type: String(form.get("type") ?? ""),
      parentId: form.get("parentId") || null,
      countryCode:
        String(form.get("countryCode") ?? "")
          .trim()
          .toUpperCase() || null,
      active: form.get("active") === "on",
      fulfillmentEnabled: form.get("fulfillmentEnabled") === "on",
      notes: form.get("notes") || null,
    };
    if (form.get("id"))
      await locations.update({
        id: form.get("id"),
        updatedAt: form.get("updatedAt"),
        values,
      });
    else await locations.create(values);
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002")
      return { error: "A location with this code already exists." };
    if (error instanceof z.ZodError)
      return { error: error.issues.map((issue) => issue.message).join(" ") };
    return formError(error);
  }
  revalidatePath("/admin", "layout");
  redirect("/admin/inventory/locations?saved=1");
}
