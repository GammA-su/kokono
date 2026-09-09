# Merchandise admin

The catalog view of every known item is documented separately in
[the catalog guide](admin-catalog.md); this guide covers lineups and item entry.

Open `/admin/merchandise/lineups` after provisioning an internal account as described in the README. The shared sidebar links Dashboard, Franchises, Lineups, Catalog, and Inventory. There was no prior admin UI; the implementation adds reusable native React controls and a shared stylesheet without adding a UI framework or runtime dependencies.

## List and detail behavior

The Lineups view performs search, filtering, sorting, and pagination in PostgreSQL. Search covers English/Japanese lineup and franchise names and manufacturers. Filters include franchise, release status, release year, manufacturer, and optional archived records. Apply commits filters to the URL, making results bookmarkable; pagination preserves all filters. Sort by newest release, oldest release, recently added, or name. Unknown release dates sort last in date modes. A stable ID tie-breaker prevents ambiguous ordering. Pages contain 25, 50, or 100 releases; out-of-range pages are clamped.

Counts are calculated in bulk for only the selected lineup IDs, using indexed UUID comparisons. Catalogued items count designs, including archived catalog records. Owned items count designs with a positive balance, not copies. Published items count currently visible listings, excluding archived items, lineups, and franchises.

The detail page includes a primary image, release identity, dates at original precision, status, source links and counts for characters, watched items, owned designs, published designs, and physical stock units. Stock sums all balances, including in-transit and inactive locations; parent locations are not duplicated as rollups. Item-table location counts include only positive balances. Items are paginated, while summary counts always cover the entire lineup.

The item table links each item to its catalog detail page and displays English/Japanese names, primary image (falling back to the next ordered image), characters, category, the item's own release date at its recorded precision, JAN, JPY MSRP, total stock, storage-location count, watch status and listing status. A published zero-stock item remains Published. A published record hidden through archival is labelled Published · hidden. A non-JPY MSRP is not silently converted; it displays a dash in the JPY column with an explanatory tooltip.

## Forms and actions

- Create lineup requires an active franchise and name. It accepts the other release fields, main image, and multiple sources and redirects directly to the created detail page.
- Announced/release fields explicitly select Unknown, Year, Month, or Exact date. Increasing precision clears unavailable components instead of inventing them. `2026-11` is stored with MONTH precision and renders **November 2026**.
- Edit keeps the public slug stable, detects stale edits using `updatedAt`, and saves release metadata and source changes in one transaction. Errors retain the entered form fields.
- Duplicate copies release metadata and links, resets verification checks, and redirects to the new copy's edit form. It never copies items or inventory.
- Delete requires typing the current name. Empty lineups are removed; populated lineups are archived with inventory/history intact. Include archived reveals them, and Restore explains its effect on existing published items.
- Add item creates a canonical catalog record, selected character relations and optional sources atomically, with no stock, watch, or listing. MSRP is optional and entered in whole JPY. SKU can be entered or generated.
- Add items opens the bulk entry grid described below. Add single item keeps the original one-record form.
- Source editors support up to 50 links per lineup/item with provider, type, URL, notes and optional checked date. Only HTTP(S) links are accepted. Item-specific source management is accessible from each item row. Supplying a source type does not assert that its content has been verified.

## Bulk merchandise entry

`Add items` on a lineup opens `/admin/merchandise/lineups/<id>/items/bulk`, a grid for entering 10-50 designs without reopening a form. The lineup stays in view at the top: franchise, name, Japanese name, manufacturer, release date at its original precision, status, main image and the first source link.

Each row carries a primary image, English and Japanese names, characters, category, official MSRP with currency, release date with precision, JAN and a purchase-watch toggle. Row-level `More` expands manufacturer, internal SKU, MSRP tax status, image URL, one initial source, private notes and the full purchase-watch configuration inline; the editor uses no modal dialogs.

- **Inheritance.** New rows start from the lineup's manufacturer, release date/precision and first source link. `Apply lineup values to all items` rewrites those fields on every row after the lineup changes. Any row can override them.
- **Duplicate previous row** copies the last row that has content: category, MSRP, release data, manufacturer, source metadata and watch defaults. It never copies the name, Japanese name, SKU, JAN, characters, private notes, marketplace query or image, which identify an individual design.
- **Keyboard.** Enter moves to the next item and creates one at the end of the grid, Ctrl+Enter adds a row, Ctrl+D duplicates the last filled row. The character field is a combobox: type to filter, arrow keys to move, Enter to select, Backspace to remove the last chip, and an unmatched name offers `Create "..." in this franchise`, which creates the Character in the lineup's franchise without leaving the page.
- **Rows.** The grid takes up to 100 rows with sticky column headers, a sticky toolbar and a sticky save bar. Rows still holding only inherited lineup values are dropped when saving, so reported row numbers always match the rows submitted. Unsaved changes are flagged in the toolbar and confirmed before leaving the page.
- **Images.** Upload uses the same private storage and format checks as lineup images; an external HTTP(S) URL can be referenced instead. Each row's image is stored as `ItemImage` with role `PRIMARY`, and a remote reference also records `originalUrl` plus the row's source URL and provider. No image bytes are stored in PostgreSQL and no remote image is fetched by the server. Row images upload immediately, so an upload for a batch that is never saved stays in the upload directory; shared-image garbage collection remains future work.
- **Internal SKUs** are generated per lineup as `<LINEUP TOKEN>-<lineup digest>-<sequence>`, for example `MARINEVER20-9F3A1C-0007`. The sequence continues across batches and never derives identity from the item name. A row can supply its own SKU; a SKU that already exists is rejected.
- **Validation** runs for every row before anything is written. `Check rows` validates without saving. Errors name the row, the field and the reason, for example `Row 14 - JAN code: JAN code must be 8 or 13 digits.` Valid rows stay in the editor.
- **Duplicate detection** reports an exact JAN match anywhere in the catalog, the same Japanese name in the lineup, a normalized English name in the lineup, and the same characters, category and MSRP in the lineup, both against existing items and within the batch. These are shown as `Possible duplicate` and block saving only until the administrator confirms them with the acknowledgement checkbox. A conflicting internal SKU is a hard rejection.
- **Save all** validates, then creates every item, its character relations, initial source, primary image and purchase watch in one transaction. Nothing is written when any row fails. After saving, the lineup page opens with a summary notice and the new merchandise listed immediately.

Purchase watches are created only for rows that enable the toggle or fill a watch field; a marketplace query alone stores a disabled watch configuration. MSRP is catalog metadata and is never treated as purchase cost or selling price.

## Private images

Main image accepts an external HTTP(S) URL or a PNG/JPEG/WebP upload up to 5 MiB. An upload takes precedence over the URL; Remove current image clears the reference. Uploaded bytes are checked for supported format signatures, receive a generated UUID filename, and are stored outside the public web directory. SVG/HTML and path-traversal references are refused. The image route requires an active internal account and returns private, noncached responses. External URLs render in the browser without sending a referrer and are not fetched by a server-side URL proxy.

The default upload directory is `.local/uploads`. Set `MERCHANDISE_UPLOAD_DIR` to a persistent volume for hosting and back up this directory with the database. Existing images are retained when unlinked or duplicated, because references may be shared. Failed new uploads are removed when the database save fails. Shared-image garbage collection and an object-storage adapter are future work. The application uses Node.js/PostgreSQL and a filesystem adapter; no Cloudflare/Sites conversion or external deployment is included in this repository change.

## Verification

`npm test` runs the domain and PostgreSQL integration tests, including filters, sort orders, pagination, source retention, partial dates, counts across multiple locations, duplication, archival/history preservation, optimistic concurrency, atomic item/source creation, and image storage guards. Bulk entry adds coverage for multi-item batches, multi-character items, inherited lineup metadata, the duplicate-row workflow, imprecise release dates, purchase-watch creation, duplicate detection and acknowledgement, per-row validation reporting, SKU generation and authorization.

`npm run test:admin-http` checks actual local authenticated page rendering, rendered month precision, the bulk entry page's controls and inherited release precision, and anonymous admin/media restrictions. It removes its temporary account and sample data on completion. The bulk grid was additionally driven in headless Edge over the DevTools protocol during implementation: hydration, the character combobox, row duplication, keyboard row creation, duplicate review and the transactional save were exercised against the running application. Responsive CSS below desktop widths still benefits from a manual browser review.
