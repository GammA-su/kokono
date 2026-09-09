> Physical claims and delivery are now implemented. See [gacha-fulfillment.md](gacha-fulfillment.md) for the current claim API, statuses and shared shipping workflow. The original execution report below remains historical.

# Customer gacha execution — Prompt 18.75

The existing kokoniv2 gacha design now calls the authoritative kokono-inv domain. Customer execution is **off by default**. This phase implements administrator-authorized, no-charge single pulls only. It does not create a paid offer, use Stripe checkout as gacha authorization, infer a legal model, or introduce gems, balances or purchasable tickets.

## Configuration and use

1. Deploy both applications and run `npm run db:deploy` in kokono-inv. Migration `20260911120000_customer_gacha` is additive; old administrator grants remain intact and are not automatically assigned to customers.
2. Reuse the customer account gateway configuration from [customer-accounts.md](customer-accounts.md). `COMMERCE_GATEWAY_SECRET` must match across applications and `STOREFRONT_BASE_URL` must match the public site's configured origin. No administrator cookie is used by kokoniv2.
3. For deliberately enabled no-charge execution, set `GACHA_CUSTOMER_EXECUTION_ENABLED=true` in the backend runtime and restart it. `GACHA_DRAWS_ENABLED=false` remains the shared emergency stop. Neither flag overrides banner, customer or inventory eligibility.
4. In `/admin/gacha/:id`, explicitly enable authorized free customer pulls. Configure a reviewed, active pool backed by controlled France fulfillable stock and clear no-charge terms. Existing future price metadata is not a live paid offer.
5. Grant an authorization using the durable customer ID displayed in `/admin/customers`: 1–100 pulls, an expiry within 30 days (entered as UTC), and a required reason. The authorization and operator are immutable audit records. Submitting the same authorization operation key twice does not add an allowance.
6. The signed-in customer opens `/gacha/:slug`. The single-pull button enables only after the private eligibility response confirms the current version, stock readiness and remaining allowance. Email verification follows the existing `CUSTOMER_REQUIRE_VERIFIED_EMAIL` policy. The button describes the operation as an administrator-authorized free pull. ×10 stays disabled.

To stop execution, disable the banner's customer permission, pause the banner, disable the customer account, or turn off the server flag. Already awarded rewards remain recoverable. Individual authorization grants expire; cancellation of an awarded prize does not replenish its consumed authorization or reroll the pool.

No flags, banner permissions or free allowances are enabled automatically in the development database. The automated test path below enables them only inside an isolated test schema/runtime. Never point that script at production inventory.

## API contract

All paths are under `/api/storefront/v1/gacha`. Existing public `GET /banners` and `GET /by-slug/:slug/odds` remain read-only and public-safe. Customer paths require the trusted storefront gateway plus a valid customer session, return `Cache-Control: no-store`, and do not accept internal sessions.

| Method / suffix | Contract |
| --- | --- |
| `GET /banners/:id/eligibility` | `enabled`, `reason`, `mode: ADMIN_AUTHORIZED_FREE`, `paidEnabled: false`, `supportedCounts: [1]`, `remaining`, `bannerId`, `configurationId` |
| `POST /banners/:id/pulls` | Strict JSON `{configurationId, requestKey, count: 1}`; returns a saved receipt |
| `GET /pulls/:id` | Own immutable receipt; 404 for another customer's ID |
| `GET /requests/:requestKey` | Resolve the authenticated customer's request identity without executing a pull |
| `GET /pulls?page=N` | Paginated own pull/reward summaries |
| `GET /rewards?page=N&status=AWARDED` | Same summary envelope; optional `AWARDED`, `CONSUMED`, `CANCELLED` filter |
| `GET /rewards/:id` | Own reward summary including its immutable receipt |

History/reward pages contain at most 20 rows, ordered by creation date and ID. They use `{items, pageInfo: {page, size, total, pageCount}}`. Each row contains only `{id, status, quantity, updatedAt, receipt}`. Receipt content is snapshotted once:

```ts
{
  pullId, bannerId, configurationId, configurationVersion,
  banner: { id, slug, name },
  createdAt,
  prizes: [{ id, rewardId, name, tier, description, image: {id, url, alt} | null }]
}
```

The existing frontend `parsePullReceipt` whitelists its presentation fields. It preserves server result order and identities. No RNG result, raw weights, source/cost data, reservation location, operation key, customer credential, authorization ID or internal actor is included in receipts/history. A client request key is accepted input, not public receipt metadata.

Images are explicitly approved, managed merchandise images. Receipts retain the selected public image ID/URL/alt text; an approved receipt image may be served without creating a SaleListing. Revoking its public approval stops image delivery without rewriting the historical receipt. External sourcing URLs and unapproved images are never used as public prize images. An unavailable historical image uses the existing frontend fallback.

## Execution, ownership and concurrency

`createGachaCustomerAdmin` owns free authorization and banner permission. `createCustomerGachaService` authenticates, rate-limits and validates execution. It calls `awardInTransaction` extracted from the existing administrator grant service; administrator and customer grants use the same `secureSelection`, fixed weights, pool readiness and pre-reserved physical units.

The transaction locks the customer, revalidates the session, resolves any prior request, locks the banner, validates the current reviewed configuration and authorization, then acquires the existing canonical merchandise locks. Selection uses `node:crypto.randomInt`. The transaction creates the pull, attaches its unique physical reservation, creates the owned reward and immutable public receipt, and appends a customer audit event. Authorization consumption is the count of linked persisted pulls, not a mutable browser balance.

`GachaPull` adds nullable `customerId`, `requestKey`, `authorizationId`, with a unique customer/key pair. An execution is either an original internal actor grant or a durable customer execution, never both. `GachaAuthorization` links customer, banner, operator, maximum uses, expiry and reason. `GachaReward` links customer, pull, prize, merchandise and a unique existing reservation, with quantity one and an immutable receipt. Foreign keys, unique indexes and deferred PostgreSQL guards keep ownership, authorization, receipt and physical backing consistent at commit.

Awarding does not decrement physical stock again: the pool was already reserved by Prompt 18. These confirmed reservations remain unavailable to ordinary checkout. Existing internal finalization creates a `GACHA` inventory movement on physical consumption, or releases a cancelled reservation, and now synchronizes the reward status (`CONSUMED`/`CANCELLED`). This reuses existing operations; it is not the future customer shipping/claim workflow.

If any configured prize is depleted, all new draws stop. No weights are redistributed and there is no replacement/reroll. New configuration edits preserve old configuration versions, awards and receipts. A request referencing an old configuration is rejected before selection; the customer must reload and review the active odds. The active configuration is always authoritative.

## Idempotency, recovery and frontend

The logical request is scoped by durable customer plus UUID `requestKey`. A matching retry returns the exact saved receipt even if the banner is now disabled, depleted, or has a new configuration. A reused key with changed payload is rejected. Different customers may safely use the same UUID. Retry and recovery still require a valid owned account session; account disabling is not bypassed.

Request-key recovery waits for an in-flight transaction holding the same customer lock before returning a result or 404. If the request never reached the server (or recovery arrives before it), the frontend retains the key and offers an explicit identical retry. A 404 is not proof that a delayed POST can never arrive. Recovery itself never invokes RNG or POST.

kokoniv2's existing `GachaExecution`, reducer and `useGachaFlow` are extended rather than duplicated. `customerGachaExecution` uses allowlisted same-origin customer gateway routes. The existing pending intent remains in session storage until the receipt is confirmed. Refresh automatically GETs the pending request identity or saved pull ID, never automatically POSTs. Definite pre-execution validation failures release the pending intent; timeout, transport failure, rate limit and uncertain authentication errors preserve it. Existing Skip, replay, result and reduced-motion paths operate on the same validated receipt.

The reveal/controller is remounted on durable customer identity changes, and an unmounted request cannot persist a receipt into the next customer's browser state. Server ownership checks remain authoritative. History now loads real paginated results inside the existing dialog. `/gacha/rewards` remains the protected collection placeholder for Prompt 20.5. No visual redesign, dependencies or animation/RNG engine were added.

## Security boundary

- Customer sessions, expiration, account disabling, password-reset revocation and optional email verification reuse Prompt 19A. No admin impersonation or guest checkout ownership.
- Trusted gateway secret and exact mutation origin checks at both applications; host-only HttpOnly SameSite customer cookies; no browser-provided admin or forwarded IP headers.
- Strict UUID/JSON validation, 4 KiB backend command limit, single-pull-only schema; caller-supplied prize, rarity, payment, weight or inventory input is rejected.
- Durable per-customer limit of 20 pull attempts/minute plus a gateway-derived client limit of 60/minute. Failed mutations still count; recovery is read-only and not charged against pull allowance.
- Ownership filtering on every receipt/reward/history read, generic 404 for another owner's IDs, public DTOs and no-store responses.
- Atomic shared inventory reservations and immutable database-backed audit/snapshots; no direct balance writes in customer handlers.

## Verification and completion report

1. **Identity:** reused `Customer`/`CustomerSession`; internal Better Auth remains separate.
2. **Routes:** seven customer routes above, existing public banner/odds reads, and the storefront's restricted session gateway.
3. **DTOs:** immutable public receipt plus private-to-the-customer eligibility/history/reward projections.
4. **Execution:** explicit free authorization, shared secure domain, atomic pull/reservation/reward/audit.
5. **Idempotency:** unique customer/request identity, payload fingerprint conflict detection, idempotent administrator authorization grants.
6. **Recovery:** owned pull ID or request key; refresh and lost-response recovery never reroll.
7. **Ownership:** durable `GachaReward`, immutable receipt, real customer FK and unique physical reservation.
8. **Inventory:** existing reserved France fulfillable units; no new inventory system; existing finalization synchronizes reward state.
9. **Versioning:** exact existing configuration ID/version/digest audit; stale requests rejected and historical snapshots preserved.
10. **Security:** session/origin/gateway, bounds, rate limits, IDOR protection, immutable DB constraints and public data isolation.
11. **Payment:** no-charge, administrator-authorized only. Monetary gacha stays disabled; ordinary Stripe checkout does not authorize gacha.
12. **Frontend:** real adapter, private eligibility gating, request-key recovery, identity reset and real history; existing design/reducer/reveal retained.
13. **Tests:** `tests/customer-gacha.integration.test.ts` covers execution, duplicate/concurrent pulls, ownership, disabled/scheduled/depleted banners, verification, allowances/expiry, snapshots, public media, authorization, request bounds, rate limits, history and finalization. Frontend tests add real transport contract, capability validation and uncertain/definitive failure recovery. Existing gacha suites are retained.
14. **Real E2E:** `npm run test:customer-gacha-browser` starts both production builds against a unique PostgreSQL `_test` schema, signs in a real customer, performs real pulls, verifies exact saved rewards/reservations and public images, refreshes during the actual portal, deliberately drops a successful response, recovers by key, tests Skip/replay, keyboard and mobile reduced motion, and checks real history/reward APIs. No fixture execution, real payment or production inventory is used. Schemas, test media and owned server processes are cleaned up. Screenshots are under ignored `.local/customer-gacha-check`.
15. **Production state:** off by default; no existing banner or customer is auto-enabled. Explicit free configuration is supported; paid pulls and ×10 remain disabled.
16. **Remaining:** Prompt 20 owns customer claim/shipping/fulfillment; Prompt 20.5 owns the final My Prizes collection UI. Paid entitlement/business policy and atomic multi-pull require separate approved work.

Run backend `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, then `npm run test:customer-gacha-browser`. Run kokoniv2 `npm run build`, `npm test` and `npm run test:gacha-browser` (`PLAYWRIGHT_CHANNEL=msedge` where needed). The test script reads `TEST_DATABASE_URL`, requires a database name ending `_test`, refuses the development database, and never falls back to development inventory.

Verified in this implementation: **321 backend tests across 31 files**, **25 frontend tests**, both production builds, backend type checking/lint, the existing visual gacha browser suite, and the real customer gacha E2E all passed. The additive migration was applied successfully to local `kokono_dev` (15 migrations present). Runtime customer pulling remains opt-in; no real email, payment or production inventory was used.
