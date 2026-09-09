import Link from "next/link";
import { notFound } from "next/navigation";
import { locationQueries, shipmentQueries } from "@/lib/admin";
import { ActionForm, Field } from "@/components/admin/action-form";
import {
  preparationStatuses,
  shipmentNumber,
} from "@/modules/shipments/validation";
import { shipmentCommand } from "../../actions";
export const metadata = { title: "Dispatch shipment" };
export default async function ShipShipment({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const shipment = await shipmentQueries.detail((await params).id);
  if (!shipment) notFound();
  if (!preparationStatuses.includes(shipment.status))
    return (
      <>
        <h1>Shipment cannot be dispatched</h1>
        <p>This shipment is already dispatched or cancelled.</p>
        <Link href={`/admin/shipments/${shipment.id}`}>Back to shipment</Link>
      </>
    );
  const paths = new Map(
    (await locationQueries.tree()).map((row) => [row.id, row.path]),
  );
  return (
    <>
      <div className="page-heading">
        <h1>Ship {shipmentNumber(shipment.number)}</h1>
      </div>
      <ActionForm
        action={shipmentCommand}
        submitLabel="Confirm dispatch"
        cancelHref={`/admin/shipments/${shipment.id}`}
        className="panel form-section form-stack"
      >
        <input type="hidden" name="id" value={shipment.id} />
        <input type="hidden" name="action" value="ship" />
        <p>
          Move all shipment contents from{" "}
          <strong>{paths.get(shipment.originLocationId)}</strong> into a
          dedicated shipment location under{" "}
          <strong>{paths.get(shipment.transitParentId)}</strong>.
        </p>
        <ul>
          {shipment.items.map((item) => (
            <li key={item.id}>
              {item.quantity} × {item.merchandiseItem.name}
            </li>
          ))}
        </ul>
        <Field name="shipmentDate" label="Shipment date">
          <input
            aria-label="Shipment date"
            type="date"
            name="shipmentDate"
            required
            defaultValue={new Date().toISOString().slice(0, 10)}
          />
        </Field>
        <label>
          <input name="confirm" type="checkbox" required /> I confirm all listed
          goods are being dispatched.
        </label>
        <p className="muted">
          Source inventory is validated again. If any line has insufficient
          stock, no part of this shipment moves. Repeating this action will not
          transfer stock twice.
        </p>
      </ActionForm>
    </>
  );
}
