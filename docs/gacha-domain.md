> Prompt 18.75 adds customer execution, recovery and owned rewards using this domain. See [customer-gacha.md](customer-gacha.md) for the current contract, explicit free authorization and configuration. Paid draws remain disabled. The original internal domain design below is preserved.

# Internal gacha domain

Admin entry point: `/admin/gacha`. Public odds: `/gacha/:slug/odds` on the merchandise-manager host, with a read-only JSON representation at `/api/storefront/v1/gacha/by-slug/:slug/odds`. The separate storefront now integrates the downloaded gacha design at `/gacha`, with public banner discovery and this odds selector. See `D:/Project/kokoniv2/docs/gacha-integration.md`. Checkout remains separate. No public draw or payment endpoint is introduced.

## Policy and operation

This phase supports **administrator-granted, no-charge draws only**. A grant requires a customer reference, an operator, a reason, an operation key and the reviewed configuration ID. The customer reference is an explicit opaque recipient identifier, not an assertion that an internal operator is a customer or that a customer is eligible for a particular business model. Eligibility, customer authentication, paid participation, payment/refund rules and any legal business model must be defined before enabling a customer-facing draw flow.

`GACHA_DRAWS_ENABLED=false` stops new grants globally, including active banners. Finalizing or cancelling existing awards remains possible. Paid draws are disabled by both validation and a database constraint; a stored future pull price is metadata and never charges a customer. There is intentionally no environment variable that can enable an unfinished paid flow. No age, jurisdiction or commercial entitlement is inferred.

## Exact odds and immutable versions

Each prize has a positive integer weight. Selection draws a uniform integer in `[0,totalWeight)` with Node's server-side `crypto.randomInt`, then selects its fixed, ordered interval. Weight 1 against weight 9 is exactly 1/10 and 9/10. Every admin/public view uses the same rational calculation. Non-exact decimal percentages are explicitly labelled rounded; fractions remain authoritative.

Editing a banner creates a new `GachaConfiguration` and new `GachaPrize` rows. The immutable JSON snapshot includes public names, terms, schedule, weights, order, allocations and the selection algorithm. A SHA-256 digest identifies that snapshot. Historical versions, prizes, pull audit fields and events cannot be changed or deleted through normal database writes. A pull stores its random ticket, algorithm, selected prize, customer reference, operator, configuration, timestamp, terms version and interval bounds. Status changes have append-only actor/reason events. Database checks validate that the recorded ticket belongs to the awarded prize interval and that the award retains its reservation.

The digest and recorded ticket support audit replay; they do not claim an independently verifiable randomness proof. Production selection accepts neither a caller-supplied ticket nor a random-number callback. Simulators use the same secure selection probabilities but sample with replacement, explicitly ignoring depletion. They perform no writes and create neither real pulls nor rewards.

## Physical backing and concurrency

`InventoryReservation` is the existing shared stock-reservation model. Its owner is now exactly one of an order item or a gacha prize. A gacha allocation uses one `CONFIRMED`, non-expiring reservation per unit. This deliberately uses the established stock locks, aggregate reservation selectors and inventory ledger rather than another stock system.

Saving a configuration atomically reserves **all** allocated units, including when the banner is paused. Eligible stock is selected with the existing France fulfillment-location policy, using configured country, active hierarchy and fulfillment flags. Japan, transit and other ineligible storage cannot back this initial implementation. Normal storefront availability excludes these reservations. Ordinary transfers, removals and checkout cannot consume them. Pools are limited to 100 prizes and 2,000 allocated units per version; larger-volume or lot-based pools would need an explicit extension rather than unbounded unit-row creation.

Grants serialize on the banner and the shared canonical merchandise locks, then claim one pre-reserved unit transactionally. Repeating an operation key returns the original award; changing its recipient, actor or request is rejected. A stale configuration ID is rejected before selection. Two contenders for the last unit cannot both win.

Weights never change because of stock. **When any configured prize has no unawarded allocation, the entire banner stops drawing.** There is no reroll, hidden renormalization or automatic substitution. Location/catalog ineligibility also stops draws. Public odds continue displaying the unchanged weights alongside the current stopped state.

Pause retains stock. Release pool pauses and releases only unawarded allocations. A new configuration releases the prior version's unawarded stock and reserves the replacement pool in one transaction; shortage rolls the entire change back. Existing awards retain their original version and reservation. Released units never silently re-enter the same version.

## Award lifecycle

- `RESERVED`: awarded to the recorded recipient; physical stock remains owned and unavailable to ordinary checkout.
- `CONSUMED`: operator confirms actual physical handover/dispatch. The existing inventory service creates exactly one `GACHA` movement, with `referenceType=GACHA_PULL`, `referenceId=pull.id` and stable operation key `gacha-award:<pullId>:consume`. Reservation and pull finalize atomically. Repeated finalization does not deduct again.
- `CANCELLED`: explicit reason releases the reserved unit to ordinary inventory, with an immutable event. It does not reroll, refill the pool, or create a sale/refund.

Finalized awards cannot silently change outcome or status. Consumption requires eligible storage at dispatch time. Shipment/customer delivery automation is not implied by recording a handover. Future fulfillment should use the existing fulfillment services and their GACHA origin support, without fabricating a SaleListing order.

## Migration and verification

Apply `20260909140000_gacha_domain` using `npm run db:deploy`, then regenerate the Prisma client (`npm run db:generate`, also part of `npm run build`). The migration adds gacha tables and optional gacha ownership columns to existing reservations, makes `orderItemId` optional, and extends shared reservation/consumption guards. Existing order rows retain their order ownership. No inventory balances, MSRP, purchase costs or listing prices are rewritten. Deploy the schema and updated application together; older generated Prisma clients assume non-null order ownership and must not process gacha reservations.

Tests:

```text
npm test
npm run typecheck
npm run lint
npm run build
npm run test:gacha-http
npm run test:gacha-browser
```

HTTP/browser verification starts an isolated production server and a unique schema in `TEST_DATABASE_URL` (must end in `_test`). It cleans up its own schema and server. Browser verification reuses the existing neighboring website's Playwright installation; set `PUBLIC_WEBSITE_PATH` if necessary and `PLAYWRIGHT_CHANNEL=msedge` where Chromium is not installed. It does not add a runtime dependency or create demonstration rewards in the development catalog.

Coverage includes exact probabilities, secure entropy interface, shortage rollback, stale versions, immutable snapshots/audits, fixed odds after depletion, shared reservation protection, concurrent last prize, idempotent grant and consumption, location/policy gating, cancellation/release, public-data isolation and a 100,000-draw simulation without database effects. The existing commerce integration suite also exercises the generalized reservation triggers.
