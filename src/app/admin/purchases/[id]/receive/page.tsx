import Link from "next/link";
import { notFound } from "next/navigation";
import { locationQueries, purchaseQueries } from "@/lib/admin";
import { ActionForm, Field } from "@/components/admin/action-form";
import { formatMoney } from "@/modules/shared/money";
import { receivePurchase } from "../../actions";
export const metadata = { title: "Receive purchase" };
export default async function ReceivePurchase({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const purchase = await purchaseQueries.detail((await params).id);
  if (!purchase) notFound();
  const locations = (await locationQueries.tree()).filter(
    (location) => location.effectiveActive,
  );
  const outstanding = purchase.items.filter((item) => !item.receivedMovementId);
  if (
    ["DRAFT", "CANCELLED", "REFUNDED"].includes(purchase.status) ||
    !outstanding.length
  )
    return (
      <>
        <h1>Purchase cannot be received</h1>
        <p>
          Only ordered, paid or other active purchases with outstanding lines
          can receive goods.
        </p>
        <Link href={`/admin/purchases/${purchase.id}`}>Back to purchase</Link>
      </>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PURCHASING</p>
          <h1>Receive purchase</h1>
          <p>
            {purchase.supplier} ·{" "}
            {purchase.externalReference || purchase.id.slice(0, 8)}
          </p>
        </div>
      </div>
      <ActionForm
        action={receivePurchase}
        submitLabel="Receive selected lines"
        cancelHref={`/admin/purchases/${purchase.id}`}
        className="panel form-section form-stack"
      >
        <input type="hidden" name="id" value={purchase.id} />
        <p className="muted">
          Select the lines that have physically arrived. Each selected line is
          received in full, once. All selected lines are committed together; an
          error leaves inventory unchanged.
        </p>
        <Field
          name="destinationLocationId"
          label="Destination storage location"
        >
          <select
            aria-label="Destination storage location"
            name="destinationLocationId"
            required
            defaultValue={
              locations.find((location) => location.effectiveCountry === "JP")
                ?.id || ""
            }
          >
            <option value="">Choose a location</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.path} ·{" "}
                {location.effectiveCountry || "Country not configured"}
                {location.fulfillable ? " · Fulfillable" : ""}
              </option>
            ))}
          </select>
        </Field>
        {!locations.length && (
          <p className="alert">
            Create an active storage location before receiving.
          </p>
        )}
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Receive</th>
                <th>Merchandise</th>
                <th>Quantity</th>
                <th>Recorded unit cost</th>
              </tr>
            </thead>
            <tbody>
              {outstanding.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input
                      type="checkbox"
                      name="itemIds"
                      value={item.id}
                      defaultChecked
                      aria-label={`Receive ${item.merchandiseItem.name} line ${item.position + 1}`}
                    />
                  </td>
                  <td>
                    {item.merchandiseItem.name}
                    <div className="muted">
                      {item.merchandiseItem.internalSku}
                    </div>
                  </td>
                  <td>{item.quantity}</td>
                  <td>
                    {formatMoney(item.unitPriceAmount, purchase.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Field name="notes" label="Receipt notes">
          <textarea name="notes" maxLength={20000} />
        </Field>
        <label>
          <input type="checkbox" name="confirm" required /> I confirm these
          goods arrived at the selected location.
        </label>
        <p className="muted">
          Receiving every line into a location configured in Japan sets
          “Received in Japan”. Other destinations preserve the commercial
          status. Watches are not automatically disabled.
        </p>
      </ActionForm>
    </>
  );
}
