import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createRewardFulfillmentQueries } from "@/modules/gacha/fulfillment-queries";
import { addressSchema } from "@/modules/commerce/policy";
import { RewardActions } from "@/components/admin/reward-actions";
export const metadata = { title: "Reward fulfillment" };
export default async function RewardDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const result = await createRewardFulfillmentQueries(
    db,
    requireInternalUser,
  ).detail(id);
  if (!result) notFound();
  const { reward: r, events, locations } = result,
    address = r.fulfillment ? addressSchema.parse(r.fulfillment.address) : null,
    shipment = r.fulfillment?.shipment;
  return (
    <>
      <Link href="/admin/gacha/rewards">Gacha fulfillment queue</Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{r.status}</p>
          <h1>{r.merchandiseItem.name}</h1>
          <p>
            {r.customer.displayName} · {r.customer.email}
          </p>
          <p className="muted">Reward {r.id}</p>
        </div>
      </div>
      <section className="panel form-section">
        <h2>Pick and delivery details</h2>
        <div className="field-grid">
          <div>
            <h3>Physical reservation</h3>
            <p>
              {r.quantity} unit · {r.merchandiseItem.internalSku}
            </p>
            <p>
              {locations.find((l) => l.id === r.reservation.storageLocationId)
                ?.path ?? "Unknown location"}
            </p>
            <p>{r.reservation.status}</p>
            <Link
              href={`/admin/merchandise/catalog/${r.merchandiseItemId}/movements`}
            >
              Inventory movement history
            </Link>
            {r.reservation.movementId && (
              <p>Movement {r.reservation.movementId}</p>
            )}
          </div>
          <div>
            <h3>Claimed delivery address</h3>
            {address ? (
              <address>
                {address.name}
                <br />
                {address.line1}
                <br />
                {address.line2}
                <br />
                {address.postalCode} {address.city}
                <br />
                {address.country}
              </address>
            ) : (
              <p>The customer has not claimed this prize yet.</p>
            )}
            {r.claimedAt && <p>Claimed {r.claimedAt.toISOString()}</p>}
          </div>
        </div>
        {shipment && (
          <div>
            <h3>Shipment</h3>
            <p>
              {shipment.carrier} · {shipment.trackingNumber}
            </p>
            <p>Dispatched {shipment.shippedAt.toISOString()}</p>
            {shipment.deliveredAt && (
              <p>Delivered {shipment.deliveredAt.toISOString()}</p>
            )}
          </div>
        )}
        <Link href={`/admin/gacha/${r.pull.bannerId}`}>
          Banner, pull and configuration audit
        </Link>
      </section>
      <section className="panel form-section">
        <h2>Fulfillment actions</h2>
        <RewardActions id={r.id} status={r.status} />
        {r.status === "CONSUMED" && (
          <p>
            Legacy physical handover. No shipment or tracking history has been
            invented.
          </p>
        )}
      </section>
      <section className="panel form-section">
        <h2>Audit history</h2>
        <ul>
          {events.map((e) => (
            <li key={e.id}>
              {e.createdAt.toISOString()} · {e.type} ·{" "}
              {e.actorUser?.name ?? "Customer"}
              <p>{e.note}</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
