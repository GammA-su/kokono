# Physical gacha fulfillment

Gacha rewards now follow `AWARDED → CLAIMED → PREPARING → SHIPPED → DELIVERED`. An administrator can cancel an `AWARDED`, `CLAIMED` or `PREPARING` reward. Dispatch cannot be cancelled or silently restocked. Historical `CONSUMED` rewards remain terminal legacy handovers; migration does not invent addresses, claims or tracking for them.

## Customer claim

The existing **View my prize** link opens `/gacha/rewards?reward=<id>` in kokoniv2. The customer signs in with the existing account, selects a saved address or enters an address, confirms it, and chooses **Claim for delivery**. The form uses the existing checkout address fields and mainland-France validation; it does not turn the prize into a SaleListing order or quote a shipping fee.

`POST /api/storefront/v1/gacha/rewards/:id/claim` accepts strictly `{operationKey, address}` through the existing authenticated customer gateway. The service verifies ownership and the configured email-verification policy, locks the customer and reward/banner, then creates a `GACHA` fulfillment request with an immutable address snapshot. It links the request and claim identity to the reward and appends an audit event. It does **not** create or increase inventory reservations.

The same customer/reward/key/address returns the existing claim, including after dispatch or delivery. A changed address or conflicting key is rejected. Concurrent submissions cannot create two claims. The browser disables duplicate submissions, retains the pending command on uncertain failure, and reads the existing reward to recover a successful claim whose response was lost. Reloading retrieves the authoritative claim; it never claims again automatically. Unavailable/other-owned IDs do not disclose addresses or tracking.

The owned reward detail API now includes its delivery address and actual shipment tracking. Public banner/odds selectors and immutable pull receipts still contain no customer address. History accepts the added reward statuses. The full collection interface remains separate; the current entry point is the existing pull result/history.

## Internal queue

Open `/admin/gacha/rewards` through **Gacha fulfillment** in the admin navigation. Queues show unclaimed, claimed, ready-to-pack, shipped, delivered, cancelled and legacy handovers. Counts use database aggregates; the oldest rewards appear first, with server-side pagination and customer email/merchandise/SKU search.

Open a reward to see the SKU, quantity, exact storage path, reservation state, customer, address snapshot, dispatch tracking and chronological customer/operator audit events. Links lead to catalog inventory movements and the original banner/configuration audit.

1. **Prepare for packing** moves `CLAIMED` to `PREPARING`.
2. Pick the specified reserved SKU from the displayed physical location.
3. **Record dispatch** requires the actual carrier, tracking number, note and explicit physical-dispatch confirmation.
4. **Mark delivered** records the delivery timestamp. Tracking is historical; a repeated dispatch with different tracking is rejected.

Cancelling before dispatch releases the original reserved unit without changing physical on-hand stock, replenishing gacha allowances or rerolling. Cancellation and dispatch race on the same banner/reward locks, so they cannot both succeed. Customer rewards can no longer bypass claims/tracking through the old internal-grant consumption button.

## Shared shipping and inventory

This reuses `FulfillmentRequest(origin=GACHA)` and `FulfillmentShipment`, which already serve normal customer orders. Normal orders and gacha now share `modules/fulfillment/shipping.ts` for dispatch/delivery records. Order payment validation and `SALE` movements remain in the order domain; gacha does not create an Order, OrderItem, payment or SaleListing.

`finalizeAwardInTransaction` is extracted from the existing gacha domain. It rechecks the original location against shared France fulfillable-location rules, consumes the existing confirmed reservation, creates exactly one immutable `GACHA -1` movement, links that movement, and updates the pull/reward. Dispatch and shipment creation commit in the **same transaction**. Missing tracking, inactive/ineligible storage or other failures roll back stock consumption and shipment creation together. Delivery makes no additional stock change. Duplicate dispatches return the existing result.

The Japan-to-France consolidation `Shipment` model stays separate from customer delivery. There was no shipping-label provider in the existing customer-order implementation, so this phase records actual carrier/tracking rather than adding a duplicate label integration. Shipping-fee collection, carrier purchasing/labels and returns are not introduced or represented as configured policies.

## Future grouping

`GachaReward.fulfillmentId` is a non-unique foreign key: one delivery request can eventually contain multiple rewards. Database guards require a single customer and coherent delivery states for a request. The current claim command creates one request for one reward. A future multi-reward claim can create a group transactionally before claims become immutable, without duplicating inventory or pretending that prizes are purchased order lines. Repacking existing claims into shipping groups is intentionally not implemented.

## Migration and invariants

Apply `20260912120000_gacha_fulfillment` with `npm run db:deploy`. It adds statuses, claim identity/timestamp and the fulfillment relation; existing reward ownership, receipts and physical allocations are preserved. No destructive data conversion is performed.

PostgreSQL guards protect immutable ownership/receipt, claim identity, address snapshots and dispatch history. Deferred constraints validate reward/pull/reservation state together with request/shipment state in both directions. Claim, preparation, dispatch, delivery and cancellation remain audited with customer or internal actor identity. Authentication, gateway/origin validation, bounded JSON, request keys and customer/client rate limiting reuse the established modules.

## Verification

`tests/customer-gacha.integration.test.ts` covers real award-to-claim, address snapshots, concurrent duplicate claims, duplicate dispatch, delivery retry, no normal order creation, immutable receipts, cancellation at each pre-dispatch stage, inactive locations, missing-tracking rollback, ownership, authentication/authorization, CSRF and the admin queue. Existing secure gacha, inventory and ordinary checkout/order tests remain in the regression suite.

`npm run test:customer-gacha-browser` now also verifies the real customer claim form, refresh recovery, and internal queue → prepare → dispatch → delivered actions using both production builds and an isolated PostgreSQL test schema. It checks the resulting request, shipment, reserved/consumed units and single `GACHA` movement. No real customer shipment or production inventory is used. Screenshots are under ignored `.local/customer-gacha-check`.

No dependencies were added. Paid gacha enablement is unchanged.

Verified completion: **328 backend tests** (31 files), **26 frontend tests**, both production builds/type checks, backend lint, and the extended real browser claim-to-delivery flow passed. The additive migration was applied to local `kokono_dev`. The browser run confirmed one dispatch movement, stock reduced by one, no Order created, and remaining rewards still reserved. Temporary test processes/data were cleaned up.
