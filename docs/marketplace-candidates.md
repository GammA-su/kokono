# Marketplace candidates

Internal offers live at `/admin/marketplace-listings`. Add them from a purchase watch, or choose catalog merchandise on the new-candidate screen. The list supports item scope, seller/marketplace/external-ID search, status filters and the existing server pagination. Each item can have many offers. Catalog item pages link to these offers; purchase lines link back to their source candidate.

Offers preserve seller, URL, external ID, original price/currency, optional domestic shipping, condition, notes, discovery time and manual check time. Blank shipping means unknown; zero means free/included. Mark checked records an administrator check and does not claim an automated verification or update the whole purchase watch. Price comparisons use integer minor units and only matching currencies. They compare the offer item price against MSRP and the watch maximum, excluding shipping and fees. Bundles require the administrator to verify the per-unit interpretation.

## Conversion

1. Verify the offer manually and mark it AVAILABLE.
2. Open **Convert to purchase** after placing the purchase externally.
3. Confirm seller, quantity, actual unit purchase price, date, shipping and fees; select ORDERED or PAID. Unknown shipping must be filled explicitly.
4. Confirm to create one Purchase with one PurchaseItem through the existing purchase domain service. The candidate becomes PURCHASED and links to that line in the same transaction.
5. Receive goods using the existing purchase receipt screen when they arrive. Conversion creates no inventory movements, balances or public listings, and does not disable watches.

Concurrent submissions and identical retries return the same purchase. Changed retry data is rejected. Only conversion can set PURCHASED. Converted source records and their purchase link are preserved; only manual check time can subsequently change. Cancelling or refunding a purchase preserves this history and never makes the candidate eligible for another conversion. Record a genuinely new offer separately. Sold, expired, rejected and unknown offers must be reviewed and marked available before conversion.

## Integration boundaries

`src/modules/marketplace-listings` owns validation, pure URL metadata adapters, price presentation, authorized queries and commands. The provider registry recognizes known offer paths for Mercari, Yahoo Auctions, Yahoo Flea Market, Rakuma and Suruga-ya, plus Mandarake provider identity. It performs no network access, page extraction or remote purchases. Unknown providers are supported through manual entry. Future connectors should supply candidates through the same validated service, preserve provenance, and obtain explicit administrator confirmation before purchase conversion.

Duplicate URL or provider/external-ID pairs are rejected per merchandise item. Known item-path URLs lose tracking queries and fragments for deduplication; unknown URLs retain their query because it may identify the offer. A stable creation ID supports retry-safe saves. Updates use versions to reject stale forms. Database constraints protect nonnegative monetary values, unique offer identities and conversion state; converted source records are protected by a database trigger. Dedicated public selectors continue to exclude all candidate, seller and private sourcing information.

## Deployment and validation

Apply additive migration `20260908180000_marketplace_candidates` with `npm run db:deploy`, then regenerate the Prisma client (`npm run db:generate`, also run by production build). Existing catalog, stock and purchases require no backfill.

Tests cover multiple offers, same-currency comparisons, Japanese text, provider URLs, duplicate detection, status updates, stale forms, explicit unknown shipping, atomic conversion, concurrent retries, source retention after cancellation, purchase receipt, authorization and public-data isolation. All integration tests use the isolated PostgreSQL test schema.
