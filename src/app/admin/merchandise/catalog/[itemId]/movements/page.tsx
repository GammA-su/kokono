import Link from "next/link";
import { notFound } from "next/navigation";
import { catalogQueries } from "@/lib/admin";
import { formatOptionalMoney } from "@/modules/shared/money";
import { Pagination } from "@/components/admin/pagination";
import { MovementType } from "@/generated/prisma/enums";

export const metadata = { title: "Movement history" };
export default async function MovementHistory({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { itemId } = await params;
  const history = await catalogQueries.movements(itemId, await searchParams);
  if (!history) notFound();
  const { item, rows, total, page, pageCount, size, filters, locations } =
    history;
  const base = `/admin/merchandise/catalog/${item.id}/movements`;
  return (
    <>
      <div className="breadcrumb">
        <Link href="/admin/inventory">Inventory</Link>
        <span>/</span>
        <Link href={`/admin/merchandise/catalog/${item.id}`}>{item.name}</Link>
        <span>/</span>Movements
      </div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">INVENTORY</p>
          <h1>
            Movement history{" "}
            <span className="heading-count">{total.toLocaleString()}</span>
          </h1>
          <p className="muted">
            Append-only ledger for {item.name}. Corrections are recorded as
            compensating movements.
          </p>
        </div>
        <Link
          className="button primary"
          href={`/admin/inventory/record?item=${item.id}&type=ADJUSTMENT`}
        >
          Record movement
        </Link>
      </div>
      <form className="panel form-section inventory-filters" method="get">
        <label className="field">
          <span>Movement type</span>
          <select name="type" defaultValue={filters.type ?? ""}>
            <option value="">All movements</option>
            {Object.values(MovementType).map((type) => (
              <option value={type} key={type}>
                {type.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Source or destination</span>
          <select name="location" defaultValue={filters.location ?? ""}>
            <option value="">All locations</option>
            {locations.map((row) => (
              <option key={row.id} value={row.id}>
                {row.path}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>From date (UTC)</span>
          <input type="date" name="from" defaultValue={filters.from} />
        </label>
        <label className="field">
          <span>Through date (UTC)</span>
          <input type="date" name="to" defaultValue={filters.to} />
        </label>
        <label className="field">
          <span>Rows per page</span>
          <select name="size" defaultValue={size}>
            {[25, 50, 100].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button className="button primary">Apply</button>
        <Link className="button" href={base}>
          Reset
        </Link>
      </form>
      {filters.from && filters.to && filters.from > filters.to && (
        <p className="alert error" role="alert">
          From date must not be after the through date.
        </p>
      )}
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table read-table">
            <thead>
              <tr>
                <th>Date (UTC)</th>
                <th>Movement</th>
                <th className="numeric">Quantity</th>
                <th>Source</th>
                <th>Destination</th>
                <th>Actor</th>
                <th>Acquisition unit cost</th>
                <th>Reference</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((movement) => (
                <tr key={movement.id} id={movement.id}>
                  <td className="nowrap">
                    {movement.createdAt
                      .toISOString()
                      .slice(0, 19)
                      .replace("T", " ")}
                  </td>
                  <td>{movement.movementType}</td>
                  <td className="numeric count">
                    {movement.movementType === "TRANSFER"
                      ? `${movement.quantityDelta.toLocaleString()} moved`
                      : `${movement.quantityDelta > 0 ? "+" : ""}${movement.quantityDelta.toLocaleString()}`}
                  </td>
                  <td>
                    {movement.sourceLocation ? (
                      <Link
                        href={`/admin/inventory/locations/${movement.sourceLocation.id}/edit`}
                      >
                        {movement.sourcePath}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {movement.destinationLocation ? (
                      <Link
                        href={`/admin/inventory/locations/${movement.destinationLocation.id}/edit`}
                      >
                        {movement.destinationPath}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {movement.actorUser?.name ?? (
                      <span className="muted">System</span>
                    )}
                    {movement.actorUser && (
                      <span className="japanese">
                        {movement.actorUser.email}
                      </span>
                    )}
                  </td>
                  <td className="nowrap">
                    {formatOptionalMoney(
                      movement.acquisitionUnitCostAmount,
                      movement.acquisitionUnitCostCurrency,
                    ) ?? "—"}
                    {movement.acquisitionUnitCostCurrency &&
                      ` ${movement.acquisitionUnitCostCurrency}`}
                  </td>
                  <td>
                    {movement.referenceType
                      ? `${movement.referenceType} · ${movement.referenceId}`
                      : "—"}
                  </td>
                  <td className="inventory-note">
                    {movement.notes ?? "—"}
                    <details>
                      <summary>Operation key</summary>
                      <code>{movement.operationKey}</code>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <p className="empty-state">
            No inventory movements match these filters.
          </p>
        )}
        <Pagination
          base={base}
          params={filters}
          page={page}
          pageCount={pageCount}
          total={total}
          size={size}
        />
      </section>
      <p className="table-note">
        A transfer is one movement between locations and does not change total
        ownership. Dates use UTC and include the entire through date. Physical
        paths reflect the current location hierarchy; movement identities and
        amounts remain immutable.
      </p>
    </>
  );
}
