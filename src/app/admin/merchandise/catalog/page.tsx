import Link from "next/link";
import { catalogQueries } from "@/lib/admin";
import { Icon } from "@/components/ui/icon";
import { CatalogFilterForm } from "@/components/admin/catalog-filters";
import { CatalogGrid } from "@/components/admin/catalog-grid";
import { Pagination, pageHref } from "@/components/admin/pagination";
import { BulkSelection } from "@/components/admin/bulk-selection";

export const metadata = { title: "Catalog" };
export default async function Catalog({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [result, facets] = await Promise.all([
    catalogQueries.list(params),
    catalogQueries.facets(params),
  ]);
  const { filters, items, total, pageCount } = result;
  const filtered =
    Boolean(filters.q) ||
    Object.entries(filters).some(
      ([key, value]) =>
        !["q", "sort", "page", "size", "archived"].includes(key) &&
        value !== undefined &&
        value !== "any",
    ) ||
    filters.archived !== "false";
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE</p>
          <h1>
            Catalog{" "}
            <span className="heading-count">{total.toLocaleString()}</span>
          </h1>
          <p className="muted">
            Every known merchandise design, whether or not it is owned, watched
            or published.
          </p>
        </div>
        <div className="detail-actions">
          <a
            className="button"
            href={pageHref("/api/admin/catalog/csv", filters, 1)}
          >
            Export filtered catalog CSV
          </a>
          <Link className="button" href="/admin/merchandise/lineups">
            Add items through a lineup
          </Link>
        </div>
      </div>
      <section className="panel">
        <CatalogFilterForm filters={filters} facets={facets} />
        <BulkSelection
          key={JSON.stringify({ ...filters, page: undefined, size: undefined })}
          visibleIds={items.map((item) => item.id)}
          filters={filters}
        >
          <CatalogGrid items={items} />
          {!items.length && (
            <div className="empty-state">
              <Icon name="tag" size={30} />
              <h2>
                {filtered ? "No matching merchandise" : "The catalog is empty"}
              </h2>
              <p className="muted">
                {filtered
                  ? "Adjust or reset the filters to widen the search."
                  : "Merchandise is catalogued through its lineup, one release at a time."}
              </p>
              <Link className="button" href="/admin/merchandise/lineups">
                Open lineups
              </Link>
            </div>
          )}
          <Pagination
            base="/admin/merchandise/catalog"
            params={filters}
            page={filters.page}
            pageCount={pageCount}
            total={total}
            size={filters.size}
          />
        </BulkSelection>
      </section>
      <p className="table-note">
        Owned totals include units in transit and at inactive locations.
        Fulfillable counts only locations explicitly enabled for fulfillment.
        MSRP is the official catalog price, never a purchase or selling price,
        and is never converted between currencies.
      </p>
    </>
  );
}
