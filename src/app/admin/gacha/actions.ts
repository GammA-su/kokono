"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createGachaService } from "@/modules/gacha/service";
import { createCatalogQueries } from "@/modules/catalog/queries";
import { formError, type FormState } from "@/modules/lineups/action-state";
import { createGachaCustomerAdmin } from "@/modules/gacha/customer-service";
const customerAdmin = createGachaCustomerAdmin(db, requireInternalUser);
const service = createGachaService(db, requireInternalUser);
export async function findPrizeItems(q: string) {
  const result = await createCatalogQueries(db, requireInternalUser).list({
    q,
    page: 1,
    size: 24,
    sort: "alphabetical",
  });
  return result.items.map((p) => ({
    id: p.id,
    name: p.name,
    internalSku: p.internalSku,
  }));
}
export async function saveGacha(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    await requireInternalUser();
    if (form.get("confirm") !== "on")
      return {
        error: "Confirm the physical stock reservation and exact odds.",
      };
    id = (
      await service.configure(JSON.parse(String(form.get("configuration"))))
    ).id;
  } catch (error) {
    return error instanceof z.ZodError
      ? { error: error.issues.map((i) => i.message).join(" ") }
      : formError(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/gacha/${id}`);
}
export async function gachaOperation(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    await requireInternalUser();
    id = z.uuid().parse(form.get("bannerId"));
    if (form.get("confirm") !== "on")
      return { error: "Confirm this operation." };
    const action = form.get("action");
    if (action === "CUSTOMER_ENABLE" || action === "CUSTOMER_DISABLE")
      await customerAdmin.enable({
        bannerId: id,
        enabled: action === "CUSTOMER_ENABLE",
        reason: form.get("reason"),
      });
    else if (action === "CUSTOMER_AUTHORIZE")
      await customerAdmin.authorize({
        bannerId: id,
        customerId: form.get("customerId"),
        operationKey: form.get("operationKey"),
        maxPulls: Number(form.get("maxPulls")),
        expiresAt: new Date(String(form.get("expiresAt")) + "Z").toISOString(),
        reason: form.get("reason"),
      });
    else if (action === "GRANT")
      await service.grant({
        bannerId: id,
        configurationId: form.get("configurationId"),
        operationKey: form.get("operationKey"),
        customerReference: form.get("customerReference"),
        reason: form.get("reason"),
      });
    else if (action === "CONSUME" || action === "CANCEL")
      await service.finalize({
        pullId: form.get("pullId"),
        action,
        reason: form.get("reason"),
      });
    else
      await service.control({
        bannerId: id,
        configurationId: form.get("configurationId"),
        action,
        reason: form.get("reason"),
      });
  } catch (error) {
    return error instanceof z.ZodError
      ? { error: error.issues.map((i) => i.message).join(" ") }
      : formError(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/gacha/${id}`);
}
export async function simulateGacha(configurationId: string, count: number) {
  return service.simulate({ configurationId, count });
}
