import Link from "next/link";
import { Suspense } from "react";
import type { ReactNode } from "react";
import { dashboardQueries } from "@/lib/admin";
import { MediaImage } from "@/components/ui/media-image";
import { StatusBadge } from "@/components/ui/badge";
import { formatPartialDate } from "@/modules/catalog/partial-date";
import type { CatalogCard } from "@/modules/catalog/queries";
import type { ValueTotal } from "@/modules/dashboard/queries";
import { quantityNeeded } from "@/modules/watchlist/filters";
import { formatMoney, formatOptionalMoney } from "@/modules/shared/money";

export const metadata = { title: "Merchandise operations" };
const catalog = "/admin/merchandise/catalog";
function date(value: Date) {
  return value.toLocaleDateString("en-GB", {
    timeZone: "Europe/Paris",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
function Section({
  title,
  href,
  action = "View all",
  children,
  id,
}: {
  title: string;
  href?: string;
  action?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="panel dashboard-section" id={id}>
      <div className="panel-heading">
        <h2>{title}</h2>
        {href && (
          <Link className="source-link" href={href}>
            {action} →
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
function Metrics({
  title,
  note,
  rows,
}: {
  title: string;
  note: string;
  rows: [string, bigint, string?][];
}) {
  return (
    <Section title={title}>
      <dl className="dashboard-metrics">
        {rows.map(([label, value, href]) => (
          <div key={label}>
            <dt>
              {href ? (
                <Link className="source-link" href={href}>
                  {label}
                </Link>
              ) : (
                label
              )}
            </dt>
            <dd>{value.toLocaleString("en-GB")}</dd>
          </div>
        ))}
      </dl>
      <p className="table-note">{note}</p>
    </Section>
  );
}
function Value({
  title,
  rows,
  note,
}: {
  title: string;
  rows: ValueTotal[];
  note: string;
}) {
  const known = rows.filter(
    (row) => row.currency !== null && row.amount !== null,
  );
  const covered = known.reduce((sum, row) => sum + row.units, 0n);
  const total = rows.reduce((sum, row) => sum + row.units, 0n);
  return (
    <div className="dashboard-value">
      <h3>{title}</h3>
      {known.length ? (
        known.map((row) => (
          <strong key={row.currency}>
            {formatMoney(row.amount!, row.currency!)}{" "}
            <small>{row.currency}</small>
          </strong>
        ))
      ) : (
        <strong className="muted">No recorded value</strong>
      )}
      <p>
        {covered.toLocaleString()} / {total.toLocaleString()} units covered
        {covered < total
          ? " · Incomplete coverage"
          : total
            ? " · Complete cost/price coverage"
            : " · No units to value"}
      </p>
      <p className="muted">{note}</p>
    </div>
  );
}
function ItemName({ item }: { item: CatalogCard }) {
  return (
    <div className="dashboard-item">
      <MediaImage reference={item.images[0]?.storageKey} alt={item.name} />
      <div>
        <Link className="source-link" href={`${catalog}/${item.id}`}>
          {item.name}
        </Link>
        {item.japaneseName && (
          <span className="japanese">{item.japaneseName}</span>
        )}
        <span className="muted japanese">
          {item.lineup.franchise.name} · {item.lineup.name}
          {item.archived ? " · Archived" : ""}
        </span>
      </div>
    </div>
  );
}
function WatchQueue({
  title,
  items,
  href,
}: {
  title: string;
  items: CatalogCard[];
  href: string;
}) {
  return (
    <Section title={title} href={href}>
      <ul className="dashboard-queue">
        {items.map((item) => {
          const watch = item.purchaseWatch!;
          const gap = quantityNeeded(watch.targetQuantity, item.stock.total);
          return (
            <li key={item.id}>
              <ItemName item={item} />
              <div className="dashboard-queue-meta">
                <span className="badge">{watch.priority}</span>
                <span>
                  {gap === null ? "No target set" : `${gap} still wanted`} ·{" "}
                  {item.stock.total} owned
                </span>
                <span className="muted">
                  {watch.lastCheckedAt
                    ? `Checked ${date(watch.lastCheckedAt)}`
                    : "Never checked"}
                </span>
                <Link
                  className="source-link"
                  href={`/admin/watchlist/${item.id}`}
                >
                  Review watch →
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
      {!items.length && (
        <p className="empty-state">No watches need attention in this queue.</p>
      )}
    </Section>
  );
}
/**
 * Whole-ledger valuation. It is deliberately outside the operational request: these three
 * aggregates scan the full movement ledger and catalog, and measured ~2.3 s at 50k items.
 * The figures are computed live when this component resolves, so they are current as of their
 * own timestamp rather than a cached summary; that timestamp is shown because it can be a
 * moment later than the operational panels above.
 */
async function Valuation() {
  const data = await dashboardQueries.valuation();
  return (
    <Section
      title="Inventory and acquisition value"
      href="/admin/inventory"
      action="Inspect costs"
    >
      <p className="table-note">
        Full-ledger valuation, loaded after the operational panels. Computed{" "}
        {data.asOf.toLocaleTimeString("en-GB", {
          timeZone: "Europe/Paris",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}{" "}
        Paris time.
      </p>
      <div className="dashboard-value-grid">
        <Value
          title="Known acquisition value"
          rows={data.acquisition}
          note="Recorded incoming movement costs × received units, excluding transfers. Lifetime receipts, including units since removed; this is not current stock value."
        />
        <Value
          title="Estimated acquisition value on hand"
          rows={data.inventoryValue}
          note="Current owned units × latest recorded acquisition cost per SKU. An estimate, without lot costing; later uncosted receipts use the last known cost."
        />
        <div className="dashboard-value">
          <h3>Estimated landed inventory value</h3>
          <strong className="muted">Unavailable</strong>
          <p>
            Shipment cost calculations are available, but remaining stock is not
            allocated to acquisition lots for an on-hand valuation.
          </p>
          <p className="muted">
            Acquisition costs alone do not establish landed value.
          </p>
        </div>
        <Value
          title="Potential retail value"
          rows={data.retail}
          note="Unreserved eligible France units × current visible selling price. Stock without a visible listing is shown as uncovered. No projected profit or currency conversion."
        />
      </div>
    </Section>
  );
}
function ValuationPending() {
  return (
    <Section title="Inventory and acquisition value">
      <p className="table-note">Calculating full-ledger valuation…</p>
    </Section>
  );
}
export default async function AdminPage() {
  const data = await dashboardQueries.overview();
  const m = data.metrics;
  return (
    <div className="dashboard">
      <div className="page-heading">
        <div>
          <p className="eyebrow">MERCHANDISE OPERATIONS</p>
          <h1>Store operations</h1>
          <p className="muted">
            Stock, sourcing and catalog work at a glance. Updated{" "}
            {date(data.asOf)} at{" "}
            {data.asOf.toLocaleTimeString("en-GB", {
              timeZone: "Europe/Paris",
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            Paris time.
          </p>
        </div>
        <div className="dashboard-actions">
          <Link className="button" href="/admin/merchandise/lineups/new">
            Create lineup
          </Link>
          <Link className="button primary" href="/admin/inventory/record">
            Receive stock
          </Link>
        </div>
      </div>
      <div className="dashboard-grid dashboard-metric-grid">
        <Metrics
          title="Catalog"
          note="All known records, including archived merchandise."
          rows={[
            ["Total franchises", m.franchises, "/admin/merchandise/franchises"],
            [
              "Total lineups",
              m.lineups,
              "/admin/merchandise/lineups?archived=true",
            ],
            ["Total known merchandise", m.items, `${catalog}?archived=true`],
            ["Added in the last 30 days", m.recent, "#recent-merchandise"],
          ]}
        />
        <Metrics
          title="Sourcing"
          note="Enabled watches, including archived merchandise. Overdue means never checked or 30+ days ago."
          rows={[
            ["Watched items", m.watched, "/admin/watchlist"],
            ["High-priority watches", m.high, "/admin/watchlist?priority=HIGH"],
            ["Urgent watches", m.urgent, "/admin/watchlist?priority=URGENT"],
            [
              "Below target quantity",
              m.below,
              "/admin/watchlist?below=yes&sort=gap",
            ],
            [
              "Not checked recently",
              m.unchecked,
              "/admin/watchlist?checked=30&sort=checked",
            ],
          ]}
        />
        <Metrics
          title="Inventory"
          note="All owned stock, including inactive storage. Country inherits from parents; transit is counted separately."
          rows={[
            ["Total owned units", m.owned, "/admin/inventory"],
            [
              "Total fulfillable units",
              m.fulfillable,
              "/admin/inventory?stock=fulfillable",
            ],
            ["Units in Japan", data.geography.japan, "#logistics"],
            ["Units in transit", data.geography.transit, "#logistics"],
            ["Units in France", data.geography.france, "#logistics"],
            ["Stocked SKUs", m.stocked, "/admin/inventory"],
          ]}
        />
        <Metrics
          title="Store listings"
          note="Published counts use storefront visibility rules. Out-of-stock counts subtract reservations from eligible France stock. Drafts are saved unpublished listings."
          rows={[
            ["Published products", m.published, `${catalog}?listing=published`],
            [
              "Draft listings",
              m.drafts,
              `${catalog}?listing=unpublished&archived=true`,
            ],
            ["Out-of-stock published", m.outOfStock, "#low-stock"],
            ["Featured products", m.featured, `${catalog}?listing=published`],
          ]}
        />
      </div>
      <Suspense fallback={<ValuationPending />}>
        <Valuation />
      </Suspense>
      <div className="dashboard-grid dashboard-attention">
        <WatchQueue
          title="High-priority sourcing"
          items={data.priority}
          href="/admin/watchlist?sort=priority"
        />
        <WatchQueue
          title="Largest quantity gaps"
          items={data.gaps}
          href="/admin/watchlist?below=yes&sort=gap"
        />
        <WatchQueue
          title="Overdue sourcing checks"
          items={data.unchecked}
          href="/admin/watchlist?checked=30&sort=checked"
        />
      </div>
      <Section
        title="Low storefront availability"
        href={`${catalog}?listing=published`}
        action="Published catalog"
        id="low-stock"
      >
        <p className="table-note">
          Visible products with 0–{data.policy.lowStockUnits} unreserved France
          units, lowest first. Zero-stock listings remain published.
        </p>
        <div className="table-scroll">
          <table className="data-table read-table">
            <thead>
              <tr>
                <th>Merchandise</th>
                <th className="numeric">Owned</th>
                <th className="numeric">Available to sell</th>
                <th>Price</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.lowStock.map((item) => (
                <tr key={item.id}>
                  <td>
                    <ItemName item={item} />
                  </td>
                  <td className="numeric">{item.stock.total}</td>
                  <td className="numeric">
                    {item.availableQuantity || (
                      <span className="badge">Out of stock</span>
                    )}
                  </td>
                  <td>
                    {formatOptionalMoney(
                      item.saleListing!.sellingPriceAmount,
                      item.saleListing!.sellingPriceCurrency,
                    )}
                  </td>
                  <td>
                    <Link
                      className="source-link"
                      href={`/admin/inventory/record?item=${item.id}`}
                    >
                      Receive stock
                    </Link>
                    <br />
                    <Link
                      className="source-link"
                      href={`${catalog}/${item.id}`}
                    >
                      Inspect locations →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.lowStock.length && (
          <p className="empty-state">
            No published products are below the stock threshold.
          </p>
        )}
      </Section>
      <div className="dashboard-grid dashboard-two">
        <Section
          title="Latest releases"
          href="/admin/merchandise/lineups?sort=newest"
        >
          <p className="table-note">
            Active lineups ordered by release date, newest first; unknown dates
            last.
          </p>
          <div className="table-scroll">
            <table className="data-table dashboard-release-table">
              <thead>
                <tr>
                  <th>Lineup / franchise</th>
                  <th>Release</th>
                  <th>Status</th>
                  <th>Items</th>
                </tr>
              </thead>
              <tbody>
                {data.latestLineups.map((lineup) => (
                  <tr key={lineup.id}>
                    <td>
                      <Link
                        className="source-link"
                        href={`/admin/merchandise/lineups/${lineup.id}`}
                      >
                        {lineup.name}
                      </Link>
                      <span className="japanese">{lineup.japaneseName}</span>
                      <span className="muted japanese">
                        {lineup.franchise.name}
                      </span>
                    </td>
                    <td>
                      {formatPartialDate(
                        lineup.releaseDate,
                        lineup.releaseDatePrecision,
                      ) ?? "Not announced"}
                    </td>
                    <td>
                      <StatusBadge status={lineup.status} />
                    </td>
                    <td>{lineup._count.items}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.latestLineups.length && (
            <p className="empty-state">
              Create a lineup to begin cataloguing releases.
            </p>
          )}
        </Section>
        <Section
          title="Recently added merchandise"
          href={`${catalog}?sort=added&archived=true`}
          id="recent-merchandise"
        >
          <p className="table-note">
            Latest five records added in the last 30 days.
          </p>
          <ul className="dashboard-queue">
            {data.recentlyAdded.map((item) => (
              <li key={item.id}>
                <ItemName item={item} />
                <span className="muted">Added {date(item.createdAt)}</span>
              </li>
            ))}
          </ul>
          {!data.recentlyAdded.length && (
            <p className="empty-state">
              No merchandise added in the last 30 days.
            </p>
          )}
        </Section>
      </div>
      <Section
        title="Recent inventory activity"
        href="/admin/inventory"
        action="Inventory"
      >
        <p className="table-note">
          Latest 10 movements across all items. Transfers move units without
          changing ownership; other quantities are signed changes. Times shown
          in Paris time.
        </p>
        <div className="table-scroll">
          <table className="data-table read-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Item / movement</th>
                <th className="numeric">Units</th>
                <th>Source → destination</th>
                <th>Actor</th>
                <th>Acquisition unit cost</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {data.activity.map((row) => (
                <tr key={row.id}>
                  <td>
                    {date(row.createdAt)}
                    <span className="japanese muted">
                      {row.createdAt.toLocaleTimeString("en-GB", {
                        timeZone: "Europe/Paris",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </td>
                  <td>
                    <Link
                      className="source-link"
                      href={`${catalog}/${row.merchandiseItem.id}/movements`}
                    >
                      {row.merchandiseItem.name}
                    </Link>
                    <span className="japanese">{row.movementType}</span>
                  </td>
                  <td className="numeric">
                    {row.movementType === "TRANSFER"
                      ? `${row.quantityDelta} moved`
                      : `${row.quantityDelta > 0 ? "+" : ""}${row.quantityDelta}`}
                  </td>
                  <td>
                    {row.sourcePath ?? "Outside inventory"} →{" "}
                    {row.destinationPath ?? "Outside inventory"}
                  </td>
                  <td>{row.actorUser?.name ?? "Not recorded"}</td>
                  <td>
                    {formatOptionalMoney(
                      row.acquisitionUnitCostAmount,
                      row.acquisitionUnitCostCurrency,
                    ) ?? "Not recorded"}
                  </td>
                  <td>{row.referenceId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.activity.length && (
          <p className="empty-state">
            No inventory movements yet. Receive stock to begin the ledger.
          </p>
        )}
      </Section>
      <div className="dashboard-grid dashboard-attention">
        <Section
          title="Physical logistics"
          href="/admin/inventory/locations"
          action="Manage locations"
          id="logistics"
        >
          <p className="table-note">
            Configured root locations including all shelves and boxes below
            them. Each unit is counted once.
          </p>
          <dl className="dashboard-metrics">
            {data.logistics.map((location) => (
              <div key={location.id}>
                <dt>
                  <Link
                    className="source-link"
                    href={`/admin/inventory/locations/${location.id}/edit`}
                  >
                    {location.name}
                  </Link>
                  <span className="muted japanese">
                    {location.code}
                    {!location.active ? " · Inactive" : ""}
                  </span>
                </dt>
                <dd>
                  {location.units.toLocaleString()} <small>units</small>
                </dd>
              </div>
            ))}
          </dl>
          {!data.logistics.length && (
            <p className="empty-state">
              Configure storage locations to track physical stock.
            </p>
          )}
          {data.geography.other > 0n && (
            <p className="table-note">
              {data.geography.other.toLocaleString()} units are in other
              countries or locations without a country.
            </p>
          )}
        </Section>
        <Section
          title="Lineups by year"
          href="/admin/merchandise/lineups?archived=true"
        >
          <p className="table-note">
            All lineups, including archived releases. Year and month precision
            are retained.
          </p>
          <dl className="dashboard-metrics">
            {data.years.map((row) => (
              <div key={row.year ?? "unknown"}>
                <dt>
                  {row.year ? (
                    <Link
                      className="source-link"
                      href={`/admin/merchandise/lineups?year=${row.year}&archived=true`}
                    >
                      {row.year}
                    </Link>
                  ) : (
                    "Release unknown"
                  )}
                </dt>
                <dd>{row.count.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
          {!data.years.length && <p className="empty-state">No lineups yet.</p>}
        </Section>
        <Section title="Franchise summary" href="/admin/merchandise/franchises">
          <p className="table-note">
            Top 10 by catalog size, including archived records. Owned counts
            distinct SKUs; units counts physical copies.
          </p>
          <ul className="dashboard-queue">
            {data.franchises.map((row) => (
              <li key={row.id}>
                <Link
                  className="source-link"
                  href={`${catalog}?franchise=${row.id}&archived=true`}
                >
                  {row.name}
                </Link>
                <p>
                  {row.items.toLocaleString()} catalog items /{" "}
                  {row.ownedSkus.toLocaleString()} owned SKUs
                  <span className="muted japanese">
                    {row.units.toLocaleString()} physical units
                  </span>
                </p>
              </li>
            ))}
          </ul>
          {!data.franchises.length && (
            <p className="empty-state">No franchises yet.</p>
          )}
        </Section>
      </div>
    </div>
  );
}
