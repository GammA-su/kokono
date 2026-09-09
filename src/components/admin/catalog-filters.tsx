import Link from "next/link";
import {
  catalogSortLabels,
  pageSizes,
  type CatalogFilters,
} from "@/modules/catalog/queries";
import { createCatalogQueries } from "@/modules/catalog/queries";
import { statusLabels } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";

type Facets = Awaited<
  ReturnType<ReturnType<typeof createCatalogQueries>["facets"]>
>;
const base = "/admin/merchandise/catalog";
const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const priorities = ["URGENT", "HIGH", "NORMAL", "LOW"];

function Choice({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string;
  options: [string, string][];
}) {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select name={name} defaultValue={value} aria-label={label}>
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A selector whose options are searched on the server. Large operator catalogs hold thousands
 * of lineups and characters; rendering them all in one select is unusable and truncating them
 * silently hides records. The search box narrows the options, and the count states plainly how
 * many exist so a filter is never applied against a list the operator could not see.
 */
function SearchableChoice({
  name,
  label,
  value,
  options,
  query,
  queryName,
  total,
  limit,
  emptyLabel,
}: {
  name: string;
  label: string;
  value: string;
  options: [string, string][];
  query: string;
  queryName: string;
  total: number;
  limit: number;
  emptyLabel: string;
}) {
  return (
    <div className="filter-searchable">
      <label>
        <span className="sr-only">Search {label.toLowerCase()}</span>
        <input
          type="search"
          name={queryName}
          defaultValue={query}
          maxLength={200}
          placeholder={`Search ${label.toLowerCase()}…`}
          aria-label={`Search ${label.toLowerCase()}`}
        />
      </label>
      <Choice
        name={name}
        label={label}
        value={value}
        options={[["", emptyLabel], ...options]}
      />
      {total > limit && (
        <p className="table-note">
          Showing {limit.toLocaleString("en-GB")} of{" "}
          {total.toLocaleString("en-GB")} — search to narrow the list.
        </p>
      )}
    </div>
  );
}

/** Every filter is a URL parameter, so a filtered catalog view can be shared or bookmarked. */
export function CatalogFilterForm({
  filters,
  facets,
}: {
  filters: CatalogFilters;
  facets: Facets;
}) {
  const advanced = Boolean(
    filters.character ||
    filters.manufacturer ||
    filters.year ||
    filters.month ||
    filters.status ||
    filters.location ||
    filters.listing !== "any" ||
    filters.watch !== "any" ||
    filters.priority ||
    filters.jan !== "any" ||
    filters.source !== "any",
  );
  return (
    <form className="filter-form" action={base} key={JSON.stringify(filters)}>
      <div className="filter-top">
        <label className="search-field">
          <Icon name="search" />
          <span className="sr-only">Search the catalog</span>
          <input
            name="q"
            defaultValue={filters.q}
            placeholder="Search names, Japanese names, characters, SKU, JAN, lineup, franchise…"
            maxLength={200}
          />
        </label>
        <label className="sort-field">
          <span>Sort by</span>
          <select name="sort" defaultValue={filters.sort}>
            {Object.entries(catalogSortLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="filter-bottom">
        <Choice
          name="franchise"
          label="Franchise"
          value={filters.franchise ?? ""}
          options={[
            ["", "All franchises"],
            ...facets.franchises.map((franchise): [string, string] => [
              franchise.id,
              franchise.archivedAt
                ? `${franchise.name} (archived)`
                : franchise.name,
            ]),
          ]}
        />
        <SearchableChoice
          name="lineup"
          label="Lineup"
          value={filters.lineup ?? ""}
          query={filters.lineupQuery}
          queryName="lineupQuery"
          total={facets.lineupTotal}
          limit={facets.optionLimit}
          emptyLabel="All lineups"
          options={facets.lineups.map((lineup): [string, string] => [
            lineup.id,
            lineup.name,
          ])}
        />
        <Choice
          name="category"
          label="Category"
          value={filters.category ?? ""}
          options={[
            ["", "All categories"],
            ...facets.categories.map((category): [string, string] => [
              category.id,
              category.name,
            ]),
          ]}
        />
        <Choice
          name="stock"
          label="Inventory"
          value={filters.stock}
          options={[
            ["any", "Any inventory state"],
            ["has", "Has inventory"],
            ["none", "No inventory"],
            ["fulfillable", "Fulfillable stock"],
          ]}
        />
        <Choice
          name="archived"
          label="Archived records"
          value={filters.archived}
          options={[
            ["false", "Active records"],
            ["true", "Include archived"],
            ["only", "Archived only"],
          ]}
        />
        <Choice
          name="size"
          label="Items per page"
          value={String(filters.size)}
          options={pageSizes.map((size): [string, string] => [
            String(size),
            `${size} per page`,
          ])}
        />
        <button className="button small">Apply</button>
        <Link href={base} className="text-button">
          Reset
        </Link>
      </div>
      <details className="filter-advanced" open={advanced}>
        <summary>More filters</summary>
        <div className="filter-bottom">
          <SearchableChoice
            name="character"
            label="Character"
            value={filters.character ?? ""}
            query={filters.characterQuery}
            queryName="characterQuery"
            total={facets.characterTotal}
            limit={facets.optionLimit}
            emptyLabel="All characters"
            options={facets.characters.map((character): [string, string] => [
              character.id,
              character.name,
            ])}
          />
          <Choice
            name="manufacturer"
            label="Manufacturer"
            value={filters.manufacturer ?? ""}
            options={[
              ["", "All manufacturers"],
              ...facets.manufacturers.map((name): [string, string] => [
                name,
                name,
              ]),
            ]}
          />
          <Choice
            name="year"
            label="Release year"
            value={filters.year ? String(filters.year) : ""}
            options={[
              ["", "All years"],
              ...facets.years.map((year): [string, string] => [
                String(year),
                String(year),
              ]),
            ]}
          />
          <Choice
            name="month"
            label="Release month"
            value={filters.month ? String(filters.month) : ""}
            options={[
              ["", "All months"],
              ...months.map((month, index): [string, string] => [
                String(index + 1),
                month,
              ]),
            ]}
          />
          <Choice
            name="status"
            label="Release status"
            value={filters.status ?? ""}
            options={[
              ["", "All release statuses"],
              ...Object.entries(statusLabels).map(
                ([value, label]): [string, string] => [value, label],
              ),
            ]}
          />
          <Choice
            name="location"
            label="Storage location"
            value={filters.location ?? ""}
            options={[
              ["", "All storage locations"],
              ...facets.locations.map((location): [string, string] => [
                location.id,
                `${location.code} · ${location.name}`,
              ]),
            ]}
          />
          <Choice
            name="listing"
            label="Publication"
            value={filters.listing}
            options={[
              ["any", "Any publication state"],
              ["published", "Published"],
              ["unpublished", "Unpublished"],
            ]}
          />
          <Choice
            name="watch"
            label="Purchase watch"
            value={filters.watch}
            options={[
              ["any", "Any watch state"],
              ["enabled", "Watch enabled"],
              ["disabled", "Watch disabled or absent"],
            ]}
          />
          <Choice
            name="priority"
            label="Watch priority"
            value={filters.priority ?? ""}
            options={[
              ["", "Any priority"],
              ...priorities.map((priority): [string, string] => [
                priority,
                `${priority.charAt(0)}${priority.slice(1).toLowerCase()} priority`,
              ]),
            ]}
          />
          <Choice
            name="jan"
            label="JAN code"
            value={filters.jan}
            options={[
              ["any", "Any JAN state"],
              ["has", "Has JAN"],
              ["none", "No JAN"],
            ]}
          />
          <Choice
            name="source"
            label="Sources"
            value={filters.source}
            options={[
              ["any", "Any source state"],
              ["official", "Has official source"],
              ["none", "No sources"],
            ]}
          />
          <button className="button small">Apply</button>
        </div>
      </details>
    </form>
  );
}
