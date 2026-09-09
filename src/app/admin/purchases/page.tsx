import Link from "next/link";
import { purchaseQueries } from "@/lib/admin";
import { Pagination } from "@/components/admin/pagination";
import { formatMoney } from "@/modules/shared/money";
import {
  purchaseStatuses,
  purchaseStatusLabels,
} from "@/modules/purchases/validation";
export const metadata = { title: "Purchases" };
export default async function Purchases({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = await purchaseQueries.list(await searchParams);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE</p>
          <h1>
            Purchases <span className="heading-count">{result.total}</span>
          </h1>
          <p className="muted">
            Orders placed with suppliers and marketplaces. Receive goods when
            they physically arrive.
          </p>
        </div>
        <Link className="button primary" href="/admin/purchases/new">
          Create purchase
        </Link>
      </div>
      <form className="panel form-section field-grid" method="get">
        <label className="field">
          <span>Search purchases</span>
          <input
            name="q"
            defaultValue={result.filters.q}
            placeholder="Supplier, marketplace or order reference"
            maxLength={200}
          />
        </label>
        <label className="field">
          <span>Status</span>
          <select
            aria-label="Status"
            name="status"
            defaultValue={result.filters.status || ""}
          >
            <option value="">All statuses</option>
            {purchaseStatuses.map((status) => (
              <option key={status} value={status}>
                {purchaseStatusLabels[status]}
              </option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <button className="button" type="submit">
            Filter
          </button>
          <Link className="button" href="/admin/purchases">
            Reset
          </Link>
        </div>
      </form>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Purchase / supplier</th>
                <th>Marketplace</th>
                <th>Date</th>
                <th>Status</th>
                <th>Lines / units</th>
                <th>Received lines</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((purchase) => (
                <tr key={purchase.id}>
                  <td>
                    <Link href={`/admin/purchases/${purchase.id}`}>
                      {purchase.supplier}
                    </Link>
                    <div className="muted">
                      {purchase.externalReference || purchase.id.slice(0, 8)}
                    </div>
                  </td>
                  <td>{purchase.marketplace || "—"}</td>
                  <td>{purchase.purchaseDate.toISOString().slice(0, 10)}</td>
                  <td>{purchaseStatusLabels[purchase.status]}</td>
                  <td>
                    {purchase._count.items} /{" "}
                    {purchase.items.reduce(
                      (sum, item) => sum + item.quantity,
                      0,
                    )}
                  </td>
                  <td>
                    {
                      purchase.items.filter((item) => item.receivedMovementId)
                        .length
                    }{" "}
                    / {purchase._count.items}
                  </td>
                  <td>
                    {formatMoney(
                      purchase.subtotalAmount +
                        purchase.domesticShippingAmount +
                        purchase.feesAmount +
                        purchase.taxesAmount,
                      purchase.currency,
                    )}
                  </td>
                </tr>
              ))}
              {!result.items.length && (
                <tr>
                  <td colSpan={7}>
                    No purchases found. Create a purchase to record sourced
                    merchandise.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          base="/admin/purchases"
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
