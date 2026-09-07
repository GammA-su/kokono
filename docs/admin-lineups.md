# Merchandise admin

Open `/admin/merchandise/lineups` after provisioning an internal account as described in the README. The shared sidebar links Dashboard, Franchises, Lineups, Catalog, and Inventory. There was no prior admin UI; the implementation adds reusable native React controls and a shared stylesheet without adding a UI framework or runtime dependencies.

## List and detail behavior

The Lineups view performs search, filtering, sorting, and pagination in PostgreSQL. Search covers English/Japanese lineup and franchise names and manufacturers. Filters include franchise, release status, release year, manufacturer, and optional archived records. Apply commits filters to the URL, making results bookmarkable; pagination preserves all filters. Sort by newest release, oldest release, recently added, or name. Unknown release dates sort last in date modes. A stable ID tie-breaker prevents ambiguous ordering. Pages contain 25, 50, or 100 releases; out-of-range pages are clamped.

Counts are calculated in bulk for only the selected lineup IDs, using indexed UUID comparisons. Catalogued items count designs, including archived catalog records. Owned items count designs with a positive balance, not copies. Published items count currently visible listings, excluding archived items, lineups, and franchises.

The detail page includes a primary image, release identity, dates at original precision, status, source links and counts for characters, watched items, owned designs, published designs, and physical stock units. Stock sums all balances, including in-transit and inactive locations; parent locations are not duplicated as rollups. Item-table location counts include only positive balances. Items are paginated, while summary counts always cover the entire lineup.

The item table displays English/Japanese names, primary image (falling back to the next ordered image), characters, category, JAN, JPY MSRP, total stock, storage-location count, watch status and listing status. A published zero-stock item remains Published. A published record hidden through archival is labelled Published · hidden. A non-JPY MSRP is not silently converted; it displays a dash in the JPY column with an explanatory tooltip.

## Forms and actions

- Create lineup requires an active franchise and name. It accepts the other release fields, main image, and multiple sources and redirects directly to the created detail page.
- Announced/release fields explicitly select Unknown, Year, Month, or Exact date. Increasing precision clears unavailable components instead of inventing them. `2026-11` is stored with MONTH precision and renders **November 2026**.
- Edit keeps the public slug stable, detects stale edits using `updatedAt`, and saves release metadata and source changes in one transaction. Errors retain the entered form fields.
- Duplicate copies release metadata and links, resets verification checks, and redirects to the new copy's edit form. It never copies items or inventory.
- Delete requires typing the current name. Empty lineups are removed; populated lineups are archived with inventory/history intact. Include archived reveals them, and Restore explains its effect on existing published items.
- Add item creates a canonical catalog record, selected character relations and optional sources atomically, with no stock, watch, or listing. MSRP is optional and entered in whole JPY. SKU can be entered or generated.
- Source editors support up to 50 links per lineup/item with provider, type, URL, notes and optional checked date. Only HTTP(S) links are accepted. Item-specific source management is accessible from each item row. Supplying a source type does not assert that its content has been verified.

## Private images

Main image accepts an external HTTP(S) URL or a PNG/JPEG/WebP upload up to 5 MiB. An upload takes precedence over the URL; Remove current image clears the reference. Uploaded bytes are checked for supported format signatures, receive a generated UUID filename, and are stored outside the public web directory. SVG/HTML and path-traversal references are refused. The image route requires an active internal account and returns private, noncached responses. External URLs render in the browser without sending a referrer and are not fetched by a server-side URL proxy.

The default upload directory is `.local/uploads`. Set `MERCHANDISE_UPLOAD_DIR` to a persistent volume for hosting and back up this directory with the database. Existing images are retained when unlinked or duplicated, because references may be shared. Failed new uploads are removed when the database save fails. Shared-image garbage collection and an object-storage adapter are future work. The application uses Node.js/PostgreSQL and a filesystem adapter; no Cloudflare/Sites conversion or external deployment is included in this repository change.

## Verification

`npm test` runs the domain and PostgreSQL integration tests, including filters, sort orders, pagination, source retention, partial dates, counts across multiple locations, duplication, archival/history preservation, optimistic concurrency, atomic item/source creation, and image storage guards.

`npm run test:admin-http` checks actual local authenticated page rendering, rendered month precision, and anonymous admin/media restrictions. It removes its temporary account and sample data on completion. Browser automation was unavailable in the implementation session, so responsive CSS and dialog interaction still benefit from a manual browser review at desktop and mobile widths.
