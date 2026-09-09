import Link from "next/link";
import { inventoryQueries, locationQueries } from "@/lib/admin";
import { Pagination } from "@/components/admin/pagination";
import { MediaImage } from "@/components/ui/media-image";
import { formatMoney } from "@/modules/shared/money";
import { catalogSortLabels, pageSizes } from "@/modules/catalog/queries";

export const metadata = { title: "Inventory" };
export default async function Inventory({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = await inventoryQueries.overview(await searchParams);
  const locations = await locationQueries.tree();
  const { items, filters, total, pageCount } = result;
  const { page, size } = filters;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE</p>
          <h1>
            Inventory{" "}
            <span className="heading-count">{total.toLocaleString()}</span>
          </h1>
          <p className="muted">
            Owned stock, physical storage and fulfillment availability.
          </p>
        </div>
        <div className="detail-actions">
          <Link
            href={`/admin/shipments/new${filters.location ? `?origin=${filters.location}` : ""}`}
            className="button"
          >
            Create shipment
          </Link>
          <Link href="/admin/inventory/locations" className="button">
            Storage locations
          </Link>
          <Link href="/admin/inventory/record" className="button primary">
            Receive stock
          </Link>
        </div>
      </div>
      <form method="get" className="panel form-section inventory-filters">
        <label className="field">
          <span>Search merchandise</span>
          <input
            name="q"
            defaultValue={filters.q}
            maxLength={200}
            placeholder="Name, Japanese name, SKU or JAN"
          />
        </label>
        <label className="field">
          <span>Location (direct stock)</span>
          <select name="location" defaultValue={filters.location ?? ""}>
            <option value="">All locations</option>
            {locations.map((row) => (
              <option value={row.id} key={row.id}>
                {row.path}
                {!row.effectiveActive ? " (inactive)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Stock</span>
          <select name="stock" defaultValue={filters.stock}>
            <option value="has">Owned items</option>
            <option value="fulfillable">Fulfillable items</option>
            <option value="none">No stock</option>
            <option value="any">All catalogued items</option>
          </select>
        </label>
        <label className="field">
          <span>Sort</span>
          <select name="sort" defaultValue={filters.sort}>
            {Object.entries(catalogSortLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Items per page</span>
          <select name="size" defaultValue={size}>
            {pageSizes.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Archived merchandise</span>
          <select name="archived" defaultValue={filters.archived}>
            <option value="true">Include archived</option>
            <option value="false">Hide archived</option>
            <option value="only">Only archived</option>
          </select>
        </label>
        {Object.entries(filters)
          .filter(
            ([key, value]) =>
              ![
                "q",
                "location",
                "stock",
                "sort",
                "size",
                "archived",
                "page",
              ].includes(key) &&
              value !== undefined &&
              value !== "any",
          )
          .map(([key, value]) => (
            <input type="hidden" key={key} name={key} value={String(value)} />
          ))}
        <button className="button primary" type="submit">
          Apply
        </button>
        <Link className="button" href="/admin/inventory">
          Reset
        </Link>
      </form>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table read-table inventory-table">
            <thead>
              <tr>
                <th>Merchandise / SKU</th>
                <th>Lineup</th>
                <th className="numeric">Owned</th>
                <th className="numeric">Fulfillable</th>
                <th>Quantity by physical location</th>
                <th>Latest acquisition unit cost</th>
                <th>Estimated value</th>
                <th>SaleListing price</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="inventory-item">
                      <MediaImage
                        reference={item.images[0]?.storageKey}
                        alt={item.name}
                      />
                      <div>
                        <Link
                          className="source-link"
                          href={`/admin/merchandise/catalog/${item.id}`}
                        >
                          {item.name}
                        </Link>
                        {item.japaneseName && (
                          <span className="japanese" lang="ja">
                            {item.japaneseName}
                          </span>
                        )}
                        <span className="japanese code-cell">
                          {item.internalSku}
                        </span>
                        {item.archived && (
                          <span className="badge">Archived</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    <Link href={`/admin/merchandise/lineups/${item.lineup.id}`}>
                      {item.lineup.name}
                    </Link>
                    <span className="japanese">
                      {item.lineup.franchise.name}
                    </span>
                  </td>
                  <td className="numeric count">
                    {item.stock.total.toLocaleString()}
                  </td>
                  <td className="numeric count">
                    {item.stock.fulfillable.toLocaleString()}
                  </td>
                  <td>
                    <ul className="inventory-location-list">
                      {item.stock.locations.map((row) => (
                        <li key={row.locationId}>
                          <Link
                            href={`/admin/inventory?location=${row.locationId}`}
                          >
                            {row.path ?? row.code}
                          </Link>
                          <strong>{row.quantity.toLocaleString()}</strong>
                          <small>
                            {row.fulfillable
                              ? "Fulfillable"
                              : row.effectiveActive === false
                                ? "Inactive hierarchy"
                                : "Not fulfillable"}
                          </small>
                        </li>
                      ))}
                    </ul>
                    {!item.stock.locations.length && (
                      <span className="muted">No stock</span>
                    )}
                  </td>
                  <td>
                    {item.acquisition ? (
                      <>
                        <span className="nowrap">
                          {formatMoney(
                            item.acquisition.amount,
                            item.acquisition.currency,
                          )}{" "}
                          {item.acquisition.currency}
                        </span>
                        <span className="japanese">
                          {item.acquisition.date.toISOString().slice(0, 10)}
                        </span>
                      </>
                    ) : (
                      <span className="muted">Unknown</span>
                    )}
                  </td>
                  <td className="nowrap">
                    {item.estimatedValue ? (
                      `${formatMoney(item.estimatedValue.amount, item.estimatedValue.currency)} ${item.estimatedValue.currency}`
                    ) : (
                      <span className="muted">Unknown</span>
                    )}
                  </td>
                  <td className="nowrap">
                    {item.saleListing ? (
                      `${formatMoney(item.saleListing.sellingPriceAmount, item.saleListing.sellingPriceCurrency)} ${item.saleListing.sellingPriceCurrency}`
                    ) : (
                      <span className="muted">No listing</span>
                    )}
                  </td>
                  <td>
                    <div className="inventory-row-actions">
                      <Link
                        className="button small"
                        href={`/admin/inventory/record?item=${item.id}`}
                      >
                        Receive
                      </Link>
                      <Link
                        className="button small"
                        href={`/admin/inventory/record?item=${item.id}&type=TRANSFER`}
                      >
                        Transfer
                      </Link>
                      <Link
                        className="button small"
                        href={`/admin/inventory/record?item=${item.id}&type=ADJUSTMENT`}
                      >
                        Record change
                      </Link>
                      <Link
                        className="source-link"
                        href={`/admin/merchandise/catalog/${item.id}/movements`}
                      >
                        History
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!items.length && (
          <p className="empty-state">
            No merchandise matches these filters. Use Receive stock to find any
            catalogued item.
          </p>
        )}
        <Pagination
          base="/admin/inventory"
          params={filters}
          page={page}
          pageCount={pageCount}
          total={total}
          size={size}
        />
      </section>
      <p className="table-note">
        Estimated value = total owned units × latest recorded acquisition unit
        cost. This is an estimate, not FIFO, average cost or landed cost.
        Unknown costs remain unknown; currencies are never combined or
        converted. Location filters match stock directly at the selected
        location; each item still shows all its locations and ownership totals.
      </p>
    </>
  );
}
