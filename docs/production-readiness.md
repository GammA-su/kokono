# Production readiness, configuration and wiring audit — Prompt 23

> **Superseded in part.** A later local-hardening pass revised the performance, migration,
> database-role, email, selector and feature-flag findings below. Read
> [prompt-24-addendum.md](prompt-24-addendum.md) alongside this document, plus
> [vps-handoff.md](vps-handoff.md) and [environment-handoff.md](environment-handoff.md).

**Verdict: not ready to accept real customers or money.** Safe local fixes, production templates and operator procedures are supplied. No production deployment, DNS change, live payment, real email, production inventory change or paid gacha enablement occurred.

Most significantly, **ordinary Stripe commerce is currently test-only and paid gacha is not implemented**. These are capabilities requiring separately reviewed implementation/qualification, not missing production keys that can simply be filled in. Production domains/hosting, verified external integrations, operational alerting and provider-backed recovery are also not established.

Use this as the current operational assessment. Older prompt documents describe historical phase limitations; the repositories and the new evidence below supersede those stale descriptions.

## Deliverables and inspection

- [Environment inventory and secrets](environment.md): all application/config/script variables found, validation/default/failure behavior, safe examples and source locations; production templates in both projects.
- [Deployment and database](deployment.md): topology, exact origin matches, TLS/proxy/roles, all migrations, index alternatives, builds, process management, rollback and initialization.
- [Runbooks](runbooks.md): scheduler matrix, reference timers, paired backup/restore, email/Stripe acceptance, sourcing and gacha scenarios, monitoring, DNS and first-order/first-banner checklists.
- [Reference deployment files](../deploy/nginx.conf.example): nginx rate limits/TLS/access gates and systemd service/timer templates. Not installed or attached to DNS.
- New local tools: `npm run ops:preflight`, `npm run inventory:reconcile`, `npx tsx scripts/audit-database.ts`, `npx tsx scripts/audit-scale.ts --with-history`, `npx tsx scripts/audit-restore.ts`.

Re-inspected code/config/docs for both `D:\Project\kokono-inv` and `D:\Project\kokoniv2`, including the requested integration-plan, customer-account, gacha integration and previous audit documents. Source tracing covered the module families audited previously, with detailed follow-up on public selectors/dashboard, media, auth/gateways, Prisma/pg, payment/email, maintenance scripts and deploy assumptions. This is not a deployed penetration test or an assertion that every historical prose statement is still accurate.

An operator question about chosen domains/provider, staff model and verification policy was left for the owner; none was assumed silently. Until supplied, the Linux/nginx/systemd topology is a **proposal with tested syntax**, not the selected production platform. Reserved `.example` domains are placeholders.

## Readiness matrix

Priority: **P0** blocks deploying the proposed production environment; **P1** blocks accepting customers/money; **P2** is an operational risk requiring near-term work; **P3** is optional improvement. Owners are roles that still need named assignees. READY below always states its evidence scope.

| Area | Status | Priority | Evidence | Action required | Blocks launch? | Owner | Config/command |
|---|---|---|---|---|---|---|---|
| Production hostnames/provider | READY AFTER CONFIG | P0 | None chosen/configured in repositories | Choose S/A, provider/network and staging equivalents | Yes | Owner/platform | SITE_ORIGIN, BETTER_AUTH_URL, COMMERCE_API_ORIGIN |
| Secrets/config injection | READY AFTER CONFIG | P0 | Templates + tested preflight; local dev config correctly fails it | Provision independent random keys and provider secrets; protected env injection | Yes | Platform | `npm run ops:preflight` |
| Runtime/SSR build | READY | P0 deployment gate verified locally | Both production builds pass; Node 24.14.0 pinned in `.node-version` | Build clean target-platform releases; run Node SSR, not static Vite-only hosting | Deployment must retain this | Platform | `npm ci`, `npm run build`, `npm start` |
| PostgreSQL production instance/TLS | READY AFTER CONFIG | P0 | Local 18.3 UTF8 has SSL off; not a production instance | Provision supported PG, verified TLS/CA, capacity and maintenance settings | Yes | DBA/platform | DATABASE_URL with verify-full; `audit-database.ts` |
| Least-privilege runtime | READY AFTER CONFIG | P0 | Local restore non-owner role can perform ledger DML but cannot DDL/rewrite ledger | Apply reviewed provider roles/grants, separate migration identity | Yes | DBA | Deployment role SQL; runtime DATABASE_URL |
| Migrations/indexes | READY AFTER CONFIG | P0 | 16 local applied checksums match; audit-index migration pending | Check actual target state; back up, apply reviewed path, verify | Yes | DBA/release owner | `npm run db:deploy`, `npx prisma migrate status` |
| TLS, DNS, proxy, secure cookies | NEEDS EXTERNAL VERIFICATION | P0 | Website rejects production HTTP; proxy config passes nginx syntax check; local cookie tests pass | Deploy certificates/proxy, firewall origins, verify HTTPS cookies/redirects/renewal | Yes | Platform | Proposed `deploy/` files + host DNS |
| Trusted proxy identity | READY AFTER CONFIG | P1 | New literal-IP trust parser and forgery/chain tests pass | Set actual immediate peers; ensure proxy overwrites header; test deployed chain | Yes for proxied customer traffic | Platform | TRUSTED_PROXY_IPS |
| Durable media | READY AFTER CONFIG | P0 | Local managed filesystem, paired local restore passes | Mount outside releases, verify restart/redeploy/host-replacement recovery | Yes | Platform | MERCHANDISE_UPLOAD_DIR |
| Image ingestion/integrity | READY | P1 local defect fixed | Strict decode/re-encode, dimension/pixel/byte/time guards, corrupt-image tests pass | Review existing files and real-image workload; replace invalid legacy assets | Existing media review still needed | Catalog/platform | `media/storage.ts`, pinned Sharp |
| Public listing performance | NEEDS FIX | P1 | Single-pass query improves ~4.4 s to ~2.4 s; mixed-load p95 still 4.5 s | Further reduce work or establish tested acceptable capacity with safe headroom | Yes at requested scale until qualified | Backend/platform | Scale/load script and EXPLAIN evidence |
| Dashboard performance | NEEDS FIX | P1 for requested operator scale | Materialized visibility reduced timeout to ~9.3 s; still slow, sustained dashboard load untested | Optimize/reporting strategy and test on target infrastructure | Yes for operational qualification | Backend | `dashboard/queries.ts` |
| Anonymous traffic controls | READY AFTER CONFIG | P1 | Reference per-IP rate/connection limits provided, not active anywhere | Deploy edge limits to website AND backend public reads; test bursts/normal pages | Yes | Platform | nginx reference or provider equivalent |
| Public facet performance | NEEDS FIX | P1 | Separate 50k-item run: 4,116 ms | Reduce eligibility work and qualify sustained load on target host | Yes at requested scale until qualified | Backend/platform | `getPublicFacets`, scale script |
| Search/facet selectors | NEEDS FIX | P2 | NFKC regression passes; substring scan and 500-option caps remain | Add server-searched selectors; profile supported expression/trigram indexing | At large operator catalogs, workflow risk | Backend/UI | Existing catalog queries; no pg_trgm installed |
| Ordinary live commerce | NEEDS FIX | P1 | Code rejects live keys/events; checkout flag is TEST-only | Separately implement/qualify controlled live-mode transition; retain off switch | Yes for money | Commerce/backend/owner | `commerce/stripe.ts`; not a config-only step |
| External Stripe TEST integration | NEEDS EXTERNAL VERIFICATION | P1 | Keys empty; local signature/idempotency/payment tests only | Real staging Checkout, test payment, webhook, replay, reconciliation/refund drill | Yes for payment qualification | Commerce/platform | Test keys and A/api/commerce/webhooks/stripe |
| Email delivery/account recovery | NEEDS EXTERNAL VERIFICATION | P1 | No configured Resend key/sender; mocked transport and token lifecycle pass | Verify domain/DNS, sender, inbox/header/link/reset behavior and outage recovery | Yes | Owner/platform | Resend settings in environment inventory |
| Email verification policy | READY AFTER CONFIG | P1 decision | Existing false policy preserved; gates implemented | Owner chooses policy; enable only after reliable mail | Decision required | Owner | CUSTOMER_REQUIRE_VERIFIED_EMAIL |
| Auth mail retry policy | READY AFTER CONFIG | P2 | Failed/uncertain token invalidated; safe re-request; no durable outbox | Accept/rehearse user retry/support policy and monitor provider errors | Reliable recovery required | Owner/platform | `customer-email/*`, runbook |
| Order/shipment email | NEEDS FIX | P1 decision | Auth mail adapter sends neither | Decide minimum customer communications; implement separately if automatic required | Decision required | Owner/commerce | No existing order-email job |
| Schedules/reconciliation | READY AFTER CONFIG | P1 | Real scripts plus new inventory CLI; timers supplied, not installed | Install ONE job owner; verify successes, backlog and failure alerts | Yes | Platform/commerce | Three timer files; command matrix |
| Gacha transaction/recovery/ownership | READY | P1 local evidence | Secure real pulls, retries, owned claims/dispatch and restore pass | Repeat HTTPS staging first-banner checklist | Yes until external staging acceptance | Gacha owner | Existing global/customer/banner/allowance gates |
| Paid gacha | NEEDS FIX | P1 only if intended for launch | Explicitly disabled in code/database; no paid entitlement flow | Business/legal decisions plus separately tested implementation | Yes for paid pulls; can remain absent | Owner/backend | No paid-enable environment variable |
| Free gacha first banner | READY AFTER CONFIG | P1 feature gate | Allocated inventory, exact odds, expiring free allowance, verified customer policy | Configure reviewed terms/schedule/stock and supervise first pull/claim | Yes before enabling real free rewards | Gacha/fulfillment owner | GACHA_DRAWS_ENABLED, GACHA_CUSTOMER_EXECUTION_ENABLED + admin |
| Shipping/tax | READY AFTER CONFIG | P1 owner confirmation | Central FR mainland EUR TTC defaults + historical snapshots tested | Confirm configured business settings, placement and manual shipping process | Yes | Owner/accounting | COMMERCE_POLICY_JSON |
| Carrier/labels | READY AFTER CONFIG | P1 operations | Carrier/tracking records exist; no automatic label purchasing | Choose external manual label process; train dispatch operator | Yes for physical shipping | Fulfillment owner | Admin order/reward dispatch |
| Internal bootstrap/access | READY AFTER CONFIG | P0/P1 | Trusted CLI, no default account, sign-up disabled | Provision one owner, clear bootstrap secrets, choose staff access/MFA policy | Yes | Owner/platform | PROVISION_*; provisioning CLI |
| Customer auth/IDOR/CSRF | READY | P1 external gate | Separate sessions, ownership/origin/rate tests and browser flow pass | Verify actual deployed TLS/proxy/verification/reset/disable behavior | Yes until verified | Platform | Existing customer APIs; browser verification |
| Monitoring/alert routing | READY AFTER CONFIG | P1 | Job output/proxy log reference; no deployed provider/alerts | Assign provider/operator, instrument essential metrics, test alert delivery | Yes | Platform/on-call owner | Monitoring table in runbooks |
| Full error correlation | NEEDS FIX | P2 | Public errors are generic; end-to-end correlation incomplete | Add safe request/error correlation with chosen log/error service | Operational risk | Platform/backend | No DSN configured |
| Paired off-site backups/PITR | READY AFTER CONFIG | P0/P1 | Local logical restore proof only; no off-site provider settings | Configure encryption/retention/credentials, restore current provider backup | Yes | Platform/DBA | Backup runbook + provider jobs |
| Local restore mechanics | READY | P1 local gate verified | Separate DB/media, role/ledger checks, both applications and HTTP history pass | Retain evidence; repeat against staging provider/backups | External recovery still blocks | Platform | `npx tsx scripts/audit-restore.ts` |
| Continuous external acceptance | NEEDS EXTERNAL VERIFICATION | P1 | Segments, local HTTP/browser/restore pass; external providers absent | Run sourced item → sale and separate reward chain in staging | Yes | Owner/operator | Runbook scenarios |
| Content/legal surfaces | READY AFTER CONFIG | P1 | No finalized legal/company pages; footer says test checkout | Owner supplies terms/privacy/contact/company/shipping/returns/gacha content | Yes | Business owner | Website content; no invented legal language |
| MFA/granular roles/full CSP | OPTIONAL POST-LAUNCH | P2/P3 | Conditional on approved one-owner access; broad internal capabilities; baseline framing/object CSP added | Prefer protected admin access/MFA; plan granular roles as staff grows | Access model decision may elevate to P1 | Owner/security | Access provider and future scoped implementation |
| Lot-based on-hand landed valuation, bespoke adapters, consolidated rewards | OPTIONAL POST-LAUNCH | P3 | Current limitations explicit; no fake valuations/adapters | Separate feature work when required | No if MVP limits accepted | Owner/product | Existing phase docs |

## Revalidated performance and database evidence

Previous source still exhibited repeated public visibility work. Profiling found managed-image eligibility checks repeated across large catalog sets, plus redundant full count/page passes and inlined dashboard visibility expressions evaluated multiple times. A candidate partial image index and a collation experiment did not help; neither was shipped as a migration/policy change.

Safe measured changes:

1. Public listing page now computes its total with `COUNT(*) OVER()` in the same selection pass. An empty/out-of-range page retains a fallback count so pagination semantics remain correct. Uses existing filters, public eligibility, reservation aggregation, transaction isolation and DTO projection.
2. Dashboard public listing CTE is explicitly MATERIALIZED, avoiding repeated expansion into aggregate filters. No cached/stale totals, new reporting database or timeout increase was introduced.

Final history fixture: **50,000 items, 5,000 lineups, 150,000 balances, 500,000 initial movements, 50,000 listings/images, 10,000 watches, 1,000 cancelled historical orders, 3,000 reservations (released order holds plus live gacha allocations), 40 customers and 400 initial owned rewards/pulls**. History is created through real domain commands. Additional load performs real no-charge draws and quote/reserve/cancel operations, never provider payments. Fixture construction was adjusted to respect existing per-customer open-checkout/quote limits, not disable those safeguards.

| Single service call with history | Milliseconds |
|---|---:|
| Catalog page / normalized search / deep page | 92 / 458 / 118 |
| Public listing page / repeat | 2,396 / 2,489 |
| Public detail | 44 |
| Dashboard | 9,326 |

Controlled mixed load: **12 workers, 70 operations, 10-connection pool**. Sampled peak 10 connections/10 active/2 waiting; 109 pool samples at 50 ms. Zero failed operations and zero mismatches for the checked prize ledger.

| Operation | Samples | p50 ms | p95 ms |
|---|---:|---:|---:|
| Listings | 10 | 4,330 | 4,500 |
| Product detail | 10 | 155 | 1,679 |
| Cart resolution | 10 | 170 | 233 |
| Login | 10 | 279 | 641 |
| Quote → reserve → cancel | 10 | 493 | 725 |
| Popular banner odds | 10 | 55 | 215 |
| Customer pull | 10 | 170 | 1,989 |

These are short local **domain/DB** measurements, not sustained HTTP/TLS capacity or statistically robust percentiles (ten observations per group). The two-application HTTP check separately passed a small four-worker listing/facets/product smoke test. Proxy/CDN behavior, large-image traffic, sustained dashboard/facet load, multiple replicas and larger historical datasets remain qualification work. The measured timeouts no longer reproduced in this final mixed fixture, but listing p95 has little margin below five seconds and the dashboard remains slow. Do not repeat the old timeout result as if no improvement occurred; do not declare the performance gate closed either.

A compact, secret-free snapshot is committed as [production-evidence.json](production-evidence.json). Raw history/load SQL plans and timings: `.local/audit/production-load.json`. Earlier profile: `.local/audit/production-before.json`. The reproducible scale tool also captures `EXPLAIN (ANALYZE, BUFFERS)` for slow read queries and preserves diagnostic failures rather than falsely counting them as passes. A separate base-fixture run measured public facets at **4,116 ms**, listing/repeat at 2,296/2,171 ms and dashboard at 9,149 ms. That run has no order/reward history and is recorded in `.local/audit/scale-results.json`; do not conflate it with the history dataset. None of these diagnostics touches development/production inventory.

DB audit: local PG18.3 UTF8, max_connections 100, SSL off, statement/idle-in-transaction timeout zero, development role superuser. Sixteen applied migration checksums match; seventeenth index migration remains pending locally. No production applied-state claim is possible. The additional connect/idle pool limits are 5/30 seconds; transaction budgets remain unchanged.

## Image and operational fixes performed

- `src/modules/media/storage.ts`: explicit pinned Sharp 0.35.4 dependency (already installed transitively); decode/re-encode with strict warnings, static images only, 5 MB input/output cap, 8,192 side limit, 16-million-pixel limit and five-second processing timeout. Applies EXIF orientation and strips metadata on new ingestion. Existing images are checked fully before public deliverability; corrupt legacy files may now be rejected and need review/re-ingestion. No stored production file was rewritten.
- Assisted source-image preview uses the same validated normalization after existing SSRF-safe download. Japanese/provenance/catalog data is unchanged. Mature decoder options are documented by [Sharp](https://sharp.pixelplumbing.com/api-constructor/).
- New production preflight validates fields without printing secrets and checks mount access. It is wired into the reference backend unit; it is not automatically a certification from the normal development command.
- Website production startup refuses HTTP origins; local test exceptions are explicit programmatic loopback-only options. New trusted-proxy handling accepts only configured immediate socket peers and one validated overwritten IP. Tests cover forged headers, chains and invalid config.
- Baseline security headers and generic readiness/liveness endpoints added. Website shutdown now drains active connections before its bounded forced close.
- New read-only inventory reconciliation CLI reuses the existing ledger comparison; new DB inspection and restore/scale scripts use controlled targets and sanitized evidence.
- Production env templates, version pins, reference TLS/rate/access/service/timer configuration and operator documentation added. Existing business flags, shipping/VAT policy, live-payment refusal and paid-gacha refusal remain intact.

A full legacy-media remediation tool, global public cache, broad RBAC, new payment engine, carrier integration, durable mail outbox and complete observability platform were intentionally not added. Their need/status is explicit in the matrix.

## Verification results

| Check | Result |
|---|---|
| Backend regression suite | 338 passed, 33 files |
| Image/source/publication targeted tests | 44 passed; includes truncated/corrupt files, dimension/pixel rejection, metadata stripping and valid image handling |
| Final pagination/config regression | 14 passed across two files, including out-of-range page totals |
| Frontend unit/HTTP tests | 31 passed; includes new production-origin/proxy-forgery/health tests |
| Both production builds | Passed; backend includes Prisma generation/TypeScript; frontend includes client and SSR |
| Backend lint | Passed |
| Production preflight against existing dev env | Expected failure; identified HTTP origins, non-TLS DB, absent mount/explicit launch flags and demo seed configuration without printing values |
| Migration/DB audit | Read-only success; applied checksums match; one pending migration |
| Two-app storefront HTTP | Passed publication, availability, customer isolation, quote/reservation/release, images, prices, unpublish and added concurrent read smoke |
| Two-app customer gacha browser | Passed real backend pulls/receipts/recovery, duplicate clicks, mobile/reduced motion, history, claim, admin dispatch/delivery and inventory checks |
| Local paired restore | Passed separate database/media, restricted runtime-role behavior, ledger and both applications' product/image/order/reward access |
| Controlled scale/history load | 70/70 operations completed; exact timings/limits above |
| nginx reference syntax | Passed `nginx -t` in a disposable official nginx container with temporary self-signed test certificate; no host deployment or public TLS test |
| Production dependencies | Sharp installation audit reported zero vulnerabilities; prior production dependency scans in both projects reported zero; not a security certification |
| External email/Stripe/TLS/DNS/off-site recovery | **Not verified**: provider credentials/real deployment not available |

The test-image fixtures previously had valid signatures but invalid compressed payloads. They were replaced with genuinely decodable synthetic PNGs; production data was not altered to make the tests pass. The Vite suites still report a development WebSocket-port conflict without failing assertions. Native decoder/production target OS compatibility must be tested in the release environment.

## Explicitly disabled or not supplied

Live Stripe; paid gacha; atomic x10 pulls; production demo seeding; uncontrolled email; automatic carrier-label purchasing; unreviewed source auto-publication; automatic ledger repair; guessed production domains/DNS; automatic migration application; installed production scheduler/monitoring/backup service. Customer verification remains the existing false policy until the owner decides otherwise. The templates default new gacha/test-checkout execution to disabled.

## TO GO LIVE, DO THESE STEPS IN THIS ORDER

1. [ ] Choose production/staging provider and S/A hostnames; assign owner/platform/DB/fulfillment responsibilities and confirm the one-owner access and verification policies.
2. [ ] Provision the production-like **isolated staging** DB, verified TLS, migration/runtime/backup roles, durable media, private listeners, proxy and certificates. Repeat later for production with separate secrets/data.
3. [ ] Generate/store independent random auth/gateway/DB/bootstrap secrets and fill both production templates with chosen origins. Configure public/backend origin matches and trusted immediate proxy IPs; run backend preflight.
4. [ ] Choose/encrypt the off-site backup destination and key recovery procedure. Configure retention/PITR, restore a paired snapshot on clean staging and record measured recovery evidence.
5. [ ] Review current target migration state; back up/drain old workers, apply migrations or the documented concurrent-index alternative, then verify checksums/index validity/grants. Never `db push` or reset production.
6. [ ] Build clean locked releases (`npm ci`, backend checks/tests/build, website build/tests). Deploy backend and website **Node SSR**, with persistent media and supervised restart/drain behavior.
7. [ ] Verify HTTPS origins, cookies, callbacks, DNS/renewal, health/readiness, staff access, direct-origin firewall, spoofed-forwarding rejection, security headers and edge rate limits. Replace example nginx's fail-closed staff access policy deliberately.
8. [ ] Provision the first admin once; remove bootstrap secrets. Create/review JP/transit/FR geography and actual fulfillable shelf/box configuration, category mappings, safe approved media and the first test listing. Test publish/unpublish/re-publish.
9. [ ] Install one scheduler owner for commerce/customer/inventory jobs and the chosen backup job. Observe real completions and test failure alerting. Configure metrics/log privacy/disk/provider/backup alerts and an actual alert recipient.
10. [ ] Provision Resend/DNS/sender/Reply-To; perform controlled received-email/verification/reset/replay tests and recovery-outage checks. Only then decide/enable verified-email requirements and the customer communication policy.
11. [ ] Provision **Stripe test** API/webhook credentials; execute staging Checkout/payment/webhook/replay/reconciliation/refund/dispatch. Fix the separate live-mode capability and qualify it in a later reviewed change before accepting money; no current flag enables safe live commerce.
12. [ ] Finish performance qualification for listings, dashboard and facets on the target host, including realistic histories, concurrency, large media and pool headroom. Pass the agreed acceptance thresholds; a local short run is insufficient.
13. [ ] Complete the continuous sourced-item → Japan → transit → FR → landed-cost → listing → test order scenario and separately customer free pull → recovery → reward claim → dispatch. Verify exact SALE/GACHA movements and no double consumption.
14. [ ] Supply final company/contact/terms/privacy/shipping/returns/gacha content and resolve all P0/P1 items. Keep paid gacha disabled until its business decisions and separately implemented entitlement/payment path are qualified.
15. [ ] Only after those gates pass, authorize customer traffic and supervise the first ordinary order/first explicitly permitted no-charge banner with the runbook checklists. Monitor provider events, reservations, stock, communication and fulfillment before increasing volume.
