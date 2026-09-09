import Link from "next/link";
import { notFound } from "next/navigation";
import { locationQueries, shipmentQueries } from "@/lib/admin";
import { ActionForm, Field } from "@/components/admin/action-form";
import { shipmentNumber } from "@/modules/shipments/validation";
import { shipmentCommand } from "../../actions";
export const metadata = { title: "Deliver shipment" };
export default async function DeliverShipment({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const shipment = await shipmentQueries.detail((await params).id);
  if (!shipment) notFound();
  if (!["SHIPPED", "IN_TRANSIT", "CUSTOMS"].includes(shipment.status))
    return (
      <>
        <h1>Shipment cannot be delivered</h1>
        <p>
          Only dispatched, in-transit or customs shipments can be delivered.
        </p>
        <Link href={`/admin/shipments/${shipment.id}`}>Back to shipment</Link>
      </>
    );
  const locations = (await locationQueries.tree()).filter(
    (row) =>
      row.effectiveActive && row.effectiveCountry === "FR" && !row.inTransit,
  );
  return (
    <>
      <div className="page-heading">
        <h1>Deliver {shipmentNumber(shipment.number)}</h1>
      </div>
      <ActionForm
        action={shipmentCommand}
        submitLabel="Confirm delivery"
        cancelHref={`/admin/shipments/${shipment.id}`}
        className="panel form-section form-stack"
      >
        <input name="id" type="hidden" value={shipment.id} />
        <input name="action" type="hidden" value="deliver" />
        <p>
          Confirm all goods have arrived. This transfers the shipment’s own
          transit stock into the chosen France location.
        </p>
        <ul>
          {shipment.items.map((item) => (
            <li key={item.id}>
              {item.quantity} × {item.merchandiseItem.name}
            </li>
          ))}
        </ul>
        <Field name="destinationLocationId" label="Final France placement">
          <select
            aria-label="Final France placement"
            name="destinationLocationId"
            required
            defaultValue={
              locations.some((row) => row.id === shipment.destinationLocationId)
                ? shipment.destinationLocationId
                : ""
            }
          >
            <option value="">Choose France location</option>
            {locations.map((row) => (
              <option key={row.id} value={row.id}>
                {row.path}
                {row.fulfillable ? " · Fulfillable" : " · Not fulfillable"}
              </option>
            ))}
          </select>
        </Field>
        <Field name="arrivalDate" label="Arrival date">
          <input
            aria-label="Arrival date"
            name="arrivalDate"
            type="date"
            required
            min={shipment.shipmentDate?.toISOString().slice(0, 10)}
            defaultValue={new Date().toISOString().slice(0, 10)}
          />
        </Field>
        <label>
          <input type="checkbox" name="confirm" required /> I confirm all listed
          goods arrived at this location.
        </label>
        <p className="muted">
          Fulfillment availability follows the location’s explicit
          configuration. Confirm delivery only when all listed quantities have
          arrived.
        </p>
      </ActionForm>
    </>
  );
}
