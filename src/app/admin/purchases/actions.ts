"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createCatalogQueries } from "@/modules/catalog/queries";
import { createPurchaseService } from "@/modules/purchases/service";
import { parseMoneyInput } from "@/modules/shared/money";
import { formError, type FormState } from "@/modules/lineups/action-state";

const service = createPurchaseService(db, requireInternalUser);
export async function searchPurchaseItems(q: string, page: number) {
  const result = await createCatalogQueries(db, requireInternalUser).list({
    q,
    page,
    size: 24,
    sort: "alphabetical",
  });
  return {
    items: result.items.map(({ id, name, japaneseName, internalSku }) => ({
      id,
      name,
      japaneseName,
      internalSku,
    })),
    page: result.filters.page,
    pageCount: result.pageCount,
    total: result.total,
  };
}
function errorState(error: unknown): FormState {
  if (error instanceof z.ZodError)
    return {
      error: error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" "),
    };
  return formError(error);
}
export async function savePurchase(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    await requireInternalUser();
    const currency = z
      .string()
      .regex(/^[A-Z]{3}$/)
      .parse(String(form.get("currency")).toUpperCase());
    const rows = z
      .array(
        z.object({
          merchandiseItemId: z.uuid(),
          quantity: z.string(),
          unitPrice: z.string(),
          condition: z.string(),
          sellerListingUrl: z.string(),
          notes: z.string(),
        }),
      )
      .min(1)
      .max(200)
      .parse(JSON.parse(String(form.get("items"))));
    let amounts;
    try {
      amounts = {
        domesticShippingAmount: parseMoneyInput(
          String(form.get("domesticShipping") || "0"),
          currency,
        ),
        feesAmount: parseMoneyInput(String(form.get("fees") || "0"), currency),
        taxesAmount: parseMoneyInput(
          String(form.get("taxes") || "0"),
          currency,
        ),
        items: rows.map((row) => ({
          merchandiseItemId: row.merchandiseItemId,
          quantity: Number(row.quantity),
          unitPriceAmount: parseMoneyInput(row.unitPrice, currency),
          condition: row.condition,
          sellerListingUrl: row.sellerListingUrl || null,
          notes: row.notes,
        })),
      };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Check purchase amounts.",
      };
    }
    const input = {
      id: form.get("id"),
      supplier: form.get("supplier"),
      marketplace: form.get("marketplace"),
      externalReference: form.get("externalReference"),
      purchaseDate: form.get("purchaseDate"),
      currency,
      status: form.get("status"),
      notes: form.get("notes"),
      ...amounts,
    };
    const purchase = form.get("version")
      ? await service.updateDraft(input, form.get("version"))
      : await service.create(input);
    id = purchase.id;
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/purchases/${id}`);
}
export async function changePurchaseStatus(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    if (form.get("confirm") !== "on")
      return { error: "Confirm the status change." };
    id = (await service.setStatus(form.get("id"), form.get("status"))).id;
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/purchases/${id}`);
}
export async function receivePurchase(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string, result: { received: number; skipped: number };
  try {
    if (form.get("confirm") !== "on")
      return { error: "Confirm that the selected goods physically arrived." };
    id = z.uuid().parse(form.get("id"));
    result = await service.receive({
      purchaseId: id,
      itemIds: form.getAll("itemIds"),
      destinationLocationId: form.get("destinationLocationId"),
      notes: form.get("notes"),
    });
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/admin", "layout");
  redirect(
    `/admin/purchases/${id}?received=${result.received}&skipped=${result.skipped}`,
  );
}
