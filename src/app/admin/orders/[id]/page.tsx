import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createOrderQueries } from "@/modules/commerce/admin-queries";
import {
  addressSchema,
  contactSchema,
  policySchema,
} from "@/modules/commerce/policy";
import { formatMoney } from "@/modules/shared/money";
import { OrderActions } from "@/components/admin/order-actions";
export const metadata = { title: "Customer order" };
export default async function OrderDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const result = await createOrderQueries(db, requireInternalUser).detail(id);
  if (!result) notFound();
  const { order, locations } = result,
    contact = contactSchema.parse(order.contact),
    policy = policySchema.parse(order.policySnapshot);
  return (
    <>
      <Link href="/admin/orders">← Customer orders</Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">STRIPE TEST ORDER</p>
          <h1>{order.number}</h1>
          <p>
            {order.status} · Payment {order.paymentStatus}
          </p>
        </div>
      </div>
      {order.reviewReason && (
        <p role="alert" className="notice">
          {order.reviewReason}
        </p>
      )}
      <section className="panel form-section">
        <div className="field-grid">
          {[
            ["Delivery", order.shippingAddress],
            ["Billing", order.billingAddress],
          ].map(([label, value]) => {
            const address = addressSchema.parse(value);
            return (
              <div key={String(label)}>
                <h2>{String(label)}</h2>
                <p>
                  {address.name}
                  <br />
                  {address.line1}
                  <br />
                  {address.line2}
                  <br />
                  {address.postalCode} {address.city}
                  <br />
                  {address.country}
                </p>
              </div>
            );
          })}
          <div>
            <h2>Contact & quote</h2>
            <p>
              {contact.email}
              <br />
              {contact.phone}
            </p>
            <p>
              {policy.deliveryMethod}
              <br />
              Policy: {policy.version}
            </p>
            <p>
              Merchandise TTC:{" "}
              {formatMoney(order.subtotalAmount, order.currency)}
              <br />
              Shipping TTC: {formatMoney(order.shippingAmount, order.currency)}
              <br />
              Included VAT: {formatMoney(order.taxAmount, order.currency)}{" "}
              (shipping {formatMoney(order.shippingTaxAmount, order.currency)}{" "}
              at {order.shippingTaxRateBps / 100}%)
              <br />
              <strong>
                Total TTC: {formatMoney(order.totalAmount, order.currency)}
              </strong>
              <br />
              Refund recorded:{" "}
              {formatMoney(order.refundedAmount, order.currency)}
            </p>
          </div>
        </div>
        {order.fulfillment?.shipment && (
          <p>
            Carrier: {order.fulfillment.shipment.carrier} · Tracking:{" "}
            {order.fulfillment.shipment.trackingNumber}
          </p>
        )}
      </section>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Snapshot / catalog</th>
                <th>Quantity</th>
                <th>Unit TTC</th>
                <th>Included VAT</th>
                <th>Location allocations / movements</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.title}
                    <br />
                    <Link
                      href={`/admin/merchandise/catalog/${item.merchandiseItemId}`}
                    >
                      {item.merchandiseItem.internalSku}
                    </Link>
                  </td>
                  <td>{item.quantity}</td>
                  <td>{formatMoney(item.unitPriceAmount, item.currency)}</td>
                  <td>
                    {formatMoney(item.taxAmount, item.currency)} (
                    {item.taxRateBps / 100}%)
                  </td>
                  <td>
                    {item.reservations.map((a) => (
                      <div key={a.id}>
                        {locations.find((l) => l.id === a.storageLocationId)
                          ?.path ?? a.storageLocationId}
                        : {a.quantity} · {a.status}
                        {a.movementId && (
                          <>
                            {" "}
                            ·{" "}
                            <Link
                              href={`/admin/merchandise/catalog/${item.merchandiseItemId}/movements`}
                            >
                              SALE ledger
                            </Link>
                          </>
                        )}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <OrderActions
        id={id}
        status={order.status}
        paymentStatus={order.paymentStatus}
      />
      {order.paymentAttempt && (
        <section className="panel form-section">
          <h2>Payment reconciliation</h2>
          <p>
            Attempt: {order.paymentAttempt.id}
            <br />
            State: {order.paymentAttempt.status}
            <br />
            Stripe session:{" "}
            {order.paymentAttempt.providerSessionId ?? "Not created"}
            <br />
            Payment intent:{" "}
            {order.paymentAttempt.paymentIntentId ?? "Not confirmed"}
            <br />
            Refund: {order.paymentAttempt.refundId ?? "None recorded"}
            <br />
            Last reconciled:{" "}
            {order.paymentAttempt.lastReconciledAt?.toISOString() ?? "Not yet"}
          </p>
          <p className="muted">
            Latest 100 verified events. Refund event amounts may overlap; they
            must not be summed. The order refund total uses the greatest
            verified amount, including cumulative charge reconciliation.
          </p>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider event</th>
                  <th>Type</th>
                  <th>Verified amount</th>
                </tr>
              </thead>
              <tbody>
                {order.paymentAttempt.events.map((event) => (
                  <tr key={event.id}>
                    <td>{event.eventId}</td>
                    <td>{event.type}</td>
                    <td>{formatMoney(event.amount, event.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="panel form-section">
        <h2>Audit history</h2>
        <p className="muted">
          Latest 100 events. All events remain in the database.
        </p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date (Paris)</th>
                <th>Event</th>
                <th>Actor</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {order.events.map((event) => (
                <tr key={event.id}>
                  <td>
                    {event.createdAt.toLocaleString("en-GB", {
                      timeZone: "Europe/Paris",
                    })}
                  </td>
                  <td>{event.type}</td>
                  <td>{event.actorUser?.name ?? "Guest / payment system"}</td>
                  <td>{event.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
