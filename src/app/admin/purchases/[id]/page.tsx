import Link from "next/link";
import { notFound } from "next/navigation";
import { catalogQueries, locationQueries, purchaseQueries } from "@/lib/admin";
import { ActionForm, Field } from "@/components/admin/action-form";
import { MediaImage } from "@/components/ui/media-image";
import { formatMoney } from "@/modules/shared/money";
import { quantityNeeded } from "@/modules/watchlist/filters";
import {
  purchaseStatusLabels,
  transitions,
} from "@/modules/purchases/validation";
import { changePurchaseStatus } from "../actions";
export const metadata = { title: "Purchase detail" };
export default async function PurchaseDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const purchase = await purchaseQueries.detail((await params).id);
  if (!purchase) notFound();
  const cards = await catalogQueries.selected([
    ...new Set(purchase.items.map((item) => item.merchandiseItemId)),
  ]);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const locations = await locationQueries.tree();
  const paths = new Map(
    locations.map((location) => [location.id, location.path]),
  );
  const received = purchase.items.filter(
    (item) => item.receivedMovementId,
  ).length;
  const statuses = transitions[purchase.status].filter(
    (status) => status !== "CANCELLED" || !received,
  );
  const result = await searchParams;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PURCHASING · {purchase.id.slice(0, 8)}</p>
          <h1>{purchase.supplier}</h1>
          <p className="muted">
            {purchase.marketplace || "Direct supplier"} ·{" "}
            {purchase.externalReference || "No external reference"} ·{" "}
            {purchase.purchaseDate.toISOString().slice(0, 10)}
          </p>
        </div>
        <div className="detail-actions">
          <Link href="/admin/purchases" className="button">
            All purchases
          </Link>
          {purchase.status === "DRAFT" && (
            <Link
              className="button"
              href={`/admin/purchases/${purchase.id}/edit`}
            >
              Edit draft
            </Link>
          )}
          {!["DRAFT", "CANCELLED", "REFUNDED"].includes(purchase.status) &&
            received < purchase.items.length && (
              <Link
                className="button primary"
                href={`/admin/purchases/${purchase.id}/receive`}
              >
                Receive purchase
              </Link>
            )}
        </div>
      </div>
      {typeof result.received === "string" && /^\d+$/.test(result.received) && (
        <p role="status" className="alert">
          Receipt result: {result.received} received ·{" "}
          {typeof result.skipped === "string" && /^\d+$/.test(result.skipped)
            ? result.skipped
            : 0}{" "}
          already received. Inventory and watch quantities refreshed.
        </p>
      )}
      <section className="panel form-section">
        <h2>{purchaseStatusLabels[purchase.status]}</h2>
        <p>
          {received} of {purchase.items.length} lines received ·{" "}
          {purchase.items.reduce((sum, item) => sum + item.quantity, 0)} units
          ordered
        </p>
        <div className="field-grid">
          {[
            ["Subtotal", purchase.subtotalAmount],
            ["Domestic shipping", purchase.domesticShippingAmount],
            ["Fees", purchase.feesAmount],
            ["Additional taxes", purchase.taxesAmount],
            [
              "Total",
              purchase.subtotalAmount +
                purchase.domesticShippingAmount +
                purchase.feesAmount +
                purchase.taxesAmount,
            ],
          ].map(([label, amount]) => (
            <div key={label}>
              <span className="muted">{label}</span>
              <p>
                <strong>
                  {formatMoney(Number(amount), purchase.currency)}
                </strong>
              </p>
            </div>
          ))}
        </div>
        <p className="muted">
          Inventory receipts record the line unit price. Extra charges have not
          been allocated to landed cost.
        </p>
        {purchase.notes && (
          <p style={{ whiteSpace: "pre-wrap" }}>{purchase.notes}</p>
        )}
        <small className="muted">
          Created by {purchase.createdBy.name} ·{" "}
          {purchase.createdAt.toISOString()} · Updated{" "}
          {purchase.updatedAt.toISOString()}
        </small>
      </section>
      <section className="panel">
        <div className="form-section">
          <h2>Purchase items</h2>
          <p className="muted">
            Watch targets use current owned inventory across all locations.
            Ordered goods count only after receipt. Watches remain enabled until
            you change them.
          </p>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Merchandise</th>
                <th>Quantity</th>
                <th>Unit price / line total</th>
                <th>Condition / source</th>
                <th>Receipt</th>
                <th>PurchaseWatch</th>
              </tr>
            </thead>
            <tbody>
              {purchase.items.map((item) => {
                const card = byId.get(item.merchandiseItemId);
                const watch = card?.purchaseWatch;
                const gap =
                  watch && card
                    ? quantityNeeded(watch.targetQuantity, card.stock.total)
                    : null;
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
                      <div lang="ja" className="muted">
                        {item.merchandiseItem.japaneseName}
                      </div>
                      <small>{item.merchandiseItem.internalSku}</small>
                      {item.notes && (
                        <p style={{ whiteSpace: "pre-wrap" }}>{item.notes}</p>
                      )}
                    </td>
                    <td>{item.quantity}</td>
                    <td>
                      {formatMoney(item.unitPriceAmount, purchase.currency)}
                      <div className="muted">
                        {formatMoney(
                          item.unitPriceAmount * item.quantity,
                          purchase.currency,
                        )}
                      </div>
                    </td>
                    <td>
                      {item.condition || "Not recorded"}
                      {item.marketplaceListing && (
                        <div>
                          <Link
                            href={`/admin/marketplace-listings/${item.marketplaceListing.id}`}
                          >
                            Source candidate
                          </Link>
                        </div>
                      )}
                      {item.sellerListingUrl && (
                        <div>
                          <a
                            href={item.sellerListingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Seller listing
                          </a>
                        </div>
                      )}
                    </td>
                    <td>
                      {item.receivedMovement ? (
                        <>
                          <strong>
                            {paths.get(
                              item.receivedMovement.destinationLocationId!,
                            ) ||
                              item.receivedMovement.destinationLocation?.code}
                          </strong>
                          <div>
                            {item.receivedAt?.toISOString().slice(0, 10)} ·{" "}
                            {item.receivedMovement.actorUser?.name || "System"}
                          </div>
                          <Link
                            href={`/admin/merchandise/catalog/${item.merchandiseItemId}/movements`}
                          >
                            Movement history
                          </Link>
                          {item.receivedMovement.notes && (
                            <p>{item.receivedMovement.notes}</p>
                          )}
                        </>
                      ) : (
                        "Not received"
                      )}
                    </td>
                    <td>
                      {watch && card ? (
                        <>
                          <Link href={`/admin/watchlist/${card.id}`}>
                            {watch.enabled ? "Enabled" : "Disabled"}
                          </Link>
                          <div>
                            Target: {watch.targetQuantity ?? "Not set"} · Owned:{" "}
                            {card.stock.total}
                          </div>
                          <strong>
                            {gap === null
                              ? "No target set"
                              : gap === 0
                                ? "Target satisfied"
                                : `${gap} still wanted`}
                          </strong>
                        </>
                      ) : (
                        "No watch"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {statuses.length > 0 && (
        <section className="panel form-section">
          <h2>Update purchase status</h2>
          <p className="muted">
            Status changes do not add or remove stock. Refunds retain the
            purchase and receipt history; record physical returns using
            inventory movements.
          </p>
          <ActionForm action={changePurchaseStatus} submitLabel="Update status">
            <input type="hidden" name="id" value={purchase.id} />
            <Field name="status" label="New status">
              <select aria-label="New status" name="status">
                {statuses.map((status) => (
                  <option key={status} value={status}>
                    {purchaseStatusLabels[status]}
                  </option>
                ))}
              </select>
            </Field>
            <label>
              <input name="confirm" type="checkbox" required /> Confirm this
              status change
            </label>
          </ActionForm>
        </section>
      )}
    </>
  );
}
