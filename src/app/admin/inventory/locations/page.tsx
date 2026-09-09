import Link from "next/link";
import { locationQueries } from "@/lib/admin";
import { Pagination } from "@/components/admin/pagination";

export const metadata = { title: "Storage locations" };
export default async function Locations({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const active = typeof params.active === "string" ? params.active : "";
  const needle = q.normalize("NFKC").toLowerCase();
  const tree = await locationQueries.tree();
  const filtered = tree.filter(
    (row) =>
      `${row.path} ${row.code} ${row.name} ${row.notes ?? ""}`
        .normalize("NFKC")
        .toLowerCase()
        .includes(needle) &&
      (active === "yes"
        ? row.effectiveActive
        : active === "no"
          ? !row.effectiveActive
          : true),
  );
  const size = 50,
    total = filtered.length,
    pageCount = Math.max(1, Math.ceil(total / size));
  const page = Math.min(
    pageCount,
    Math.max(1, Math.floor(Number(params.page) || 1)),
  );
  const rows = filtered.slice((page - 1) * size, page * size);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">INVENTORY</p>
          <h1>
            Storage locations{" "}
            <span className="heading-count">{tree.length}</span>
          </h1>
          <p className="muted">
            Physical addresses for every owned unit. Counts belong directly to
            each location.
          </p>
        </div>
        <div className="detail-actions">
          <Link href="/admin/inventory" className="button">
            Inventory
          </Link>
          <Link
            href="/admin/inventory/locations/new"
            className="button primary"
          >
            Create location
          </Link>
        </div>
      </div>
      {params.saved === "1" && (
        <p className="alert" role="status">
          Storage location saved.
        </p>
      )}
      <form className="panel form-section inventory-filters" method="get">
        <label className="field">
          <span>Search locations</span>
          <input name="q" defaultValue={q} placeholder="Code, path or notes" />
        </label>
        <label className="field">
          <span>Active hierarchy</span>
          <select name="active" defaultValue={active}>
            <option value="">All locations</option>
            <option value="yes">Active</option>
            <option value="no">Inactive / inactive ancestor</option>
          </select>
        </label>
        <button className="button primary" type="submit">
          Apply
        </button>
        <Link className="button" href="/admin/inventory/locations">
          Reset
        </Link>
      </form>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table read-table">
            <thead>
              <tr>
                <th>Location / physical path</th>
                <th>Type / parent</th>
                <th>Active</th>
                <th>Fulfillable</th>
                <th className="numeric">Units / items</th>
                <th>Notes</th>
                <th>Manage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link
                      className="source-link"
                      href={`/admin/inventory?location=${row.id}`}
                    >
                      {row.code} · {row.name}
                    </Link>
                    <span className="japanese">{row.path}</span>
                  </td>
                  <td>
                    {row.type.replaceAll("_", " ")}
                    <span className="japanese">
                      Country:{" "}
                      {row.effectiveCountry ??
                        (row.inTransit ? "In transit" : "Unassigned")}
                      {row.countryCode
                        ? " (set here)"
                        : row.effectiveCountry
                          ? " (inherited)"
                          : ""}
                    </span>
                    <span className="japanese">
                      {tree.find((parent) => parent.id === row.parentId)
                        ?.path ?? "Top level"}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${row.effectiveActive ? "catalog-live" : ""}`}
                    >
                      {row.active
                        ? row.effectiveActive
                          ? "Active"
                          : "Ancestor inactive"
                        : "Inactive"}
                    </span>
                  </td>
                  <td>
                    {row.fulfillmentEnabled ? "Enabled" : "Disabled"}
                    <span className="japanese">
                      {row.fulfillable
                        ? "Currently fulfillable"
                        : "Not currently fulfillable"}
                    </span>
                  </td>
                  <td className="numeric">
                    {row.units.toLocaleString()} / {row.items.toLocaleString()}
                  </td>
                  <td className="inventory-note">{row.notes ?? "—"}</td>
                  <td>
                    <Link
                      className="button small"
                      href={`/admin/inventory/locations/${row.id}/edit`}
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <p className="empty-state">No storage locations found.</p>
        )}
        <Pagination
          base="/admin/inventory/locations"
          params={{ q, active }}
          page={page}
          pageCount={pageCount}
          total={total}
          size={size}
        />
      </section>
      <p className="table-note">
        Fulfillment is explicitly enabled per location. Ancestor deactivation or
        transit blocks fulfillment. Use Edit → Active to archive a location
        without deleting stock or movement history.
      </p>
    </>
  );
}
