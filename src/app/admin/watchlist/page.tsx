import Link from "next/link";
import { catalogQueries, watchlistQueries } from "@/lib/admin";
import { MediaImage } from "@/components/ui/media-image";
import { Pagination } from "@/components/admin/pagination";
import {
  WatchInlineEditor,
  WatchQuickActions,
} from "@/components/admin/watch-controls";
import { formatOptionalMoney } from "@/modules/shared/money";
import { formatPartialDate } from "@/modules/catalog/partial-date";
import { sourcingSortLabels } from "@/modules/watchlist/filters";
import {
  marketplaceSearchLinks,
  sourcingQuery,
} from "@/modules/watchlist/marketplaces";

export const metadata = { title: "Purchase watchlist" };
function Choice({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value?: string | number;
  options: [string, string][];
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} aria-label={label} defaultValue={value ?? ""}>
        {options.map(([key, text]) => (
          <option value={key} key={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
export default async function Watchlist({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const result = await watchlistQueries.list(await searchParams);
  const { filters, items, total, pageCount } = result;
  const facets = await catalogQueries.facets(filters);
  const options = (
    rows: { id: string; name: string }[],
  ): [string, string][] => [
    ["", "All"],
    ...rows.map((row) => [row.id, row.name] as [string, string]),
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PRIVATE SOURCING</p>
          <h1>
            Purchase watchlist{" "}
            <span className="heading-count">{total.toLocaleString()}</span>
          </h1>
          <p className="muted">
            Plan what to buy, review marketplaces, and receive purchases into
            inventory.
          </p>
        </div>
        <Link className="button" href="/admin/merchandise/catalog">
          Find items in catalog
        </Link>
      </div>
      <form
        method="get"
        className="panel form-section inventory-filters watch-filters"
      >
        <label className="field">
          <span>Search merchandise</span>
          <input
            name="q"
            defaultValue={filters.q}
            maxLength={200}
            placeholder="English, Japanese, SKU or JAN"
          />
        </label>
        <Choice
          name="franchise"
          label="Franchise"
          value={filters.franchise}
          options={options(facets.franchises)}
        />
        <Choice
          name="lineup"
          label="Lineup"
          value={filters.lineup}
          options={options(facets.lineups)}
        />
        <Choice
          name="character"
          label="Character"
          value={filters.character}
          options={options(facets.characters)}
        />
        <Choice
          name="category"
          label="Category"
          value={filters.category}
          options={options(facets.categories)}
        />
        <Choice
          name="priority"
          label="Priority filter"
          value={filters.priority}
          options={[
            ["", "All priorities"],
            ...["URGENT", "HIGH", "NORMAL", "LOW"].map(
              (value) => [value, value] as [string, string],
            ),
          ]}
        />
        <Choice
          name="year"
          label="Release year"
          value={filters.year}
          options={[
            ["", "All years"],
            ...facets.years.map(
              (year) => [String(year), String(year)] as [string, string],
            ),
          ]}
        />
        <Choice
          name="stock"
          label="Owned stock"
          value={filters.stock}
          options={[
            ["any", "Any stock"],
            ["none", "No stock"],
            ["has", "Has stock"],
            ["fulfillable", "Has fulfillable stock"],
          ]}
        />
        <Choice
          name="below"
          label="Quantity gap"
          value={filters.below}
          options={[
            ["any", "All targets"],
            ["yes", "Below target"],
          ]}
        />
        <Choice
          name="country"
          label="Physical country stock"
          value={filters.country}
          options={[
            ["", "Any country"],
            ["JP", "Japan stock"],
            ["FR", "France stock"],
          ]}
        />
        <Choice
          name="checked"
          label="Last checked age"
          value={filters.checked}
          options={[
            ["any", "Any time"],
            ["never", "Never checked"],
            ["7", "7+ days / never"],
            ["30", "30+ days / never"],
            ["90", "90+ days / never"],
          ]}
        />
        <Choice
          name="sort"
          label="Sort"
          value={filters.sort}
          options={Object.entries(sourcingSortLabels)}
        />
        <Choice
          name="size"
          label="Items per page"
          value={filters.size}
          options={[24, 48, 96].map((value) => [String(value), String(value)])}
        />
        <Choice
          name="archived"
          label="Archived merchandise"
          value={filters.archived}
          options={[
            ["true", "Include archived"],
            ["false", "Hide archived"],
            ["only", "Only archived"],
          ]}
        />
        <button className="button primary" type="submit">
          Apply
        </button>
        <Link className="button" href="/admin/watchlist">
          Reset
        </Link>
      </form>
      <section className="panel">
        <div className="table-scroll">
          <table className="data-table read-table watch-table">
            <thead>
              <tr>
                <th>Merchandise / characters</th>
                <th>Franchise / lineup / release</th>
                <th>Official MSRP</th>
                <th>Target / still wanted</th>
                <th>Owned stock</th>
                <th>Maximum unit price</th>
                <th>Priority / last checked</th>
                <th>Condition / marketplace searches</th>
                <th>Manage sourcing</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const watch = item.purchaseWatch!;
                const query = sourcingQuery(item);
                return (
                  <tr key={item.id} data-item-id={item.id}>
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
                            <span lang="ja" className="japanese">
                              {item.japaneseName}
                            </span>
                          )}
                          <span className="japanese">
                            {item.characters
                              .map((character) => character.name)
                              .join(" · ") || "No characters recorded"}
                          </span>
                          {item.archived && (
                            <span className="badge">Archived</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      {item.lineup.franchise.name}
                      <span className="japanese">
                        <Link
                          href={`/admin/merchandise/lineups/${item.lineup.id}`}
                        >
                          {item.lineup.name}
                        </Link>
                      </span>
                      <span className="japanese">
                        {formatPartialDate(
                          item.release.date,
                          item.release.precision,
                        ) ?? "Release unknown"}
                      </span>
                    </td>
                    <td>
                      {formatOptionalMoney(
                        item.officialMsrpAmount,
                        item.officialMsrpCurrency,
                      ) ?? "Unknown"}
                      <span className="japanese">
                        {item.officialMsrpCurrency}
                      </span>
                    </td>
                    <td>
                      <span>Target: {watch.targetQuantity ?? "Not set"}</span>
                      <span
                        className={`watch-gap ${item.quantityNeeded ? "wanted" : ""}`}
                      >
                        Still wanted:{" "}
                        <strong>{item.quantityNeeded ?? "Not set"}</strong>
                      </span>
                    </td>
                    <td>
                      <dl className="watch-stock">
                        <div>
                          <dt>Total</dt>
                          <dd>{item.stock.total}</dd>
                        </div>
                        <div>
                          <dt>Japan</dt>
                          <dd>{item.japanOwned}</dd>
                        </div>
                        <div>
                          <dt>France</dt>
                          <dd>{item.franceOwned}</dd>
                        </div>
                        <div>
                          <dt>Fulfillable</dt>
                          <dd>{item.stock.fulfillable}</dd>
                        </div>
                      </dl>
                      <Link
                        className="source-link"
                        href={`/admin/merchandise/catalog/${item.id}`}
                      >
                        Physical locations
                      </Link>
                    </td>
                    <td>
                      {formatOptionalMoney(
                        watch.maxUnitPriceAmount,
                        watch.maxUnitPriceCurrency,
                      ) ?? "Not set"}
                      <span className="japanese">
                        {watch.maxUnitPriceCurrency}
                      </span>
                    </td>
                    <td>
                      <Link
                        className="button small"
                        href={`/admin/marketplace-listings/new?item=${item.id}`}
                      >
                        Add marketplace candidate
                      </Link>
                      <WatchQuickActions
                        itemId={item.id}
                        priority={watch.priority}
                      />
                      <span className="japanese">
                        Last checked:{" "}
                        {watch.lastCheckedAt
                          ? `${watch.lastCheckedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`
                          : "Never"}
                      </span>
                    </td>
                    <td>
                      <p className="watch-condition">
                        {watch.conditionPreference || "Any condition"}
                      </p>
                      <p className="watch-query" lang="ja">
                        {query}
                      </p>
                      <div className="watch-search-links">
                        {marketplaceSearchLinks(query).map((link) => (
                          <a
                            key={link.label}
                            className="source-link"
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="no-referrer"
                          >
                            {link.label} ↗
                          </a>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className="inventory-row-actions">
                        <Link
                          className="button small"
                          href={`/admin/inventory/record?item=${item.id}`}
                        >
                          Receive purchased stock
                        </Link>
                        <Link
                          className="source-link"
                          href={`/admin/watchlist/${item.id}`}
                        >
                          Open watch
                        </Link>
                      </div>
                      <WatchInlineEditor
                        version={watch.updatedAt.toISOString()}
                        itemId={item.id}
                        watch={watch}
                        fallbackQuery={item.japaneseName || item.name}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!items.length && (
          <p className="empty-state">
            No enabled watches match these filters. Add a purchase watch from an
            item’s detail page or catalog bulk actions.
          </p>
        )}
        <Pagination
          base="/admin/watchlist"
          params={filters}
          page={filters.page}
          pageCount={pageCount}
          total={total}
          size={filters.size}
        />
      </section>
      <p className="table-note">
        Still wanted = max(target − all owned units, 0). An unset target has no
        calculated gap. Japan/France totals use inherited physical country
        settings; transit and unassigned countries still count toward ownership.
        Fulfillment uses its separate explicit location setting. Price sorts
        group currencies without conversion. Search links open external sites;
        mark checked explicitly after reviewing.
      </p>
    </>
  );
}
