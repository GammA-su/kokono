# Bulk merchandise management

Catalog cards and lineup item tables share `BulkSelection`. Individual selection, Select all visible, and Clear selection work across pagination in the same view. Catalog filter/sort changes reset selection; the existing filter URLs and Pagination component are unchanged. Select all visible affects only that page and retains other selected pages.

**Select entire lineup means every catalog record in that lineup across all pages, including archived records.** Individual exclusions remain possible. The toolbar explicitly labels this server-side mode. Review resolves the selection using `createCatalogQueries.matchingIds` and the existing catalog predicates/NFKC normalization. It never silently truncates a selection: batches are limited to 1,000 items; larger lineups require visible-page selection in smaller batches.

Review creates an HMAC-signed, actor-bound snapshot of item IDs valid for 20 minutes. New items added after review opens are excluded. Explicit catalog selections are intersected with the current filters and any omissions are shown. Expired, modified, duplicate-row and foreign-row submissions are rejected. No database schema migration is required.

## Operations

- Receive: destination, **quantity for each item**, optional shared/per-item unit cost, currency, purchase reference and note. No quantity is assumed. Blank cost overrides inherit the default; enter zero for a known zero cost.
- Transfer: source, destination and quantity per item. The inventory service checks live source availability, locks the item, and moves both balances with one ledger record in the same transaction.
- Adjust: location, signed quantity change per item and mandatory reason. Positive and negative adjustments create movement history; there is no replacement stock field.
- PurchaseWatch: shared enabled state, priority, optional target quantity, optional maximum price/currency and condition preference. Expand a row for enabled, priority, quantity, price or condition overrides. Blank overrides inherit defaults. Blank default limits remove those limits. Existing sourcing notes and marketplace queries remain intact. Disable only updates existing enabled watches.
- Publish to Store: opens **Publication review**, not an immediate publication action. Review/edit public title (blank falls back to catalog name), unique listing slug, selling price and currency for each included record. Missing listing data must be entered or the row excluded. Confirmation is mandatory. Archived items/parents are rejected and zero stock is allowed. The publication service validates, checks reviewed versions, and saves/publishes each listing atomically. Stale reviews require a new review.
- Unpublish: uses the publication service and retains listing data.
- Set selling price / feature / unfeature: updates existing listings through publication services. Missing listings are skipped, with a reason; create them through publication review.
- Set category: validates and changes the category through the catalog service.
- Archive: confirmed archival through the catalog service, preserving items, stock, watches and movement history. Public queries already hide archived merchandise. There is no destructive delete.
- Export: downloads the fixed selection in the shared [catalog CSV format](catalog-csv.md), including catalog fields, PurchaseWatch configuration and private notes. Inventory and listing fields are excluded. UTF-8 BOM preserves Japanese text; quoted cells and formula-prefix neutralization protect spreadsheet exports. Amounts use integer minor units for import/export round trips.

## Transactions and feedback

A review and an execution each use one Server Action request for the batch, not one request per item. The server processes records sequentially through existing domain services. Each record is an independent transaction: valid rows can succeed when another fails. A transfer's debit, credit and movement are atomic. The complete batch is intentionally not all-or-nothing, matching per-row failure reporting.

Every record reports updated, skipped or failed with a reason for skips/failures, alongside totals. Retry failed items preserves previous outcomes. Stock operation keys derive from the signed review nonce and item ID, so retrying the same request cannot add stock twice; changing an already-applied stock request produces a key-conflict error. Other operations assign domain metadata, not balances. A fresh review represents a new stock operation and must not be used to retry an uncertain prior submission.

Every request checks the active internal account, and authorization is rechecked during processing and inside domain transactions. Revocation halts subsequent mutations and returns explicit failure outcomes for remaining records. The existing private/public data boundary remains in place.

## Modules and verification

`src/modules/bulk-management/` contains selection semantics, signed snapshots, orchestration, Server Actions and CSV export. Catalog queries expose bounded selection resolution and share card hydration with browsing. Catalog/publication services own the added metadata operations; all inventory changes continue through `applyInventoryOperation`. Shared monetary form parsing lives beside existing money formatting.

Tests cover selection and exclusions across pages, lineup snapshots, filter/NFKC reuse, watch defaults and overrides, varied receipts/costs, idempotent retries, insufficient stock and rollback, signed adjustments/reasons, publication handoff/confirmation/invalid data/stale versions, archive retention, metadata updates, CSV formatting, authorization and partial failures. `npm run test:admin-http` verifies server-rendered Catalog and Lineup selection controls using a temporary local internal account. Responsive layout and interactive dialogs still warrant manual browser review.
