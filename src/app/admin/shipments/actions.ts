"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createCatalogQueries } from "@/modules/catalog/queries";
import { createShipmentService } from "@/modules/shipments/service";
import { shippingAmounts, importAmounts } from "@/modules/shipments/validation";
import { parseMoneyInput } from "@/modules/shared/money";
import { formError, type FormState } from "@/modules/lineups/action-state";
const service = createShipmentService(db, requireInternalUser);
export async function searchShipmentStock(
  origin: string,
  q: string,
  page: number,
) {
  const location = z.uuid().parse(origin);
  const result = await createCatalogQueries(db, requireInternalUser).list({
    location,
    q,
    page,
    archived: "true",
    sort: "alphabetical",
  });
  return {
    origin: location,
    page: result.filters.page,
    pageCount: result.pageCount,
    total: result.total,
    items: result.items.map((item) => ({
      id: item.id,
      name: item.name,
      japaneseName: item.japaneseName,
      internalSku: item.internalSku,
      available:
        item.stock.locations.find((row) => row.locationId === location)
          ?.quantity || 0,
    })),
  };
}
function failure(error: unknown): FormState {
  if (error instanceof z.ZodError)
    return {
      error: error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" "),
    };
  return formError(error);
}
export async function saveShipment(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string;
  try {
    await requireInternalUser();
    const input: Record<string, unknown> = Object.fromEntries(
      [...form.entries()].filter(
        ([key]) => !key.startsWith("$ACTION_") && key !== "version",
      ),
    );
    input.packageCount = Number(form.get("packageCount"));
    input.totalWeight = form.get("totalWeight") || null;
    input.weightUnit = form.get("totalWeight") ? form.get("weightUnit") : null;
    const rows = z
      .array(z.object({ merchandiseItemId: z.uuid(), quantity: z.string() }))
      .max(200)
      .parse(JSON.parse(String(form.get("items"))));
    input.items = rows.map((row) => ({
      ...row,
      quantity: Number(row.quantity),
    }));
    for (const [fields, currencyField] of [
      [shippingAmounts, "shippingCurrency"],
      [importAmounts, "importCurrency"],
    ] as const) {
      const currency = String(form.get(currencyField) || "").toUpperCase();
      input[currencyField] = currency || null;
      for (const field of fields) {
        const value = String(form.get(field) || "").trim();
        if (value && !/^[A-Z]{3}$/.test(currency))
          return { error: "Enter a three-letter currency for recorded costs." };
        try {
          input[field] = value ? parseMoneyInput(value, currency) : null;
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : "Check costs.",
          };
        }
      }
    }
    const shipment = form.get("version")
      ? await service.update(input, form.get("version"))
      : await service.create(input);
    id = shipment.id;
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/shipments/${id}`);
}
export async function shipmentCommand(
  _state: FormState,
  form: FormData,
): Promise<FormState> {
  let id: string,
    replayed = false;
  try {
    await requireInternalUser();
    if (form.get("confirm") !== "on")
      return { error: "Confirm this shipment action." };
    id = z.uuid().parse(form.get("id"));
    const action = z
      .enum(["ship", "deliver", "status"])
      .parse(form.get("action"));
    if (action === "ship")
      replayed = (
        await service.ship({ id, shipmentDate: form.get("shipmentDate") })
      ).replayed;
    else if (action === "deliver")
      replayed = (
        await service.deliver({
          id,
          arrivalDate: form.get("arrivalDate"),
          destinationLocationId: form.get("destinationLocationId"),
        })
      ).replayed;
    else await service.setStatus(id, form.get("status"));
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/shipments/${id}?result=${replayed ? "replayed" : "saved"}`);
}
