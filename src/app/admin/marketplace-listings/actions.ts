"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createMarketplaceListingService } from "@/modules/marketplace-listings/service";
import { createMarketplaceListingQueries } from "@/modules/marketplace-listings/queries";
import { parseMoneyInput } from "@/modules/shared/money";
import { formError, type FormState } from "@/modules/lineups/action-state";
import { DomainError } from "@/modules/shared/errors";

const service = createMarketplaceListingService(db, requireInternalUser);
function errorState(error: unknown): FormState {
  if (error instanceof z.ZodError)
    return {
      error: error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" "),
    };
  return formError(error);
}
function amount(form: FormData, key: string, currency: string) {
  try {
    return parseMoneyInput(String(form.get(key) ?? ""), currency);
  } catch (error) {
    throw new DomainError(
      "INVALID_AMOUNT",
      `${key}: ${error instanceof Error ? error.message : "Check the amount."}`,
    );
  }
}
export async function saveCandidate(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    await requireInternalUser();
    const currency = z
      .string()
      .regex(/^[A-Z]{3}$/)
      .parse(String(form.get("currency")).trim().toUpperCase());
    const row = await service.save(
      {
        id: form.get("id"),
        merchandiseItemId: form.get("merchandiseItemId"),
        marketplace: form.get("marketplace"),
        externalListingId: form.get("externalListingId"),
        url: form.get("url"),
        sellerName: form.get("sellerName"),
        itemPriceAmount: amount(form, "itemPrice", currency),
        currency,
        domesticShippingAmount: String(
          form.get("domesticShipping") ?? "",
        ).trim()
          ? amount(form, "domesticShipping", currency)
          : null,
        condition: form.get("condition"),
        status: form.get("status"),
        notes: form.get("notes"),
      },
      form.get("version") || undefined,
    );
    id = row.id;
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/marketplace-listings/${id}?saved=1`);
}
export async function changeCandidateStatus(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    id = (
      await service.setStatus({
        id: form.get("id"),
        status: form.get("status"),
        version: form.get("version"),
      })
    ).id;
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/marketplace-listings/${id}?saved=1`);
}
export async function markCandidateChecked(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    id = (await service.markChecked(form.get("id"))).id;
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/marketplace-listings/${id}?checked=1`);
}
export async function convertCandidate(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    const row = await createMarketplaceListingQueries(
      db,
      requireInternalUser,
    ).detail(form.get("id"));
    if (!row)
      throw new DomainError("NOT_FOUND", "Marketplace candidate not found.");
    const purchase = await service.convert({
      id: row.id,
      version: form.get("version"),
      supplier: form.get("supplier"),
      externalReference: form.get("externalReference"),
      purchaseDate: form.get("purchaseDate"),
      status: form.get("status"),
      quantity: Number(form.get("quantity")),
      unitPriceAmount: amount(form, "unitPrice", row.currency),
      domesticShippingAmount: amount(form, "domesticShipping", row.currency),
      feesAmount: amount(form, "fees", row.currency),
      taxesAmount: amount(form, "taxes", row.currency),
      notes: form.get("notes"),
      confirmed: form.get("confirm") === "on",
    });
    id = purchase.id;
  } catch (error) {
    return errorState(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/purchases/${id}`);
}
