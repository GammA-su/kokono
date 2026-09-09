import Link from "next/link";
import { db } from "@/lib/db";
import { requireInternalUser } from "@/lib/authorization";
import { createOrderQueries } from "@/modules/commerce/admin-queries";
import { OrderStatus, OrderPaymentStatus } from "@/generated/prisma/enums";
import { formatMoney } from "@/modules/shared/money";
import { Pagination } from "@/components/admin/pagination";
export const metadata = { title: "Customer orders" };
export default async function Orders({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = await createOrderQueries(db, requireInternalUser).list(
    await searchParams,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE</p>
          <h1>
            Customer orders{" "}
            <span className="heading-count">{result.total}</span>
          </h1>
          <p className="muted">France mainland · EUR TTC · Stripe test mode</p>
        </div>
      </div>
      <form method="get" className="panel form-section field-grid">
        <label className="field">
          <span>Order number</span>
          <input name="q" defaultValue={result.filters.q} />
        </label>
        <label className="field">
          <span>Status</span>
          <select name="status" defaultValue={result.filters.status ?? ""}>
            <option value="">All statuses</option>
            {Object.values(OrderStatus).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Payment</span>
          <select name="payment" defaultValue={result.filters.payment ?? ""}>
            <option value="">All payments</option>
            {Object.values(OrderPaymentStatus).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <button className="button">Filter</button>
      </form>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Date</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Lines</th>
                <th>Total TTC</th>
                <th>Unpaid hold expiry</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((order) => (
                <tr key={order.id}>
                  <td>
                    <Link href={`/admin/orders/${order.id}`}>
                      {order.number}
                    </Link>
                  </td>
                  <td>
                    {order.createdAt.toLocaleString("en-GB", {
                      timeZone: "Europe/Paris",
                    })}
                  </td>
                  <td>{order.status}</td>
                  <td>{order.paymentStatus}</td>
                  <td>{order._count.items}</td>
                  <td>{formatMoney(order.totalAmount, order.currency)}</td>
                  <td>
                    {order.status === "PENDING"
                      ? order.expiresAt.toLocaleString("en-GB", {
                          timeZone: "Europe/Paris",
                        })
                      : "—"}
                  </td>
                </tr>
              ))}
              {!result.items.length && (
                <tr>
                  <td colSpan={7}>No customer orders match these filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          base="/admin/orders"
          params={result.filters}
          page={result.filters.page}
          pageCount={result.pageCount}
          total={result.total}
          size={result.size}
        />
      </section>
    </>
  );
}
