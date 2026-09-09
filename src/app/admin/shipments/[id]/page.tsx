import Link from "next/link";
import { notFound } from "next/navigation";
import { catalogQueries, locationQueries, shipmentQueries } from "@/lib/admin";
import { ActionForm, Field } from "@/components/admin/action-form";
import { MediaImage } from "@/components/ui/media-image";
import { formatOptionalMoney } from "@/modules/shared/money";
import {
  costLabels,
  shippingAmounts,
  importAmounts,
  preparationStatuses,
  shipmentNumber,
  statusTransitions,
} from "@/modules/shipments/validation";
import { shipmentCommand } from "../actions";
export const metadata = { title: "Shipment detail" };
export default async function ShipmentDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const shipment = await shipmentQueries.detail((await params).id);
  if (!shipment) notFound();
  const locations = await locationQueries.tree(),
    paths = new Map(locations.map((row) => [row.id, row.path]));
  const cards = await catalogQueries.selected(
      shipment.items.map((item) => item.merchandiseItemId),
    ),
    byId = new Map(cards.map((card) => [card.id, card]));
  const result = (await searchParams).result;
  const locationLink = (id: string) => (
    <Link href={`/admin/inventory?location=${id}`}>{paths.get(id) || id}</Link>
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">JAPAN → FRANCE · {shipment.status}</p>
          <h1>{shipmentNumber(shipment.number)}</h1>
          <p className="muted">
            {shipment.items.reduce((sum, item) => sum + item.quantity, 0)} units
            · {shipment.items.length} SKUs · {shipment.packageCount} packages
          </p>
        </div>
        <div className="detail-actions">
          <Link className="button" href="/admin/shipments">
            All shipments
          </Link>
          <Link
            className="button"
            href={`/admin/shipments/${shipment.id}/edit`}
          >
            Edit shipment
          </Link>
          <Link
            className="button"
            href={`/admin/shipments/${shipment.id}/costs`}
          >
            Landed costs
          </Link>
          {preparationStatuses.includes(shipment.status) && (
            <Link
              className="button primary"
              href={`/admin/shipments/${shipment.id}/ship`}
            >
              Ship shipment
            </Link>
          )}
          {["SHIPPED", "IN_TRANSIT", "CUSTOMS"].includes(shipment.status) && (
            <Link
              className="button primary"
              href={`/admin/shipments/${shipment.id}/deliver`}
            >
              Deliver shipment
            </Link>
          )}
        </div>
      </div>
      {(result === "saved" || result === "replayed") && (
        <p className="alert" role="status">
          {result === "replayed"
            ? "This action was already completed. Inventory was not moved again."
            : "Shipment action completed."}
        </p>
      )}
      <section className="panel form-section">
        <h2>Route and tracking</h2>
        <p>
          {locationLink(shipment.originLocationId)} →{" "}
          {shipment.transitLocationId
            ? locationLink(shipment.transitLocationId)
            : locationLink(shipment.transitParentId)}{" "}
          → {locationLink(shipment.destinationLocationId)}
        </p>
        <div className="field-grid">
          <div>
            <span className="muted">Carrier / service</span>
            <p>
              {shipment.carrier || "Not recorded"} ·{" "}
              {shipment.carrierService || "Not recorded"}
            </p>
          </div>
          <div>
            <span className="muted">Tracking number</span>
            <p>{shipment.trackingNumber || "Not recorded"}</p>
          </div>
          <div>
            <span className="muted">Shipment date</span>
            <p>
              {shipment.shipmentDate?.toISOString().slice(0, 10) ||
                "Not dispatched"}
            </p>
          </div>
          <div>
            <span className="muted">Arrival date</span>
            <p>
              {shipment.arrivalDate?.toISOString().slice(0, 10) ||
                "Not delivered"}
            </p>
          </div>
          <div>
            <span className="muted">Total weight</span>
            <p>
              {shipment.totalWeight
                ? `${shipment.totalWeight} ${shipment.weightUnit?.toLowerCase()}`
                : "Not recorded"}
            </p>
          </div>
        </div>
        {shipment.notes && (
          <p style={{ whiteSpace: "pre-wrap" }}>{shipment.notes}</p>
        )}
        <p className="muted">
          Created by {shipment.createdBy.name} ·{" "}
          {shipment.createdAt.toISOString()} · Updated{" "}
          {shipment.updatedAt.toISOString()}
        </p>
      </section>
      <section className="panel">
        <div className="form-section">
          <h2>Contents and inventory audit</h2>
          <p className="muted">
            Each leg is an inventory transfer. Total ownership is preserved;
            only physical placement and fulfillment availability change.
          </p>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Merchandise</th>
                <th>Shipment quantity</th>
                <th>Owned / fulfillable now</th>
                <th>Dispatch movement</th>
                <th>Delivery movement</th>
              </tr>
            </thead>
            <tbody>
              {shipment.items.map((item) => {
                const card = byId.get(item.merchandiseItemId);
                return (
                  <tr key={item.id}>
                    <td>
                      <MediaImage
                        reference={card?.images[0]?.storageKey}
                        alt={item.merchandiseItem.name}
                      />
                      <Link
                        href={`/admin/merchandise/catalog/${item.merchandiseItemId}`}
                      >
                        {item.merchandiseItem.name}
                      </Link>
                      <div className="muted" lang="ja">
                        {item.merchandiseItem.japaneseName}
                      </div>
                      <small>{item.merchandiseItem.internalSku}</small>
                    </td>
                    <td>{item.quantity}</td>
                    <td>
                      {card?.stock.total ?? 0} / {card?.stock.fulfillable ?? 0}
                    </td>
                    {[item.dispatchMovement, item.deliveryMovement].map(
                      (movement, index) => (
                        <td key={index}>
                          {movement ? (
                            <>
                              <Link
                                href={`/admin/merchandise/catalog/${item.merchandiseItemId}/movements?type=TRANSFER`}
                              >
                                TRANSFER +{movement.quantityDelta}
                              </Link>
                              <div>
                                {paths.get(movement.sourceLocationId!)} →{" "}
                                {paths.get(movement.destinationLocationId!)}
                              </div>
                              <small>
                                {movement.createdAt.toISOString()} ·{" "}
                                {movement.actorUser?.name || "System"}
                              </small>
                              <div className="muted">
                                Movement {movement.id}
                              </div>
                            </>
                          ) : (
                            "Not recorded"
                          )}
                        </td>
                      ),
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel form-section">
        <h2>Shipping and import costs</h2>
        <div className="field-grid">
          {(
            [
              [shippingAmounts, shipment.shippingCurrency],
              [importAmounts, shipment.importCurrency],
            ] as const
          ).flatMap(([amounts, currency]) =>
            amounts.map((key) => (
              <div key={key}>
                <span className="muted">{costLabels[key]}</span>
                <p>
                  {formatOptionalMoney(shipment[key], currency) ||
                    "Not recorded"}
                </p>
              </div>
            )),
          )}
        </div>
        <p className="muted">
          Costs retain their recorded currencies. Blank costs are unknown; no
          automatic conversion or allocation to item acquisition costs is
          applied.
        </p>
      </section>
      {statusTransitions[shipment.status].length > 0 && (
        <section className="panel form-section">
          <h2>Update logistics status</h2>
          <ActionForm action={shipmentCommand} submitLabel="Update status">
            <input name="id" type="hidden" value={shipment.id} />
            <input name="action" type="hidden" value="status" />
            <Field name="status" label="New status">
              <select aria-label="New status" name="status">
                {statusTransitions[shipment.status].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </Field>
            <label>
              <input name="confirm" type="checkbox" required /> Confirm status
              change
            </label>
            <p className="muted">
              This status update does not move stock. Cancellation is available
              only before dispatch.
            </p>
          </ActionForm>
        </section>
      )}
    </>
  );
}
