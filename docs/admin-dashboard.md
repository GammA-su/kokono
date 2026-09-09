# Merchandise operations dashboard

`/admin` is the internal operations dashboard. The previous `/admin/merchandise` dashboard redirects here. The sidebar and brand link use the canonical route. All data access verifies an active internal account, and the server renders fresh private data per request. No public endpoint or shared response cache exposes dashboard values.

## Metric definitions

- Catalog totals include archived franchises, lineups and merchandise. Recently added means the last 30 rolling days; the list shows the latest five records in that window.
- Sourcing counts enabled watches, including watches on archived merchandise, matching the watchlist's default scope. HIGH and URGENT are separate counts. Below target requires a known target greater than total owned stock. Overdue means never checked or last checked at least 30 days ago. Three independent five-item queues cover high/urgent priority, largest positive gaps, and oldest checks.
- Owned inventory includes every physical location, including inactive storage and archived items. Fulfillment uses the existing explicit location allowlist: the exact location must opt in, every ancestor must be active, and no ancestor may be in transit. Country follows the shared configured country inheritance; names do not determine geography. Transit stock is excluded from country counts.
- Published and featured counts match public archive visibility rules. Featured means featured and published. Draft means an existing unpublished SaleListing, including archived records; catalog-only merchandise has no draft listing. The draft link opens the broader unpublished catalog for management.
- Low stock shows up to eight published, nonarchived products with 0–3 fulfillable units, ascending. Zero stock is included and does not unpublish anything.
- Logistics groups balances under their actual configured root storage locations, including descendants exactly once. Other or unassigned countries remain in owned totals and are explicitly noted.
- Latest releases shows eight active lineups ordered by release date descending, with unknown dates last. Partial dates retain their original precision. Year counts include all lineups and a separate unknown-year group.
- Franchise summary shows the ten largest catalogs. Owned SKUs means distinct merchandise records with positive stock; physical units is displayed separately.
- Recent activity shows the ten latest ledger entries of any movement type, with actor, current physical paths, acquisition cost and reference. Transfers are labelled as units moved; other changes are signed. Each item links to its full filtered movement history. Dates/times are displayed in Europe/Paris.

## Values and coverage

All calculations retain integer currency minor units and use shared money formatting. Different currencies are never added together or converted.

**Known acquisition value** is lifetime positive, non-transfer movement quantity multiplied by its recorded acquisition unit cost. Units without a cost are reported as uncovered; an explicit zero cost is known. This is recorded receipt value, including units subsequently removed, not a balance-sheet valuation.

**Estimated acquisition value on hand** uses the same rule as the inventory overview: current owned quantity times the latest known positive acquisition unit cost for that SKU. Its coverage indicates units on SKUs with a known cost. It is an estimate, not FIFO or actual lot accounting. A later uncosted receipt retains the older known cost estimate; the lifetime receipt coverage still reports the missing cost.

**Estimated landed inventory value** is unavailable because the current schema has no freight, customs, tax or landed-cost allocation model. It is never substituted with zero or an acquisition-only total.

**Potential retail value** is current fulfillable quantity multiplied by the current price on a publicly visible SaleListing. Fulfillable units with no visible listing appear as uncovered units, rather than being assigned a zero price. This is gross potential sales value, not profit or expected revenue.

Empty data displays an explicit no-recorded-value state. A recorded zero displays a real currency amount. Coverage labels distinguish partial data from complete cost/price coverage.

## Implementation and checks

`src/modules/dashboard/queries.ts` uses PostgreSQL aggregates for counts, stock, currency groups, years and franchise totals. Only bounded action lists hydrate merchandise using existing catalog selectors and presentation logic. Inventory totals and latest acquisition SQL are shared with existing catalog/inventory queries; location paths and fulfillment eligibility are reused unchanged. Queries run sequentially in a repeatable-read internal transaction for a coherent snapshot and to avoid concurrent queries on one PostgreSQL client.

The dashboard is read-only. No inventory, catalog, listing or sourcing mutation is added. No database migration or runtime dependency is needed.

Integration tests cover empty data, all requested metrics, hierarchy/geography, transfer preservation, archive visibility, priorities/gaps/stale checks, low-stock ordering, partial dates, currency separation, missing and zero costs, valuation agreement with inventory, actor/history and authorization. HTTP checks cover the route, legacy redirect, rendering and anonymous access.
