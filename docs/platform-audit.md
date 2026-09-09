# Merchandise platform audit — 9 September 2026

> Historical audit snapshot. Prompt 23 revalidates and updates performance, image validation, runtime/proxy configuration and operational evidence in [production-readiness.md](production-readiness.md). Do not treat the original open findings below as the current disposition without that follow-up.

The architecture keeps catalog identity, ownership, selling, sourcing, and gacha rewards separate. The reviewed application paths preserve the inventory ledger and share reservations between checkout and gacha. Five new regression tests and the existing integration suites support those conclusions.

**The evidence does not support production readiness.** A local dataset at the requested catalog scale caused public listing and dashboard transaction timeouts. Image validation and deployment controls also need further work. No rewrite, production deployment, live payment, or production inventory mutation was performed.

## Scope and evidence

Reviewed `D:\Project\kokono-inv` and `D:\Project\kokoniv2`: implemented domain module families, schemas and migrations, administrative actions and routes, public selectors and gateways, authentication, UI integration, tests, and operational scripts. Traced the 17 requested workflows through their principal service, transaction, and projection boundaries. This is a risk-focused source and functional audit, not a claim that every source line has been exhaustively verified or that a deployed environment has passed penetration testing.

The working tree already contained extensive implementation changes before this audit. The audit-specific edits are listed below; the entire Git diff must not be attributed to this audit. No storefront source files were changed.

Evidence includes real PostgreSQL regression tests, two-application HTTP verification, a real browser gacha/fulfillment scenario, production builds, production dependency scans, and a disposable scale fixture. External services were represented by fixtures or disabled where specified; their production operation remains unverified.

## 1. Architecture

| Boundary | Existing implementation | Assessment |
|---|---|---|
| Authoritative application | Next.js 16 App Router, React 19, TypeScript, Prisma 7 with `pg`, PostgreSQL; `src/modules/*` services behind server actions and API routes | A modular monolith is appropriate. No need to split into additional services for this scope. |
| Catalog | `Franchise → Lineup → MerchandiseItem`; character junctions, categories, sources, images, partial dates | One merchandise identity, usable without stock or a listing. |
| Inventory | `StorageLocation`, `InventoryBalance`, immutable `InventoryMovement`, shared `InventoryReservation` | Command services own mutations; checkout and gacha contend for the same availability. |
| Sourcing and costs | PurchaseWatch, MarketplaceListing, Purchase/PurchaseItem, international Shipment/ShipmentItem, versioned landed-cost calculations | Purchasing, physical transport, and valuation are separate records with explicit references. |
| Publication | Optional, unique SaleListing per merchandise item; reviewed public content and selected approved images | Reuses catalog identity rather than introducing a duplicate product catalog. |
| Commerce | Authoritative quotes, order snapshots, payment attempts/events, reservations, shared fulfillment records | Browser prices and cart contents are intent, not accounting authority. Stripe integration is explicitly test mode. |
| Gacha | Versioned configurations/prizes, exact weights, server cryptographic selection, immutable pulls, customer rewards and reservations | Physical dispatch uses the existing inventory ledger and shared fulfillment shipment infrastructure. |
| Public website | React/Vite/TypeScript with CSS Modules, custom Node SSR server and same-origin backend gateways | A separate presentation application, not another database or checkout engine. Requires its Node server; static-only deployment would omit required behavior. |
| Authentication | Better Auth for provisioned internal accounts; separate customer accounts, durable sessions, reset/verification workflows | Customers do not reuse internal sessions. Domain mutations recheck internal authorization. |
| Media and operations | Managed runtime image volume, public approval checks, environment configuration, maintenance scripts | Persistence, backup, scheduling, TLS and deployment ownership must be proven operationally. |

The custom `SequentialPrismaPg` adapter serializes queries within an interactive transaction to address the existing concurrent-`pg.query()` warning. Tests guard that boundary. Preserve those checks during Prisma/pg upgrades. Parallel requests may use different pool connections; serializing one transaction is not global request serialization.

## 2. Workflow trace

Paths below are relative to the backend repository unless stated otherwise. “Verified” means source tracing plus the cited test coverage, not an external production transaction.

| # | Flow and implementation | Observed behavior and limits |
|---|---|---|
| 1 | Official discovery — `src/modules/assisted-import/{outbound,service,matching,review-token}.ts`, `adapters/*` | HTTPS download validation and DNS pinning precede extraction. Administrator-reviewed candidates retain Japanese text and provenance; selection precedes catalog insertion. Current adapter registry contains the generic structured-data adapter, not bespoke working adapters for every named manufacturer. Unsupported pages need manual entry. Fixture-tested, no live marketplace scraping. |
| 2 | Lineup creation — `src/modules/lineups/{service,validation,queries}.ts`, `/admin/merchandise/lineups` | Franchise relation, multiple sources, partial release dates, edit/version checks and redirect into detail are implemented. Archive preserves related data; deletion is constrained rather than cascading history away. |
| 3 | Bulk entry — `catalog/bulk-entry.ts`, `catalog-csv/*`, `bulk-management/*` | Grid validation, duplicate review and CSV import policies reuse catalog services. CSV imports no inventory. Bulk stock actions use ledger commands and return per-item results; an operation's atomicity is distinct from a whole batch's partial-success policy. Entire-lineup selection is server-resolved with an explicit size limit, not merely visible rows. Large batches remain bounded. |
| 4 | PurchaseWatch — `watchlist/*`, catalog services | Independent one-to-one sourcing intent; target gap is `max(target − all owned, 0)`. Zero-stock watches and stocked watches both work. External marketplace links are search actions, not scraping or purchase execution. |
| 5 | Purchase recording — `purchases/*`, `marketplace-listings/*` | Multiple purchase lines, currency, condition, supplier/reference and costs are stored without changing inventory. Candidate conversion creates purchase records, not receipt movements. Editable states and cancellation constraints protect received purchases. |
| 6 | Receive in Japan — `purchases/service.ts → inventory/operations.ts` | Receipt creates PURCHASE movements with acquisition cost/reference/actor and atomic balances. Stable purchase-line receipt identity prevents duplicates. Destination is explicit; `RECEIVED_JAPAN` reflects Japanese receipt. Current receipt flow receives a whole purchase line, not partial installments of that line. |
| 7 | Japan → transit — `shipments/service.ts` | Draft availability is validated, then revalidated at dispatch. A dedicated transit child location isolates each shipment. Stable operation keys transfer stock atomically with audit linkage. Draft creation does not reserve stock: another command may use it before dispatch. |
| 8 | Transit → France — `shipments/service.ts` | Delivery moves the shipment's transit stock to the selected active French placement, including a final box. Retries do not repeat the transfer. Total ownership is preserved. Cancellation after physical dispatch is restricted; reverse logistics need an explicit workflow. |
| 9 | Physical home storage — `locations/{service,queries}.ts`, inventory/item detail | Hierarchical paths, cycle prevention, active ancestry, explicit fulfillment flags and geography are shared. Stock in an inactive location remains physically owned and auditable, but is excluded from eligibility. Parent location names do not determine storefront availability. |
| 10 | Landed cost — `landed-costs/{service,math,queries}.ts` | Quantity, weight, item value and manual allocation use safe minor-unit/BigInt arithmetic, explicit FX inputs and historical calculation records tied to shipment/acquisition evidence. Missing weights/costs are not invented. Remaining on-hand inventory is not fully allocated to acquisition lots, so aggregate landed inventory value is still unavailable. |
| 11 | SaleListing publication — `publication/{service,validation,policy,queries}.ts`, `/admin/publication` | Review creates/updates the item's unique listing, validates public content/category/price/images, and preserves existing edits. Stock zero is allowed. Unpublish retains item, listing and ledger. Revoked image approval and archived catalog ancestry affect public visibility. |
| 12 | Public availability — `publication/queries.ts`, storefront HTTP and kokoniv2 gateways | Dedicated safe DTOs expose France-eligible stock minus active reservations. Japanese/transit/private location detail stays out of storefront responses. Zero available stock remains visible for eligible published listings. Real two-application HTTP checks passed, but the list service timed out at scale. |
| 13 | Standard order — `commerce/{policy,service,payments,stripe,http}.ts`, customer gateways | Backend quote snapshots EUR/TTC merchandise, included VAT, configured France-mainland shipping, address and totals. Customer checkout reserves transactionally; changed quotes require acceptance. Test Stripe signatures and payment state transitions are covered. No external Stripe checkout/payment was performed in this audit. |
| 14 | Sale movement — commerce dispatch and shared `fulfillment/shipping.ts` | Verified payment confirms reservations; dispatch consumes allocated stock with SALE movements and shipment records. Cancellation/refund handling respects state; refund does not silently restock a dispatched item. Late/uncertain payment reconciliation requires operational maintenance. |
| 15 | Gacha award — `gacha/{service,customer-service,probability,odds}.ts` | Trusted server selects with cryptographically secure randomness and exact weights. Pulls preserve configuration/version and immutable audit evidence. Customer operation keys and result recovery preserve the award. Pool depletion stops draws instead of silently changing configured relative odds. |
| 16 | Gacha inventory — gacha services and `inventory/reservations.ts` | Pool allocations reserve real eligible stock. Award takes an existing allocation; it does not reserve the same unit again. Physical dispatch creates GACHA consumption. A new checkout-versus-gacha race test confirms only one can acquire the final shared unit. |
| 17 | Gacha fulfillment — `gacha/{fulfillment,fulfillment-queries}.ts`, `/admin/gacha/rewards` | Customer ownership guards claim/address access. AWARDED → CLAIMED → PREPARING → SHIPPED → DELIVERED is implemented, with supported cancellation and duplicate handling. Shared fulfillment records are used without inventing a SaleListing order. Real browser claim/prepare/dispatch/delivery and PostgreSQL inventory verification passed. Carrier labels, complex grouping and shipping-fee collection are not implemented. |

## 3. Invariant assessment

| Invariant | Finding and evidence |
|---|---|
| Catalog existence does not imply ownership | Supported: independent item and balance tables; zero-stock catalog, import and watch tests. |
| Ownership does not imply publication | Supported: receiving and transfers do not create/publish listings. Inventory/domain and publication suites. |
| Publication does not imply inventory | Supported: zero-stock listing remains public; publication and two-application HTTP tests. |
| PurchaseWatch does not imply ownership | Supported: watch mutation has no ledger mutation; watchlist tests. |
| JP stock is not immediately fulfillable | Normal storefront/checkout uses the France scope, explicitly excluding Japan and foreign ancestry even if a flag is misconfigured. Internal global “fulfillable” totals can include an explicitly enabled Japanese location. This distinction must remain clear; the flag alone is not the France policy. |
| Transfers preserve total inventory | Supported: one atomic transfer, source/destination checks, shipment and inventory tests, ledger reconciliation. |
| Inventory cannot become negative | Application deductions lock/check shared stock and reservations; conditional updates plus database checks reject underflow. Concurrent deduction and last-unit tests pass. This is not a guarantee against a privileged operator altering constraints. |
| All stock changes are auditable | Reviewed application stock writes route through movement commands, with actors and immutable history. Database privileges still matter: positive direct balance changes are not automatically reconciled against the ledger by a database-wide constraint. |
| Duplicate operation keys are safe | Supported: unique keys, payload fingerprints and transactional replay/conflict rules. Purchase, shipment, inventory, order and gacha tests cover retries; mismatched reuse is rejected. |
| MSRP / purchase / landed / selling prices are separate | Separate fields/records and safe money helpers. Landed calculations do not overwrite MSRP. Fixed an acquisition-cost validation gap at the low-level movement boundary. |
| SaleListing does not duplicate identity | Unique merchandise-item relation; publication updates the existing listing. |
| Multiple characters | Explicit junction relations, duplicate/mapping review, CSV separator handling and catalog tests. |
| Partial release dates | Date plus YEAR/MONTH/DAY precision, validation and formatters; internal date anchors do not imply invented displayed precision. Month/year and round-trip tests pass. |
| Sources/provenance remain attached | ItemSources and lineup sources are multiple records. Reviewed import preserves provenance; CSV update policy preserves unrelated sources. |
| Archived records preserve history | Archive state, restrictive FKs and immutable movement/history records; archive tests. |
| No private sourcing/cost data in public responses | Public selectors and frontend parsers explicitly project allowed fields. Storefront/customer isolation tests and real HTTP checks pass. Customer-owned private order/reward details require customer authorization. Not an exhaustive proof against future endpoints. |

## 4. Problems, severity and disposition

Severity describes impact under the stated conditions. No critical exploit was demonstrated. “Deferred” is not a claim that the issue is harmless.

| ID | Severity | Problem | Disposition |
|---|---|---|---|
| A01 | High | Public list requests approach/exceed the 5-second transaction budget at 50,000 items. A second request failed with Prisma P2028. This also increases exposure to unauthenticated resource exhaustion. | **Open.** Requires measured query-plan work and public traffic controls; increasing timeout alone is not a remedy. |
| A02 | High | Dashboard exceeds its 15-second transaction budget at the same scale with 500,000 movements. Multiple aggregate passes and public-eligibility work accumulate. | **Open, partially reduced.** Combined five attention queues into one shared CTE query. The resulting implementation still timed out in the scale diagnostic. |
| A03 | Medium | Dashboard used physically fulfillable units for listing attention/retail value, ignoring checkout holds and the storefront's France scope/visibility. An entirely reserved listing could be omitted from out-of-stock attention. | **Fixed.** Reuses actual public eligibility and shared reservation-aware aggregation, while preserving physical ownership metrics. Updated labels and regression test. |
| A04 | Medium | Catalog normalized the query but not compatible-width stored text, missing Japanese/full-width names and aliases. | **Fixed in shared catalog queries.** PostgreSQL NFKC normalization now matches stored text without rewriting it. Separate lineup-only search surfaces still need consistency work. |
| A05 | Medium | Low-level inventory validation accepted acquisition cost attached to a transfer/removal, despite the UI's stricter policy. This could create misleading cost audit data through another command entry point. | **Fixed.** Shared ledger validation rejects it before any movement/balance change. No history rewritten. |
| A06 | Medium, configuration-dependent | Commerce accepted a short configured gateway secret, inconsistent with the customer gateway's minimum. This weakens the boundary when misconfigured; it is not a demonstrated bypass with a strong secret. | **Fixed.** Minimum 32 characters is enforced by commerce authentication and payment readiness. Existing tests now use valid fixture secrets; explicit short-secret rejection test added. Operators must still generate random secrets. |
| A07 | Medium | Global recent inventory activity lacked an index led by timestamp; fetching ten records scanned/sorted a large movement history. Reward lookups by merchandise also lacked their own leading index. | **Fix supplied.** Added timestamp/id and reward merchandise indexes. Migration tested in isolated databases, not applied to the development database. |
| A08 | Medium | PNG/JPEG/WebP upload validation checks signatures and a 5 MB file limit, not full image decoding, dimensions or pixel budget. A truncated PNG signature can pass recognition. | **Deferred.** Add a reviewed decoder/re-encoding pipeline and corruption/decompression tests. Internal upload authorization, public approval, fixed MIME and nosniff mitigate exposure but do not validate image integrity. No decoder RCE was demonstrated. |
| A09 | Medium | Catalog facet queries cap results at 500; with 5,000 lineups the initial selector cannot expose every lineup. Bulk selection/import limits also constrain large operations. | **Deferred.** Add searchable/paginated selectors and chunked durable jobs where needed. Preserve explicit selection scope and reviewed import semantics. |
| A10 | Medium | Global substring search and latest-known-cost retrieval still scan substantial data; bulk duplicate review repeatedly loads lineup context. | **Deferred.** Scope work to page IDs where semantics permit, inspect expression/trigram indexing, and reuse batch context. Do not duplicate shared query rules. |
| A11 | Medium | Aggregate landed value of remaining inventory is unavailable because remaining units are not allocated to their acquisition lots. Applying one newest cost to everything is only an estimate. | **Deferred accounting capability.** Fixed the dashboard's outdated explanation; keep unknown values and cost coverage explicit. |
| A12 | High if absent in deployment | No deployed evidence of durable media/DB backups and restore, runtime least-privilege role, TLS/proxy policy, scheduled reconciliation, or alerting. | **Operational gate, unverified.** Local compose and successful builds do not establish these controls. Do not deploy development credentials/roles as production policy. |
| A13 | Medium | Internal accounts have broad capabilities; no granular operational role separation/MFA is configured. Public-read rate limiting and proxy-aware abuse policy need deployment decisions. | **Deferred.** Confirm the intended staff trust model, edge limits, and trusted proxy policy. Never trust arbitrary forwarded IP headers to “fix” rate limits. |
| A14 | Medium | Email and payment maintenance have operational dependencies. Delivery failures have no durable transactional outbox/retry workflow demonstrated; maintenance scripts are not proof of a running scheduler. | **Deferred.** Exercise failure/retry monitoring, scheduler ownership and external test integrations before customer rollout. |

## 5. Security review

| Area | Checked controls | Residual limit |
|---|---|---|
| Authentication | Internal provisioned account/session checks; separate customer password/session flows; session ownership and revocation; customer gateway secret checks | No deployed MFA/identity-provider review; do not infer protection from hiding an admin menu. |
| Authorization / IDOR | Domain internal-account assertions; customer-owned order, request, pull and reward lookup; authenticated claim/fulfillment boundaries | Existing suites cover cross-customer access, not an exhaustive fuzz of every route/identifier combination. |
| CSRF | Next server-action origin behavior, Better Auth trusted origins, explicit origin checks on customer/commerce mutations, SameSite cookies, gateway separation | Reverse proxy and externally exposed origin settings were not verified in deployment. Stripe webhook authentication is signature-based, not browser-CSRF-based. |
| Server validation / mass assignment | Zod schemas and explicit persistence/projection fields; server-authoritative quote; immutable snapshot checks | Preserve strict boundaries when adding future connectors or admin APIs. |
| Unsafe public mutation | No ordinary public listing read route mutates stock. Pulls/claims require customer authorization; shared gateway keys stay server-side | Anonymous public reads still execute expensive queries. Reviewed public routes need load/abuse budgets. |
| SSRF | HTTPS/443 only, no credentials, reserved/local address blocking, all resolved IPs checked, socket DNS pinning, redirect revalidation, byte/time limits and bounded concurrency | Network-layer egress controls are additional protection; no live adversarial infrastructure test performed. |
| Uploads / image delivery | Random managed keys, path validation, fixed supported image types, byte limit, internal authorization, public image approval/eligibility checks | Signature-only validation remains A08. Durable files can also be lost independently of database metadata without coherent backups. |
| SQL injection | Prisma parameter binding and tagged SQL, escaped search wildcards; reviewed dynamic fragments derive from code allowlists | Raw SQL in migrations/test fixture setup is not a browser-controlled SQL API. No injectable application path demonstrated. |
| XSS | React text rendering, safe serialization in SSR, URL validation, non-HTML image responses; CSV formula escaping | No full browser payload-fuzz campaign or deployed security-header assessment. |
| Private leakage | Dedicated public selectors, DTO whitelists, owner-scoped customer endpoints, public-safe media access | Generated metadata and future routes must continue using those selectors; never serialize raw Prisma objects publicly. |
| Secrets / transport | Server-only gateway/API credentials, test-mode Stripe guard; minimum commerce secret now enforced | kokoniv2's production origin parser permits HTTP. The actual production URL must be HTTPS and secure cookie/proxy behavior must be verified. Do not log or expose secrets when diagnosing configuration. |

`npm audit --omit=dev --json` reported **zero known production dependency vulnerabilities in both repositories** at the time of this audit. This is a package-registry result, not a security certification; development dependencies and deployed infrastructure were not certified by that scan.

## 6. Database and performance

### Integrity and transaction design

- Inventory commands use transaction boundaries, row/advisory coordination, conditional balance updates and shared reservation accounting. Multi-location transfer is atomic. Purchase receipt, international shipping, checkout reservations and physical reward dispatch reuse this boundary.
- Unique operation keys and payload checks distinguish safe replay from conflicting reuse. Uniqueness exists for SKU, listing identity and other business keys. JAN is deliberately not a global unique item identity: multiple catalog records can legitimately share an assortment JAN, so duplicate detection and hard uniqueness are different policies.
- FKs restrict deletion of historical inventory, orders and related evidence. Database migration SQL adds checks/triggers that the Prisma schema alone does not represent; use migrations, not `db push`, to recreate this database.
- Reservation and movement locks are shared across commerce and gacha. New race coverage exercises the cross-domain last-unit case. It does not prove deadlock freedom for every possible concurrent administrator edit.
- Money uses integer minor units and safe allocation arithmetic; currencies stay explicit. Unknown cost coverage is represented as unknown, not silently zero. Cost estimates are not FIFO inventory accounting.
- A privileged direct positive balance change can still disagree with the movement ledger. Reconciliation exists, but runtime database privileges and scheduled discrepancy monitoring remain necessary.
- Existing item/location/history/reservation indexes support many focused reads. Added the two evidenced indexes rather than indiscriminately indexing every column. Other FK and cleanup/expiry access paths should be indexed based on actual query plans and production workloads.

### Measured scale diagnostic

Added [scripts/audit-scale.ts](../scripts/audit-scale.ts). It refuses production and requires a separate `_test` database, migrates a uniquely owned temporary schema, seeds fixtures, measures actual services, saves EXPLAIN output, and drops only its schema and temporary media. It does not expose an inventory-import API.

Dataset: **50,000 merchandise items, 5,000 lineups, 150,000 balances in three locations, 500,000 acquisition movements, 50,000 published listings/images and 10,000 watches**. There were **zero reservation records**; realistic large order/reward/reservation histories will add work. One local client was used; this is not a load test or capacity guarantee.

| Measurement | Observed result |
|---|---:|
| Catalog first page | 122 ms |
| Catalog NFKC search | 427 ms |
| Catalog page 2,000 | 126 ms |
| Public listings first request | 4,788 ms |
| Public listings repeat request | Failed: 5,000 ms transaction expired; error reported 5,564 ms elapsed |
| Public listing detail | 153 ms |
| Dashboard, after combining attention queues | Failed: 15,000 ms transaction expired; error reported 16,434 ms elapsed |
| Latest acquisition across all merchandise, EXPLAIN execution | 438.626 ms; 500,000 index entries scanned |
| Normalized Japanese-name substring search, EXPLAIN execution | 84.249 ms; full merchandise scan, 49,999 rows rejected |
| Latest ten movement IDs, before timestamp index | 127.407 ms; parallel scan and sort |
| Same movement query, after experimental timestamp/id index | 0.063 ms; index-only scan of ten entries |

Raw captured evidence is in [.local/audit/scale-results.json](../.local/audit/scale-results.json). The before/after index experiment was conducted before adding the audit index migration; the final diagnostic script uses the migrated index and reports the current plan without creating a duplicate experiment index. **The final migration was not followed by a complete second scale run.** Its recent-activity benefit was measured independently; it must not be represented as resolving the storefront/dashboard failures, which occurred before that late dashboard activity lookup.

Recommended focused follow-up:

1. Explain each public-list count/filter/facet/projection query. Avoid a full stock aggregate for counts that do not filter on availability; obtain page IDs first and scope projection/stock work when query semantics permit. Preserve exactly one public eligibility policy.
2. Reduce dashboard aggregate repetition and separate expensive reporting from immediate operational reads. Consider maintained summaries only with explicit freshness and reconciliation semantics. Do not hide work by only raising transaction timeouts.
3. Check plans for a normalized search expression/trigram strategy before enabling a database extension or adding dependencies. The new search behavior is correct but still scan-based.
4. Scope latest acquisition and landed-cost history reads. Keep price/cost coverage explicit; do not replace ledger-backed accounting with a cached global cost.
5. Replace capped facet dropdowns with server-searched options. Reuse references/duplicate context within CSV batches and consider durable chunked jobs beyond existing limits.
6. Profile real reservation/reward histories and concurrent traffic. The pool is ten connections per backend process; long interactive read transactions can starve commands. Gacha odds/readiness evaluation also takes locks and loads allocations, so measure contention on popular banners.

Many page relation reads are bounded and batched by Prisma; no blanket “all queries have N+1” finding is justified. The main measured problems are repeated broad aggregates and transaction duration. Per-item command loops, image checks within transactions, large allocation pools and repeated CSV duplicate lookups remain places to profile.

## 7. Fixes and migration supplied

| Audit-specific files | Change |
|---|---|
| `src/modules/catalog/queries.ts` | Normalize stored catalog search text with NFKC while preserving original text. |
| `src/modules/inventory/validation.ts` | Reject acquisition cost on transfer/removal at the shared command boundary. |
| `src/modules/commerce/http.ts`, `stripe.ts` | Fail closed for short gateway secrets and report payment configuration consistently. |
| `src/modules/publication/queries.ts` | Export the existing SQL public-eligibility selector for aggregate reuse; no new public fields. |
| `src/modules/dashboard/queries.ts`, `src/app/admin/page.tsx` | Distinguish owned from available, match public visibility/scope, correct retail/low-stock presentation, combine attention queues, clarify unavailable landed valuation. |
| `prisma/schema.prisma`, `prisma/migrations/20260913120000_audit_query_indexes/migration.sql` | Add movement timestamp/id and reward merchandise indexes. |
| `tests/platform-audit.integration.test.ts` | Five new regression/race tests. |
| `tests/commerce.integration.test.ts` | Update three valid-auth fixture secrets to satisfy the strengthened boundary. |
| `scripts/verify-admin-http.ts` | Update the dashboard text assertion to the corrected label. This dev-database-specific script was not run during the audit. |
| `scripts/audit-scale.ts`, this document | Reproducible isolated scale diagnostic and audit evidence. |

No dependency was added. No catalog records, inventory history, payment records or production configuration were rewritten. No development database reset or seed was run.

**Migration remains pending on the development/deployment database.** It was applied successfully in disposable integration-test schemas. Normal `CREATE INDEX` can block writes on an existing large table: schedule a suitable maintenance window or prepare a reviewed concurrent-index deployment strategy before running `npm run db:deploy` against a busy environment. No behavioral data migration is required for these indexes. Existing suspect acquisition-cost history, if any, is not automatically repaired.

## 8. Tests and verification

| Check | Result |
|---|---|
| Baseline backend `npm test` | 328 passed, 31 files |
| New regressions before fixes | Four expected failures reproduced: compatible-width search, ledger cost validation, reserved-stock dashboard metrics, short-secret rejection |
| Targeted catalog/dashboard/audit suites | Passed after fixes; cross-domain race added and exercised three times within its test |
| Final backend `npm test` | **333 passed, 32 files**, 87.66 seconds |
| Backend `npm run typecheck` and `npm run lint` | Passed |
| Backend `npm run db:validate` | Passed |
| Final backend `npm run build` | Passed, including Prisma generation, TypeScript and App Router build |
| Frontend `npm test` | **26 passed**; Vite reported an already-used development WebSocket port, without assertion failures |
| Frontend `npm run build` | Passed client and SSR builds |
| `npm run test:storefront-http` | Passed real two-application publication, France stock, quotes, customer isolation, authenticated order admin, disabled-payment behavior, reservation availability/release, images, price changes and unpublish checks |
| `npm run test:customer-gacha-browser` | Passed real authenticated pull/reward, duplicate click, refresh/lost-response recovery, Skip/replay, mobile reduced motion, history/images, customer claim, admin prepare/dispatch/delivery and DB inventory checks |
| Production dependency scans, both projects | Zero reported vulnerabilities |
| `npx tsx scripts/audit-scale.ts` | Diagnostic completed and cleaned its fixture; public-list and dashboard service failures recorded, not counted as passing scale validation |

The full suite initially revealed three older short-secret fixtures and one new bounded-queue assertion that assumed its record must appear among the first eight ties. Those tests were corrected without weakening gateway enforcement or inflating the attention queue, then the full suite passed.

The HTTP/browser checks ran against production builds before the final attention-query consolidation/index migration; the final build and database suite verified those later edits. They did not exercise real payments, send production email, or consume production inventory. Automated browser verification does not imply a separate manual visual/accessibility certification of every admin screen.

### Important remaining test gaps

- Long generated sequences of stock/reservation changes and concurrent location edits, cancellation, dispatch and payment reconciliation across multiple processes; broader deadlock and crash-recovery testing.
- Concurrent load at requested scale, including substantial expired/live reservation, order, reward and fulfillment histories. The diagnostic fixture has no reservation history.
- Full image decode/corruption/pixel-budget tests once A08 is addressed.
- Deployed TLS/cookie/proxy/rate-limit validation, comprehensive security fuzzing, and database-plus-media restore drills.
- An external Stripe test checkout/webhook/reconciliation run and real transactional email delivery/retry verification in a controlled environment.
- One continuous discovery → purchase → Japan → transit → France → costing → sale/reward scenario. Current suites verify the segments and real two-application commerce/gacha boundaries, not one single universal scenario.
- Provider-specific discovery fixtures once bespoke adapters exist; generic structured extraction is not evidence that every official website works.

## 9. Intentionally deferred work and release gates

Retain the existing architecture. Prioritize A01/A02 query performance, A08 image integrity, then verify deployment controls in A12/A14 and run realistic concurrent load. Keep checkout in its existing explicit test mode. Carrier labels, complex reward consolidation, partial purchase receipt, provider-specific discovery and acquisition-lot on-hand valuation require separate functional work; they were not silently introduced by this audit.

The platform has substantial, tested domain foundations. Release approval still needs evidence that operational pages remain usable at scale, deployed secrets/auth/media/backups are correctly configured, and external payment/email/maintenance paths work reliably. Those conditions have not been established here.
