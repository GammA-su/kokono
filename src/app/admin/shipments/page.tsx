import Link from "next/link";
import { shipmentQueries } from "@/lib/admin";
import { Pagination } from "@/components/admin/pagination";
import {
  shipmentNumber,
  shipmentStatuses,
} from "@/modules/shipments/validation";
export const metadata = { title: "International shipments" };
export default async function Shipments({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = await shipmentQueries.list(await searchParams);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">LOGISTICS</p>
          <h1>
            International shipments{" "}
            <span className="heading-count">{result.total}</span>
          </h1>
          <p className="muted">
            Consolidate Japan inventory, track transit, and place received goods
            in France.
          </p>
        </div>
        <Link className="button primary" href="/admin/shipments/new">
          Create shipment
        </Link>
      </div>
      <form method="get" className="panel form-section field-grid">
        <label className="field">
          <span>Search shipments</span>
          <input
            name="q"
            defaultValue={result.filters.q}
            placeholder="JP-00012, carrier or tracking number"
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
            {shipmentStatuses.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <button type="submit" className="button">
            Filter
          </button>
          <Link href="/admin/shipments" className="button">
            Reset
          </Link>
        </div>
      </form>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Shipment</th>
                <th>Status</th>
                <th>Origin → destination</th>
                <th>Carrier / tracking</th>
                <th>Packages / SKUs</th>
                <th>Shipped</th>
                <th>Arrived</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((shipment) => (
                <tr key={shipment.id}>
                  <td>
                    <Link href={`/admin/shipments/${shipment.id}`}>
                      {shipmentNumber(shipment.number)}
                    </Link>
                  </td>
                  <td>{shipment.status}</td>
                  <td>
                    {shipment.originLocation.code} →{" "}
                    {shipment.destinationLocation.code}
                  </td>
                  <td>
                    {shipment.carrier || "Not recorded"}
                    <div className="muted">{shipment.trackingNumber}</div>
                  </td>
                  <td>
                    {shipment.packageCount} / {shipment._count.items}
                  </td>
                  <td>
                    {shipment.shipmentDate?.toISOString().slice(0, 10) || "—"}
                  </td>
                  <td>
                    {shipment.arrivalDate?.toISOString().slice(0, 10) || "—"}
                  </td>
                </tr>
              ))}
              {!result.items.length && (
                <tr>
                  <td colSpan={7}>No shipments found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          base="/admin/shipments"
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
