# Internal merchandise catalog

Catalog and Lineup pages also support [bulk merchandise management](bulk-management.md), including selection across pages, stock movements, watches, publication review, metadata updates, export and archival.

`/admin/merchandise/catalog` is the knowledge base of every merchandise design the business
knows about. An item appears here as soon as it is catalogued: owning it, watching it and
publishing it are independent facts, and none of them is required. The view is reached from
the sidebar, from the dashboard's "Catalogued items" card, and from any item name in a
lineup's item table.

## Grid

The default view is a card grid. Each card shows the primary image, English/display name,
Japanese name, characters, franchise, lineup, category, release information, official MSRP
and an owned-stock summary. Cards link to the merchandise item detail page.

Status badges describe the states an item holds at once:

| Badge | Meaning |
| --- | --- |
| Catalog only | Known merchandise with no stock and no published listing |
| Watching | An enabled `PurchaseWatch` |
| In stock | Owned inventory above zero, anywhere |
| Live | A published listing with fulfillable stock |
| Out of stock | A published listing with no fulfillable stock |
| Archived | The item, its lineup or its franchise is archived |

`catalogStatuses` in `src/modules/catalog/presentation.ts` is the single implementation of
these rules, shared by the grid, the detail page and the tests.

## Stock summary

Cards separate two different numbers. **Owned** sums every balance, including units in
transit and at inactive locations, because those units are still owned. **Fulfillable**
counts only locations explicitly enabled for fulfillment whose ancestors are all active and
outside transit — the same rule the public storefront queries use, through the shared
`fulfillableLocationIds` helper.

Location chips group balances by the segment of the location code before the first hyphen,
so `JP-WAREHOUSE` reads as `JP` and `FR-HOME-SHELF-A-BOX-A1` as `FR`. Anything at a location
of type `IN_TRANSIT` is grouped as `Transit` instead, so goods in shipment are never mistaken
for available stock.

## Search

One search box covers English name, Japanese name, aliases, internal SKU, JAN, character
names and aliases, lineup names and franchise names, in both scripts. Input is NFKC
normalized, so full-width `ＲＥＭ` matches `Rem`, and LIKE wildcards typed by the operator are
escaped and matched literally. Matching runs in PostgreSQL; the browser never receives more
than one page of records.

## Filters and sorting

Franchise, lineup, character, category, manufacturer, release year, release month, release
status, storage location, inventory state (any/has/none/fulfillable), publication, purchase
watch, watch priority, JAN presence, source presence and archival are all URL parameters, so
any view can be bookmarked or shared. Less common filters live behind **More filters**, which
opens automatically when one of them is active. Lineup and character options are scoped to
the selected franchise.

Sorting covers newest and oldest release, recently catalogued, recently updated,
alphabetical, MSRP low→high and high→low, total stock, fulfillable stock and purchase
priority. Every sort has a stable item-ID tie-breaker. MSRP amounts are compared exactly as
recorded: currencies are never converted, and `formatMoney` renders each amount with its own
currency exponent (`1650 JPY` → ¥1,650, `2500 EUR` → €25.00).

Release dates keep the precision they were recorded with. An item's own release date is used
when it has one, otherwise the lineup's is shown and marked `· lineup`. A year-only date is
stored on 1 January as an anchor, so it never answers a January (or any other) month filter
and is never rendered as a day.

## Item detail

`/admin/merchandise/catalog/<id>` groups the record into four visually separate panels:

- **Catalog** — names, aliases, characters, category, lineup, franchise, manufacturer,
  release, MSRP with tax status, JAN, internal SKU, slug, description, private notes, source
  links and images with their roles and provenance.
- **Sourcing** — the purchase watch: enabled state, priority, target quantity, maximum unit
  price, condition preference, marketplace search query and notes.
- **Inventory** — owned, fulfillable and location counts, the per-location breakdown with an
  explicit fulfillable flag, and a link to the movement history.
- **Sale** — listing state, selling price, public title and slug, featured flag, last
  publication and current fulfillable availability.

`/admin/merchandise/catalog/<id>/movements` paginates the append-only ledger for that item,
showing type, signed quantity, source and destination locations, acquisition unit cost, actor
and notes. A transfer is one row that moves units, so the quantity column does not sum to an
ownership total; current balances are on the item page.

## Performance

The list runs three statements per request: one filtered, ordered page of item IDs carrying
its own total through a window function; one relational load of just those IDs; and one
per-location stock query for the same IDs. There is no N+1 pattern and no aggregate is
computed over the whole catalog unless a stock sort asks for one. Only one image reference is
loaded per card.

Measured on the development database with 20,004 items, 40 lineups, 4,000 stocked items,
1,500 watches and 900 listings: default page 54–68 ms, Japanese search ~110 ms, stock and
priority sorts 56–68 ms, fulfillable filter ~74 ms, page 400 of the deep result set 62–74 ms,
filter facets 31–61 ms. Search uses `ILIKE`, which scans; if the catalog grows to where that
becomes the bottleneck, the next step is a `pg_trgm` GIN index on the searched columns rather
than a change to the query shape.

## Authorization

Every catalog query runs through `withInternalTransaction`, so the session is checked and the
active internal membership is rechecked inside the transaction. Anonymous requests to the
catalog, an item, or a movement history are redirected to the login screen. Private notes,
watch configuration, cost and provenance are internal-only; the public listing queries keep
their own explicit allowlist and were not extended.
