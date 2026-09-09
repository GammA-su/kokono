import Link from "next/link";
import { lineupQueries } from "@/lib/admin";
import { formatPartialDate } from "@/modules/catalog/partial-date";
import { Icon } from "@/components/ui/icon";
import { MediaImage } from "@/components/ui/media-image";
import { StatusBadge, statusLabels } from "@/components/ui/badge";
import { Pagination } from "@/components/admin/pagination";

export const metadata = { title: "Lineups" };
export default async function Lineups({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [result, facets] = await Promise.all([
    lineupQueries.list(params),
    lineupQueries.facets(),
  ]);
  const { filters, rows, total, pageCount } = result;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE</p>
          <h1>
            Lineups{" "}
            <span className="heading-count">{total.toLocaleString()}</span>
          </h1>
          <p className="muted">Every release. One organized collection.</p>
        </div>
        <Link className="button primary" href="/admin/merchandise/lineups/new">
          <Icon name="plus" />
          Create lineup
        </Link>
        <Link className="button" href="/admin/merchandise/import-source">Import from official page</Link>
      </div>
      {params.notice === "deleted" && (
        <p className="alert success" role="status">
          Lineup deleted.
        </p>
      )}
      {params.notice === "archived" && (
        <p className="alert success" role="status">
          Lineup archived. Its merchandise and inventory history have been
          retained.
        </p>
      )}
      <section className="panel">
        <form
          className="filter-form"
          action="/admin/merchandise/lineups"
          key={JSON.stringify(filters)}
        >
          <div className="filter-top">
            <label className="search-field">
              <Icon name="search" />
              <span className="sr-only">Search lineups</span>
              <input
                name="q"
                defaultValue={filters.q}
                placeholder="Search lineups, franchises, manufacturers…"
                maxLength={200}
              />
            </label>
            <label className="sort-field">
              <span>Sort by</span>
              <select name="sort" defaultValue={filters.sort}>
                <option value="newest">Newest release</option>
                <option value="oldest">Oldest release</option>
                <option value="added">Recently added</option>
                <option value="alphabetical">Alphabetically</option>
              </select>
            </label>
          </div>
          <div className="filter-bottom">
            <label>
              <span className="sr-only">Franchise</span>
              <select name="franchise" defaultValue={filters.franchise ?? ""}>
                <option value="">All franchises</option>
                {facets.franchises.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Status</span>
              <select name="status" defaultValue={filters.status ?? ""}>
                <option value="">All statuses</option>
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Release year</span>
              <select name="year" defaultValue={filters.year ?? ""}>
                <option value="">All years</option>
                {facets.years.map((year) => (
                  <option key={year}>{year}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Manufacturer</span>
              <select
                name="manufacturer"
                defaultValue={filters.manufacturer ?? ""}
              >
                <option value="">All manufacturers</option>
                {facets.manufacturers.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Rows per page</span>
              <select name="size" defaultValue={filters.size}>
                {[25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n} per page
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="archived"
                value="true"
                defaultChecked={filters.archived === "true"}
              />
              Include archived
            </label>
            <button className="button small">Apply</button>
            <Link href="/admin/merchandise/lineups" className="text-button">
              Reset
            </Link>
          </div>
        </form>
        <div className="table-scroll">
          <table className="data-table lineups-table">
            <thead>
              <tr>
                <th>Lineup</th>
                <th>Franchise</th>
                <th>Manufacturer</th>
                <th>Release</th>
                <th>Status</th>
                <th className="numeric" title="Distinct catalog item designs">
                  Catalogued
                </th>
                <th
                  className="numeric"
                  title="Distinct item designs with positive stock, not physical units"
                >
                  Owned items
                </th>
                <th
                  className="numeric"
                  title="Items visible on the public storefront"
                >
                  Published
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((lineup) => (
                <tr key={lineup.id}>
                  <td>
                    <Link
                      className="lineup-cell"
                      href={`/admin/merchandise/lineups/${lineup.id}`}
                    >
                      <MediaImage
                        reference={lineup.mainImageStorageKey}
                        alt={lineup.name}
                      />
                      <span>
                        <strong>{lineup.name}</strong>
                        {lineup.japaneseName && (
                          <span className="japanese" lang="ja">
                            {lineup.japaneseName}
                          </span>
                        )}
                        {lineup.archivedAt && (
                          <span className="badge">Archived</span>
                        )}
                      </span>
                    </Link>
                  </td>
                  <td className="franchise-cell">{lineup.franchise.name}</td>
                  <td>
                    {lineup.manufacturer ?? <span className="muted">—</span>}
                  </td>
                  <td className="nowrap">
                    {formatPartialDate(
                      lineup.releaseDate,
                      lineup.releaseDatePrecision,
                    ) ?? <span className="muted">Not announced</span>}
                  </td>
                  <td>
                    <StatusBadge status={lineup.status} />
                  </td>
                  <td className="numeric count">{lineup.counts.catalogued}</td>
                  <td className="numeric count">{lineup.counts.owned}</td>
                  <td className="numeric">
                    <span
                      className={
                        lineup.counts.published ? "published-count" : "muted"
                      }
                    >
                      {lineup.counts.published}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <div className="empty-state">
            <Icon name="layers" size={32} />
            <h2>
              {filters.q ||
              filters.franchise ||
              filters.status ||
              filters.year ||
              filters.manufacturer
                ? "No matching lineups"
                : "Your releases start here"}
            </h2>
            <p className="muted">
              Create a lineup to organize a release, collection, or
              collaboration.
            </p>
            <Link className="button" href="/admin/merchandise/lineups/new">
              Create lineup
            </Link>
          </div>
        )}
        <Pagination
          base="/admin/merchandise/lineups"
          params={filters}
          page={filters.page}
          pageCount={pageCount}
          total={total}
          size={filters.size}
        />
      </section>
      <p className="table-note">
        Owned items counts distinct designs with stock. Open a lineup to see
        units across all storage locations.
      </p>
    </>
  );
}
