# Customer checkout: France mainland, Stripe test mode

> Prompt 19A update: new checkout actions now require durable customer authentication and new orders receive Customer.id. Saved addresses and account history are available. Existing guest records are preserved. See [customer accounts](customer-accounts.md) for the current access/session policy; the guest-only description below documents the earlier implementation.

Implemented across the existing merchandise backend (`kokono-inv`) and existing React/Vite website (`../kokoniv2`). This document supersedes the checkout gaps in the earlier storefront integration review. There is one PostgreSQL database, one catalog, one inventory ledger and one customer order system. The only new production dependency is the backend Stripe SDK. No payment keys are exposed to Vite or the browser.

## Start locally

The new migration `20260909120000_customer_checkout` has been applied to the local development database. On another environment, run `npm ci`, `npm run db:deploy`, `npm run db:generate`, and rebuild the backend before starting it. Rebuild the existing website as well. The migration adds orders, immutable item snapshots, location reservations, payment attempts/events, fulfillment requests/tracking and audit events. It does not duplicate or modify existing physical inventory quantities, MSRP, listings, purchases or consolidation shipments.

The local `.env` files now share a generated server-only `COMMERCE_GATEWAY_SECRET`. Stripe keys remain blank and `COMMERCE_TEST_CHECKOUT_ENABLED=false`. Quotes can run with this configuration; HTTP order creation and payment initiation remain disabled. Keep `.env` out of source control.

Backend `.env`:

```dotenv
STOREFRONT_BASE_URL=http://localhost:5173
COMMERCE_GATEWAY_SECRET=<same private random secret as website>
COMMERCE_TEST_CHECKOUT_ENABLED=true
STRIPE_SECRET_KEY=<your Stripe sandbox sk_test_ key>
STRIPE_WEBHOOK_SECRET=<webhook signing secret, whsec_...>
```

Website `.env`:

```dotenv
COMMERCE_API_ORIGIN=http://localhost:3000
SITE_ORIGIN=http://localhost:5173
PORT=5173
HOST=127.0.0.1
COMMERCE_GATEWAY_SECRET=<same private random secret as backend>
```

Start `npm run dev` in each project. Use the exact configured website origin in the browser; `localhost` and `127.0.0.1` are different origins. Restart the servers after changing environment settings. `SITE_ORIGIN` and `STOREFRONT_BASE_URL` must match. There is no publishable Stripe key requirement because the server returns a hosted Checkout URL.

For local webhook forwarding, install/authenticate the official [Stripe CLI](https://docs.stripe.com/cli) in the same sandbox as the API key, then run:

```sh
stripe listen --forward-to http://localhost:3000/api/commerce/webhooks/stripe
```

Copy that listener's signing secret into the backend `.env`. For a deployed test environment, register the HTTPS **backend** endpoint `/api/commerce/webhooks/stripe` and use its own signing secret. The public website deliberately does not proxy this webhook. Subscribe to `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `refund.created`, `refund.updated`, `refund.failed` and `charge.refunded`. Card payments are the only enabled method in this MVP; delayed methods are not offered.

Live `sk_live_` keys and live webhook events are refused. Enabling live sales is a separate, deliberate rollout, not a configuration shortcut in this phase.

## Initial policy and tax snapshots

`src/modules/commerce/policy.ts` centralizes the business policy. `COMMERCE_POLICY_JSON` may override its fields; omitted fields retain defaults. Example:

```json
{"version":"fr-mainland-ttc-v1","currency":"EUR","zone":"FR_MAINLAND","supportedCountries":["FR"],"deliveryMethod":"Standard delivery — France","shippingAmount":590,"freeShippingThreshold":8000,"defaultVatRateBps":2000,"shippingVatRateBps":2000,"categoryVatRates":{},"reservationMinutes":60}
```

Amounts are integer minor units. Rates use basis points (`2000` = 20%). `categoryVatRates` can map existing category UUIDs to different rates. Each order stores the applied policy, each line stores its applied rate and included tax, and shipping stores its rate and included tax. Changes never rewrite earlier orders. Shipping methods/zones and tax selection can be extended at this domain boundary, with a new policy version and corresponding validators; Order's address/policy snapshots are not tied to a carrier schema.

Only `FR` shipping with five-digit mainland postal prefixes 01–19 or 21–95 is accepted. This implements **mainland** literally: Corsica (`20xxx`), overseas France, Monaco and non-France destinations are excluded. Validation checks required address fields and destination eligibility, not whether a street physically exists. The initial separate billing-address form uses the same mainland-France validation. No carrier or delivery estimate is promised.

Only published EUR listings explicitly marked `sellingPriceTaxInclusion=INCLUDED` can be purchased. Existing `UNKNOWN` or `EXCLUDED` prices need review in Store publication; no migration silently relabels historical prices. There is no FX conversion. Checkout accepts up to 50 distinct listings and 99 units per line; the saved browsing cart's broader limits remain unchanged and are validated at checkout.

Displayed listing prices are TTC. The backend derives net amounts using integer half-up rounding **per order line**, then stores VAT as the difference. It never adds VAT on top. Shipping is 590 cents TTC below an 8000-cent merchandise subtotal, otherwise zero. Shipping uses its own included-VAT calculation. EUR 74.00 of products therefore totals EUR 79.90, and EUR 84.00 totals EUR 84.00. The Stripe charge is the exact snapshotted TTC total, with automatic tax and promotions disabled; this phase does not generate tax invoices or use Stripe Tax. Backend snapshots, rather than Stripe's tax-report UI, are the source for the configured included VAT.

## Customer flow and access

The existing CartDrawer links to `/checkout`. The browser submits listing UUIDs and quantities, plus contact/address data. It sends no authoritative price, tax or shipping amount. A quote lasts ten minutes and reserves nothing. On explicit acceptance, the backend rechecks current listings, prices, policy and available stock. Changed pricing/policy returns a replacement quote requiring a new acceptance. Insufficient stock aborts the whole checkout. One operation UUID and one quote identity prevent repeated submissions creating duplicate orders.

The order page `/orders/:id` reads a dedicated customer projection. Contact, address, historical line prices, totals, status and customer tracking are available only with the owning guest credential. Inventory locations, actor IDs, costs, PurchaseWatch and sourcing data are excluded. The website keeps a random 256-bit guest credential in a host-only HttpOnly, SameSite=Lax cookie (Secure over HTTPS); the database stores its hash. The raw token never enters URLs, SSR data, JavaScript storage or public metadata. An order UUID alone grants no access. Checkout/order documents are noindex and no-store, and responses use no-referrer.

Guest access currently lasts as long as this browser's cookie (30 days); account login, email receipts and email-based order-access recovery are not implemented. If cookies are lost, the customer must contact the operator with their order number; an internal operator must verify identity before sharing details. Internal Better Auth accounts are never treated as customer accounts. Saved cart intent is retained until the customer removes it, including after payment.

The public Node gateway forwards only enumerated commerce routes, injects its own server secret and guest bearer, and never forwards the browser's authorization header or internal cookies. Mutations require the exact configured Origin. It bounds JSON to 16 KiB and limits mutations to 60 per connection IP per ten minutes, with a bounded in-memory map. Backend quotes additionally have a durable 60/hour guest limit and three active pending orders per guest. For multiple website replicas or a reverse proxy, configure shared edge rate limits; the gateway deliberately does not trust arbitrary forwarded IP headers. API limits, credentials, request bodies and customer PII must not be logged by deployment proxies.

## Stock and fulfillment

Reservations allocate actual balances from the existing `fulfillableLocationIds(...,"FRANCE")` resolver. Japan, transit, inactive ancestry, unknown/foreign geography and disabled fulfillment are excluded. The same canonical item locks are used by checkout and the inventory domain. No separate stock counter exists.

- `HELD`: unpaid, expiring allocation; physical balances remain unchanged.
- `CONFIRMED`: verified paid allocation, with no expiry.
- `RELEASED`: cancelled, expired or failed checkout; no physical stock change.
- `CONSUMED`: dispatched allocation linked to its immutable `SALE` movement.

Public availability is eligible physical stock minus active allocations, using the existing aggregate selector with a shared reservation SQL helper. Expired holds stop reducing availability immediately even before cleanup. Internal owned/fulfillable-physical metrics remain physical counts. Every existing outgoing ledger operation—including transfers, adjustments, damage, loss and gacha removals—checks unreserved source stock under the same locks.

`/admin/orders` provides filters and server-side pagination. The detail shows historical delivery/billing information, actual location paths, allocations, payment reconciliation facts, tracking and actor audit. Operations support preparation, full dispatch, delivery, cancellation and full test refund. Dispatch requires actual carrier/tracking and a complete eligible allocation; it creates exactly one `SALE` movement per allocation and decrements physical stock in the same transaction. Stable allocation operation keys prevent repeated deductions. If a reserved location is disabled, resolve the eligibility issue or cancel/refund before dispatch; stock cannot silently move around a paid reservation.

`FulfillmentRequest` has an explicit `ORDER` or future `GACHA` origin and a generic tracking record. It is customer delivery, distinct from the existing Japanese consolidation `Shipment`. Future physical gacha rewards can use that same fulfillment/tracking structure without fabricating SaleListings, prices or customer orders. No gacha reward engine or second inventory ledger is introduced.

## Payment reconciliation and refunds

Payment attempts are durable before calling Stripe; all provider network calls run outside transactions. Session creation uses `checkout-attempt:<attemptId>` for Stripe idempotency and immutable order data. A timeout can be retried from the same order. Duplicate verified events commit only once; amount/currency/session/payment identities are checked. Browser return query parameters have no effect on payment state.

An unpaid hold defaults to 60 minutes. Stripe requires a new Checkout Session's expiry to be at least 30 minutes away, so this implementation refuses starting a new session with less than 31 minutes remaining. Cancel that unpaid checkout and request a fresh quote; an existing session may continue until its original expiry. See the [Checkout Session API](https://docs.stripe.com/api/checkout/sessions/create). Losing the network response does not authorize creating a different payment attempt.

Payment confirmation retains physical stock and confirms reservations. A payment arriving after expiry/cancellation or after location eligibility changed is marked `REVIEW`, releases remaining holds, and cannot dispatch. An operator must refund or reconcile it. Cancellation of a paid, undispatched order releases reservations and marks `REFUND_PENDING`; the operator then explicitly requests the full refund. A refund after dispatch preserves physical stock and tracking; returned goods must be received through the existing inventory service after inspection.

Partial shipment and app-initiated partial refunds are rejected. Externally issued partial refunds retain their verified amount/event and place payment in `REVIEW`; a second full app refund is refused. Charge notifications and reconciliation sum only succeeded refunds from Stripe; pending refunds never count as settled. More than 100 refunds on one payment require manual reconciliation. Refund notifications load the current Stripe refund resource to handle out-of-order delivery. Event rows preserve individual facts and must not be summed because refund and charge events overlap. Later paid events do not clear that review or release a confirmed allocation. A refund failure also requires review.

## Scheduled maintenance and deployment

Run the backend command at least once a minute through your scheduler, with one job at a time:

```sh
npm run commerce:maintenance
```

Each invocation expires up to 100 pending orders, reconciles up to 100 payment attempts (oldest updated first), and removes unconsumed quotes older than 30 days. Reconciliation checks existing provider refund state before retrying a lost refund response, retries interrupted session/refund creation with stable provider keys, observes completed/expired Stripe sessions and refunds, and expires cancelled sessions. It prints aggregate counts only and exits nonzero if a payment reconciliation failed. Monitor job failures and the admin payment `REVIEW`/`REFUND_PENDING` filters. Run additional bounded invocations if the backlog is greater than one batch. The command still cleans expired reservations while payment configuration is disabled. No unauthenticated HTTP cron route exists.

Both applications require Node runtimes. Deploy the migration before either new application version, retain the existing persistent image volume and PostgreSQL backups, and grant the application role the required new-table operations without schema-owner privileges. Orders, lines and audit events cannot be destructively edited/deleted through the app; database triggers also protect immutable history, reservation capacity and consumed-allocation ledger links. A production backup/restore test and operational monitoring remain deployment responsibilities.

## Verification and remaining external setup

Automated database tests use isolated `_test` schemas and apply every real migration. Coverage includes TTC rounding/thresholds, address/currency policy, quote changes, history immutability, complete rollback, last-unit concurrency, France/Japan/transit eligibility, all outgoing ledger protections, guest/admin authorization, expired holds, retries, partial-refund review, late/duplicate/failed payments, multi-location dispatch, immutable SALE links and no restock on refund. The real Stripe SDK verifies test webhook signatures offline; a fixture provider exercises domain failure paths without network calls.

```sh
# Backend
npm run db:validate
npm run typecheck
npm run lint
npm test
npm run build
npm run test:storefront-http

# Existing website
npm run build
npm test
npm run test:browser
npm run test:checkout-browser
```

The real two-application HTTP check exercises quotes, guest order access, reservation-aware product availability and cancellation against an isolated PostgreSQL database. Browser tests exercise the real website/proxy with a test backend fixture: cart handoff, explicit changed-price acceptance, protected order access, forged success URLs, Stripe redirect, cancellation and desktop/mobile layout. Browser screenshots are test artifacts, not published assets.

**An actual Stripe-hosted sandbox payment was not run: API and webhook credentials are absent.** After configuring them, use a reviewed EUR/TTC listing with eligible France stock; create a checkout, pay in hosted Stripe Checkout using [Stripe's test-card instructions](https://docs.stripe.com/testing), wait for the signed webhook to show PAID, then prepare/dispatch/deliver in admin. Verify stock remains physical until dispatch, retry actions, test cancellation/full refund, and run maintenance with a temporarily interrupted webhook. The standard test Visa number is `4242 4242 4242 4242`, with a future expiry and a test CVC. Never use real card details for this test. No code path enables live payments in this phase.
