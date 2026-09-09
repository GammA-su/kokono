import Link from "next/link";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createRewardFulfillmentQueries } from "@/modules/gacha/fulfillment-queries";
import { Pagination } from "@/components/admin/pagination";
import { MediaImage } from "@/components/ui/media-image";
export const metadata = { title: "Gacha fulfillment" };
const tabs = {
  AWARDED: "Unclaimed",
  CLAIMED: "Claimed",
  PREPARING: "Ready to pack",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  CONSUMED: "Legacy handovers",
};
export default async function Rewards({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = await createRewardFulfillmentQueries(
    db,
    requireInternalUser,
  ).list(await searchParams);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CUSTOMER FULFILLMENT</p>
          <h1>Gacha rewards</h1>
          <p>
            Physical prize claims and dispatch. Reserved units remain assigned
            to their customer.
          </p>
        </div>
      </div>
      <nav aria-label="Reward queues" className="form-actions">
        {Object.entries(tabs).map(([status, label]) => (
          <Link
            className="button"
            key={status}
            aria-current={result.filters.status === status ? "page" : undefined}
            href={`/admin/gacha/rewards?status=${status}`}
          >
            {label} ({result.counts[status] ?? 0})
          </Link>
        ))}
      </nav>
      <form method="get" className="panel form-section field-grid">
        <input type="hidden" name="status" value={result.filters.status} />
        <label className="field">
          <span>Customer email, merchandise or SKU</span>
          <input name="q" defaultValue={result.filters.q} />
        </label>
        <button className="button">Search</button>
      </form>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Prize</th>
                <th>Customer</th>
                <th>Banner</th>
                <th>Awarded / claimed</th>
                <th>Quantity / reservation</th>
                <th>Dispatch</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <MediaImage
                      reference={r.merchandiseItem.images[0]?.storageKey}
                      alt={r.merchandiseItem.name}
                    />
                    <Link href={`/admin/gacha/rewards/${r.id}`}>
                      {r.merchandiseItem.name}
                    </Link>
                    <div className="muted">{r.merchandiseItem.internalSku}</div>
                  </td>
                  <td>
                    {r.customer.displayName}
                    <div>{r.customer.email}</div>
                  </td>
                  <td>{r.pull.banner.name}</td>
                  <td>
                    {r.createdAt.toISOString().slice(0, 10)}
                    <div>
                      {r.claimedAt?.toISOString().slice(0, 10) ?? "Unclaimed"}
                    </div>
                  </td>
                  <td>
                    {r.quantity} · {r.reservation.status}
                  </td>
                  <td>
                    {r.fulfillment?.shipment
                      ? `${r.fulfillment.shipment.carrier}: ${r.fulfillment.shipment.trackingNumber}`
                      : "Not dispatched"}
                  </td>
                </tr>
              ))}
              {!result.items.length && (
                <tr>
                  <td colSpan={6}>No rewards in this queue.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          base="/admin/gacha/rewards"
          params={{ status: result.filters.status, q: result.filters.q }}
          page={result.filters.page}
          pageCount={result.pageCount}
          total={result.total}
          size={result.size}
        />
      </section>
    </>
  );
}
