# Catalog CSV import and export

Lineup details provide **Export CSV** (all merchandise in that lineup, including archived items, regardless of the visible page) and **Import CSV**. Catalog provides **Export filtered catalog CSV** across every matching page. The existing selected-item bulk **Export selected** action now uses the same catalog format; it no longer generates the old stock/status report.

Exports use the existing catalog filters and selectors. The full-download endpoint streams batches after resolving matching IDs, ordered by stable item ID. It supports up to 100,000 matches and refuses larger results instead of silently truncating them. Narrow filters for larger catalogs. Access is internal-only, uncached and checked again during each export batch.

## Format

UTF-8 (a BOM is included for Excel), comma-separated, every cell quoted, embedded quotes doubled, CRLF records. Quoted fields may contain commas and newlines. Upload at most 250 merchandise records and 2 MiB per review. Split larger exports for import. CSV record numbers include the header as record 1; a multiline quoted value is still one record.

Columns:

| Columns | Meaning |
| --- | --- |
| `internal_sku`, `name`, `japanese_name` | Identity and merchandise names. Empty SKU generates one when creating. |
| `characters` | Existing character names in the destination franchise, separated by `|`: `Rem|Ram`. Escape literal `|` as `\|` and literal `\` as `\\`. Exact English or Japanese names must resolve unambiguously. |
| `category` | Existing category slug (exported), or an unambiguous exact category name. Unknown categories/characters are validation errors; import does not silently create taxonomy. |
| `official_msrp_amount`, `official_msrp_currency`, `official_msrp_tax_state` | Whole currency minor units, uppercase three-letter currency, and `INCLUDED`, `EXCLUDED` or `UNKNOWN`. JPY `1650` means ¥1,650; EUR `1250` means €12.50. Supply a currency for a new amount. No conversion or rounding. |
| `jan_code` | 8 or 13 digits, preserved as text. JAN is a duplicate signal, not a unique item identity. |
| `release_date`, `release_date_precision` | `2026` / `YEAR`, `2026-11` / `MONTH`, `2026-11-23` / `DAY`. If precision is omitted it follows the date string's actual length. A supplied conflicting precision is rejected. |
| `manufacturer` | Item-specific manufacturer. |
| `source_provider`, `source_type`, `source_url` | One source. Provider and HTTP(S) URL are required together; type defaults to `OTHER`. Supported types are `OFFICIAL_STORE`, `MANUFACTURER`, `OFFICIAL_ANNOUNCEMENT`, `RETAILER`, `EVENT`, `OTHER`. |
| `sources_json` | Optional additional sources as a JSON array of `{ "provider": "Shop", "source_type": "RETAILER", "url": "https://example.com/item" }`. Exports include all item source URLs. Duplicate URLs are coalesced; conflicting definitions fail validation. Source notes and verification dates are preserved on updates and are not exported in this column. |
| `marketplace_search_query`, `watch_enabled`, `watch_target_quantity` | Watch search text, `true`/`false` (also accepts `1`/`0`) and a positive integer target. |
| `watch_max_price_amount`, `watch_max_price_currency`, `watch_priority`, `watch_condition` | Whole minor-unit maximum price, currency, `LOW`/`NORMAL`/`HIGH`/`URGENT`, and condition preference. |
| `private_notes` | Internal merchandise notes. |
| `image_url` | Primary image HTTP(S) URL or existing `admin-media/...` reference. The server never fetches remote images. Imported images are not approved for public use automatically. |
| `csv_format` | `kokono-catalog-v1` marks reversible spreadsheet-safety escaping; keep it when editing our exports. |
| `lineup_id`, `lineup_name`, `franchise_name` | Export context. A nonblank `lineup_id` must match the chosen import destination. The two names are informational and never rename the taxonomy. |

An item's inherited release/manufacturer remains blank in these item columns; export does not turn a lineup default into a new item override. The primary image is exported, not the entire image gallery. Re-importing an unchanged file into its original lineup uses **Update existing** and retains other images and source metadata.

Set spreadsheet columns containing SKUs, JAN and partial dates to **Text** before editing, to avoid spreadsheet software stripping leading zeroes or expanding dates. Do not add inventory or listing columns. Unknown columns are rejected; stock/quantity/location fields cannot enter the inventory ledger through this importer.

## Review and update policy

1. Upload the CSV from the destination lineup, choosing whether existing private notes and existing PurchaseWatch fields may be updated. Both opt-ins default off.
2. Parse/validate without writes. Expand **Review all CSV values** for every supplied field. Correct errors in the original file and upload again if needed.
3. Resolve duplicate rows with **Skip**, **Update existing**, or **Create anyway**. Signals are global internal SKU, global JAN, exact Japanese name within the lineup and NFKC/case/punctuation-normalized display name within the lineup. Duplicates within the file are shown too. SKU uniqueness is enforced by PostgreSQL and is never bypassed. Cross-lineup or archived update targets are unavailable. Creating requires a name and category.
4. Review the counts and policy, check confirmation, and import in one server request.
5. Read created/updated/skipped/failed counts and the row-level outcomes. Successful rows remain committed when another row fails; each row and all its catalog relations are atomic.

For updates, only represented **nonblank** fields are written. Blank or missing cells preserve current data; clearing fields is deliberately not part of this import policy. Represented characters replace the character set. New source URLs and image references are additive; matching existing URLs/keys retain provider notes, verification and approval metadata. Sources absent from the file are never removed.

Private notes can be replaced only with the explicit upload-policy opt-in. Watch fields can change only with their separate opt-in and then only nonblank represented watch fields change; watch notes and last-checked timestamps are preserved. New items accept the represented notes/watch configuration normally. Inventory balances/history, SaleListing, aliases and descriptions are outside the importer and cannot be changed by it.

Preview tokens are signed, actor-bound and expire after 30 minutes. Full item/sourcing revisions are checked before an update to protect edits made after preview. Each planned creation has a fixed ID, so retries/concurrent confirmation cannot create that same reviewed row twice. A repeated update may report a stale/already-applied row and require a fresh preview. Reviews are not stored across page reloads. Larger reviews with unusually many duplicate matches may need to be split further.

## Spreadsheet safety

Exports prefix potentially executable spreadsheet text (`=`, `+`, `-`, `@`, leading tab/newline, including compatibility-normalized or whitespace-prefixed formulas) with an apostrophe before quoting. Literal leading apostrophes are doubled. Import removes exactly one protection apostrophe only when the row has this format's marker, making Japanese text, formula-like product names and literal apostrophes round-trip without executing formulas. Unmarked third-party CSV retains literal apostrophes.

No database migration or new dependency is required. Tests cover Japanese/CSV escaping, character separators, dates, MSRP/watch round trips, all three duplicate decisions, hard SKU conflicts, private/inventory/listing protection, stale edits, repeated creation, authorization, filtered exports, malformed input and row-level partial failures.
