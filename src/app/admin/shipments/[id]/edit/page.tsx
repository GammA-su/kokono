import { notFound } from "next/navigation";
import { locationQueries, shipmentQueries } from "@/lib/admin";
import { ShipmentForm } from "@/components/admin/shipment-form";
import {
  shippingAmounts,
  importAmounts,
  preparationStatuses,
  shipmentNumber,
} from "@/modules/shipments/validation";
import { moneyInputValue } from "@/modules/shared/money";
export const metadata = { title: "Edit shipment" };
export default async function EditShipment({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const shipment = await shipmentQueries.detail((await params).id);
  if (!shipment) notFound();
  const locations = await locationQueries.tree();
  const fields: Record<string, string> = {};
  for (const key of [
    "carrier",
    "carrierService",
    "trackingNumber",
    "packageCount",
    "totalWeight",
    "weightUnit",
    "shippingCurrency",
    "importCurrency",
    "notes",
  ] as const)
    fields[key] = String(shipment[key] ?? "");
  for (const [amounts, currency] of [
    [shippingAmounts, shipment.shippingCurrency],
    [importAmounts, shipment.importCurrency],
  ] as const)
    for (const key of amounts)
      fields[key] =
        shipment[key] === null || !currency
          ? ""
          : moneyInputValue(shipment[key], currency);
  return (
    <>
      <div className="page-heading">
        <h1>Edit {shipmentNumber(shipment.number)}</h1>
      </div>
      <ShipmentForm
        locations={locations}
        initial={{
          id: shipment.id,
          version: shipment.updatedAt.toISOString(),
          locked: !preparationStatuses.includes(shipment.status),
          originLocationId: shipment.originLocationId,
          destinationLocationId: shipment.destinationLocationId,
          transitParentId: shipment.transitParentId,
          fields,
          items: shipment.items.map((item) => ({
            merchandiseItemId: item.merchandiseItemId,
            name: item.merchandiseItem.name,
            quantity: String(item.quantity),
          })),
        }}
      />
    </>
  );
}
