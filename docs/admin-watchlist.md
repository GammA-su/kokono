# Purchase watchlist and sourcing

Use `/admin/watchlist` from the internal navigation. Enabled PurchaseWatch records appear even with zero inventory; archived merchandise is included and labeled by default. Create or re-enable a watch from **Create/Manage purchase watch** on the catalog item detail page. Existing catalog and lineup bulk watch actions continue to work.

The dense, paginated table shows merchandise images/names/characters, franchise/lineup/release precision, MSRP, target, total owned, Japan/France owned, fulfillable stock, wanted quantity, maximum unit price and currency, priority, condition, search query and last checked time. Still wanted is `max(target − total owned, 0)`. A null target is “Not set”, not zero. Full stock does not automatically disable a watch.

Priority changes save immediately. Mark checked records server time only when explicitly clicked. Inline **Edit target, price & sourcing** or **Open watch** edits the remaining fields. Full forms reject stale revisions instead of overwriting later edits; quick actions change only their specific field. Disable preserves the watch, inventory, catalog and listing. **Receive purchased stock** opens the existing inventory PURCHASE form and its transactional, idempotent movement service; it does not invent purchases or auto-disable the watch.

Filters are URL-based: franchise, lineup, character, category, priority, release year, stock, below target, Japan/France stock and checked age. Age thresholds include never-checked watches and use elapsed 24-hour periods. Displayed timestamps are UTC. Sorting happens before server pagination; empty/out-of-range pages use the shared catalog pagination. Price sorts group currencies, then amounts ascending with unknown amounts last within each currency; there is no currency conversion.

## Physical country

Storage locations now have an optional `countryCode` (two uppercase letters). Set JP or FR on the warehouse/home location; shelves and boxes inherit the closest explicit ancestor country. A child may override its country. Transit anywhere in the ancestry excludes those units from Japan/France counts. Inactive stock remains owned and counted physically. Unassigned/other-country/transit stock remains part of total ownership and therefore reduces the quantity gap. Country never enables fulfillment, which still uses the existing explicit location flag and active/non-transit ancestry rules.

Migration `20260907230000_watchlist_geography` adds the field, initializes existing JAPAN_WAREHOUSE / FRANCE_HOME records to JP / FR, and indexes watch checked times. Other locations remain unassigned or inherit; country is never guessed from names or code prefixes. Fresh development seeds explicitly assign JP and FR. Existing seed edits remain preserved.

## Marketplace navigation

Links use the saved marketplace query, otherwise the exact Japanese merchandise name, otherwise the English/display name. User text is safely encoded in fixed HTTPS destinations. External links open in a new tab with no referrer. No scraper, polling job, marketplace API, automatic check mark, purchase or order integration is installed.

URL builders live in `src/modules/watchlist/marketplaces.ts`: [Mercari search](https://jp.mercari.com/search?keyword=rem), [Yahoo Auctions search](https://auctions.yahoo.co.jp/search/search?p=rem), [Yahoo Flea Market search](https://paypayfleamarket.yahoo.co.jp/search/%E3%83%AC%E3%83%A0), [Rakuma search](https://fril.jp/s?query=rem), [Suruga-ya search](https://www.suruga-ya.jp/search?search_word=rem), and [Mandarake search](https://order.mandarake.co.jp/order/listPage/list?keyword=rem&lang=ja). Search-page access can depend on the marketplace's region/session policies; URL generation is tested locally without fetching listings.

## Architecture and checks

`createWatchlistQueries` delegates to `createCatalogQueries`, which now accepts an optional sourcing filter context. This reuses merchandise selectors, stock aggregation, NFKC search, fulfillment, release precision and pagination. Geography extends shared location paths and stock summaries. Commands delegate to the existing catalog watch service, with membership checked inside transactions. Public listing selectors remain an explicit allowlist and do not include watch data or internal geography.

Run `npm run db:deploy` before starting the upgraded application. `npm test` includes zero-stock/full-stock/gap handling, geographic ancestry, filters, sorting, pagination, priority preservation, check times, edit validation/conflicts, disable behavior, authorization, public-data isolation and all six URL builders. The HTTP verifier includes watchlist routes and authorization redirects.
