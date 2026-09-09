# Operations and external verification — Prompt 23

These procedures distinguish implemented commands, the supplied Linux scheduling reference, and external work that has not been performed. Use staging/test stock and test provider credentials until the readiness matrix permits a deliberate launch. Do not enable live Stripe or paid gacha as part of these procedures.

## Scheduler ownership

Named role owners below must be assigned to an actual person. A script's existence is not a schedule. For the reference single-host topology, install the supplied `deploy/kokoni-job@.service` and three `.timer` files into systemd after reviewing paths, Node location, account and environment access. Do not start them against an unreviewed database. `tsx` must be installed in the operations runtime.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now kokoni-commerce.timer kokoni-customers.timer kokoni-inventory.timer
systemctl list-timers 'kokoni-*'
journalctl -u kokoni-job@commerce-maintenance.service
```

| Job | Existing/new command | Frequency | Owner | Concurrent execution / integrity | Failure effect and alert |
|---|---|---|---|---|---|
| Reservation expiry, payment reconciliation, stale quotes | Existing `npm run commerce:maintenance`; service invokes `node --import tsx scripts/commerce-maintenance.ts` | Every minute, one scheduler owner | Commerce operator | Domain/provider idempotency and transaction guards; no fleet-wide job lease. A single systemd unit will not start another copy while active. Do not schedule on every replica. | Delayed cleanup/uncertain payment repair. Alert nonzero exit or no successful completion for 3 minutes. Inspect backlog; reconciliation handles at most 100 attempts per run. |
| Expired customer sessions/tokens/rate windows | Existing `npm run customer:maintenance` / `scripts/customer-maintenance.ts` | Daily 02:10 UTC | Platform operator | Idempotent deletes; use single owner to avoid unnecessary contention | Expired rows accumulate; authorization still checks expiry. Alert failed/missing daily run within 26 hours. |
| Ledger/balance discrepancies | New `npm run inventory:reconcile` / `scripts/inventory-reconcile.ts` | Daily 03:10 UTC and after incidents/restores | Inventory operator | Read-only, cursor batches reuse existing per-item reconciler; each comparison is one consistent SQL statement. Never automatic repair. | Nonzero on mismatch/error. Alert immediately; pause affected sales/pulls, investigate movement/reference/actor history. Benchmark full scan duration; the reference job limit is 15 minutes. |
| DB/media backup and retention | Provider job still to provision; concrete backup/restore commands below | Proposed daily coherent full backup plus DB PITR where supported | Platform operator | One backup owner; record snapshot time, app/schema version and paired media manifest | Alert any failed backup, missing daily evidence >26 h, or inability to access off-site copy. Not installed by the application timers. |
| Restore verification | `npx tsx scripts/audit-restore.ts` is a local disposable drill; production-provider drill below | Before launch, after storage/schema changes, then monthly | Platform operator | Dedicated target DB/media, never original production targets | Any failure blocks claiming recoverability; record RPO/RTO measured, not assumed. |
| Gacha pool/reward observation | Admin `/admin/gacha`, `/admin/gacha/rewards` plus metrics | Daily and during launch | Gacha/fulfillment operator | Observe, do not invent an automatic release/consumption job | Alert unexpected pull failures or indefinitely unclaimed/unshipped items according to chosen business policy. |

Gacha configured allocations are **CONFIRMED and non-expiring**. A paused banner intentionally holds them. No recurring job should auto-release them based on age. Expiring customer allowances are checked transactionally; they do not create inventory reservations. Pool depletion stops execution immediately, not on cron. Uncertain pull recovery GETs the persisted request/pull; cron must never reroll it. Existing award dispatch/consumption remains an explicit physical event.

Commerce expiration is different: active checks ignore expired HELD reservations immediately; maintenance converges order/reservation/provider state and handles uncertainty. Never release CONFIRMED paid/gacha allocation simply because an old created_at looks stale. Single-host timers are a reference only; if another hosting provider is chosen, configure one equivalent scheduled job owner and prove heartbeats/exit-code alerting there.

## Backups, media and recovery

Current images live in `MERCHANDISE_UPLOAD_DIR`, not in PostgreSQL. Mount durable storage outside release/container filesystems. In the reference, `/var/lib/kokoni/media` must survive restart, deployment and host replacement through off-host recovery. With multiple backend replicas, they need the same coherent managed-file store; independent local disks are incompatible. S3-compatible storage would require a reviewed storage adapter/migration, not merely setting an S3 env variable.

Proposed starting policy, requiring operator acceptance: daily coherent encrypted DB/media backup, 7 daily + 4 weekly + 12 monthly retained copies, off-site storage under a separate account/access boundary, DB PITR with at least 7 days if supported, and monitored capacity. Agree explicit business RPO/RTO; suggested targets are 15-minute DB RPO with PITR and 4-hour restore RTO, **not achieved SLAs**. Media recovery must meet the corresponding point-in-time requirement too. A backup password/key must be recoverable independently of the failed application host.

For a simple coherent full backup, pause application/media writes and scheduled jobs for the snapshot window, dump the DB and copy the media, verify a manifest, then resume. For online backups, use provider snapshots/versioning with a documented common recovery point and protect referenced files from deletion; do not assume two independent timestamps are a coherent backup. Include roles/grants procedure, app release/lockfiles, migration version, configuration metadata and required secret-manager references. Do not store plaintext application secrets in an unencrypted archive.

Example operator commands on a provisioned Linux backup host with PostgreSQL tools; `PGSERVICE`/protected `PGPASSFILE` avoid putting passwords in process arguments:

```sh
# Set BACKUP_DIR to a newly created, protected snapshot directory.
# Configure ~/.pg_service.conf and a 0600 password file outside source control first.
PGSERVICE=kokoni_backup PGPASSFILE=/etc/kokoni/backup.pgpass pg_dump --format=custom --file="$BACKUP_DIR/database.dump"
tar -C /var/lib/kokoni/media -cf "$BACKUP_DIR/media.tar" .
sha256sum "$BACKUP_DIR/database.dump" "$BACKUP_DIR/media.tar" > "$BACKUP_DIR/manifest.sha256"
```

Use the chosen encrypted backup service to encrypt/copy/version these artifacts off-site, verify the uploaded checksum/retention and test access from a clean host. **No backup provider/encryption key/off-site job was configured by this audit.** The commands above by themselves are not an encrypted/off-site backup implementation.

### Restore drill

The new local `npx tsx scripts/audit-restore.ts` builds a small synthetic catalog with stock, an order, a customer and a gacha reward in its own test schema; dumps via the existing local Docker PostgreSQL container; pairs media; restores into a distinct temporary database; provisions a non-owner test runtime role; starts both production builds against it; checks product/image/order/reward HTTP routes and ledger consistency; and cleans its own DB/schema/role/processes/media. It has no payment/email provider and refuses nonlocal/non-test source databases. The archive contains only synthetic records and is under ignored `.local/audit`.

The local drill **passed**. Evidence: `.local/audit/restore-results.json`; paired archive: `.local/audit/restore-fixture.dump`. Runtime DDL and ledger rewrite were denied; allowed receipt DML succeeded. This establishes a local logical-restore path, not production PITR/off-site/TLS/backup-provider reliability.

Production-provider staging drill:

1. Retrieve an encrypted off-site backup on a clean staging host with separately recovered credentials; record download/decryption/checksum success and snapshot timestamp.
2. Provision a **new** staging database and durable media directory. Confirm explicit target names/paths before restore. Prevent outbound production email/payment and public access; never reuse production stock.
3. Restore schema/data using the restore/migration identity, then install the reviewed role grants. Do not use the application runtime as schema owner.
4. Restore the paired media manifest into the new mount and verify referenced keys exist. Do not substitute a different day's media silently.
5. Inject staging-only origins/keys/disabled payment/email flags; start backend and website Node SSR. Check readiness, migrations/checksums, approved product images, historical prices/orders and customer-owned gacha receipts.
6. Run read-only reconciliation; exercise a controlled staging receipt/claim/dispatch and confirm exactly one corresponding movement. Restart/redeploy the staging processes and repeat image/history checks.
7. Record elapsed RTO, snapshot/RPO, failures, operator and artifacts. Keep the original production DB/media untouched. Destroy only explicitly owned staging restore targets after evidence retention approval.

Restore command example after configuring the **new target** service:

```sh
PGSERVICE=kokoni_restore PGPASSFILE=/etc/kokoni/restore.pgpass pg_restore --no-owner --no-privileges --exit-on-error "$BACKUP_DIR/database.dump"
# Restore media into the explicit new staging mount, not a production or release directory.
tar -C /var/lib/kokoni-staging/media -xf "$BACKUP_DIR/media.tar"
npx tsx scripts/audit-database.ts
npm run inventory:reconcile
```

PITR differs from logical dump restore: follow and rehearse the chosen provider's recovery-point procedure and corresponding media version recovery. Do not claim PITR from a pg_dump archive.

## Resend, verification and deliverability

Current local configuration has no usable Resend key/sender; no external email was sent. Configure an organization-owned Resend account, least-privilege sending key, verified sender domain, FROM and monitored Reply-To. Set `CUSTOMER_EMAIL_PROVIDER=resend`, server-only key/sender/origins and restart. The API factory validates formats and exact origin alignment; only actual provider acceptance and inbox/link tests establish wiring.

At DNS, publish the exact SPF/DKIM records supplied for the chosen Resend domain. Preserve existing mail-provider SPF rather than adding conflicting root SPF records; verify the provider's requested hostname and alignment. Configure a reviewed DMARC record/report mailbox and progress enforcement based on observed legitimate mail. Resend documents the required SPF/DKIM verification; DMARC is additional domain policy. No DNS record was changed here. [Resend verified-domain setup](https://resend.com/docs/dashboard/domains/introduction).

Controlled test with a mailbox the operator owns: register a disposable staging customer, inspect actual From/Reply-To, SPF/DKIM/DMARC results in received headers, deliverability/bounce logs and rendering; follow `/verify-email#token=...`, explicitly redeem once and reject replay. Request password reset, redeem `/reset-password#token=...`, verify old password/sessions fail, then confirm login/logout and account disable/re-enable. Never copy tokens/keys into reports. API accepted != inbox received != verified account.

Auth mail uses an 8-second request timeout and a deterministic provider idempotency key derived from the random token, with no plaintext token stored. On failure/uncertain acceptance, the domain invalidates the new token and retains its generic acknowledgement; the user must request a fresh message. Late links can therefore be invalid. There is no durable outbox or automatic application retry job. Resend's idempotency is not a guarantee that this application will retry. [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).

For reset/verification, safe user re-request plus visible mail capability, rate limits, provider monitoring and a support process can be an intentional MVP policy. A durable outbox is not required merely to satisfy a checklist; adding one would require secure token lifecycle/encryption and retry semantics. Order/shipment notifications are **not implemented** by the auth mail adapter. Decide whether launch needs those messages or supervised manual communication; do not claim customers receive an automatic order email. Track rejection/bounce/complaint failures; any future Resend webhook requires verified signatures.

`CUSTOMER_REQUIRE_VERIFIED_EMAIL` remains the existing false default. Recommend enabling for both checkout and customer gacha after delivery/recovery is reliable, but this is an explicit owner decision. It also gates reward claims. Test the unverified account's sign-in, verification notice/re-request, blocked protected action, successful verification and retry. Do not enable the gate while email is unavailable, and do not manually mark random accounts verified to bypass it.

## Stripe and ordinary orders

**Live payments are not supported by the present adapter.** It accepts `sk_test_` only; `COMMERCE_TEST_CHECKOUT_ENABLED` is a test switch. There is no hidden live enablement variable, and this audit did not add one. A real-money launch needs a separately reviewed/tested live-mode transition, operational policy and external evidence. Existing hosted Checkout needs no frontend publishable key/Stripe.js. Secret/signing keys belong only to the backend.

Configure a Stripe test account and HTTPS staging endpoint `A/api/commerce/webhooks/stripe`; use the endpoint-specific signing secret. It is publicly reachable without customer auth or staff access challenges, but authenticates raw request signatures and processes provider events idempotently. Success/cancel URLs are generated from configured S and the order ID (`/orders/:id` with the implemented return query parameters), not caller-supplied arbitrary URLs. Confirm the actual URLs in the test Checkout Session. Hosted Checkout redirects are presentation, not proof of payment.

The adapter handles `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `refund.created`, `refund.updated`, `refund.failed` and `charge.refunded`. Register these current event names rather than every Stripe event. Verify deployment of the raw-body signature path, duplicates and unordered delivery. Return URLs are exactly `S/orders/:id?payment=return` and `S/orders/:id?payment=cancelled`. Stripe documents retry/order/signature requirements. [Stripe webhook guide](https://docs.stripe.com/webhooks).

No external Stripe test was possible with empty local API/signing keys. Once supplied in protected staging:

1. Set the test keys, gateway/origins, and explicit test checkout switch. Confirm `/api/commerce/v1/config` through the website reports TEST.
2. Register/verify a controlled customer, receive staging stock into an eligible FR location, publish the test listing, add to cart and inspect the backend quote: EUR, TTC, shipping, included VAT and immutable address/price snapshots.
3. Create Checkout and pay with Stripe's published test payment details. Confirm webhook delivery/signature handling, payment attempt/event and PAID order state, and reservation confirmation. A browser return alone must not mark it paid.
4. Replay the event and test out-of-order/refund/cancellation/expired-session cases. Confirm no repeated stock change and observe uncertain/late states through `commerce:maintenance`.
5. Admin prepares/picks the reserved location, manually buys the chosen carrier label outside the app, enters actual carrier/tracking and confirms dispatch. Exactly one SALE movement occurs; delivery does not deduct again.
6. Check customer order access/history and isolation from another customer; inspect logs for absence of session/token/card/secret data. Record provider event IDs, order IDs and outcome, not payment details.

Current fulfillment records carrier/tracking but does not buy labels or scrape carriers. Gacha rewards share shipment infrastructure but are not SaleListing orders. No automatic order/shipment email is implied. Returns/refunds require an explicit physical inventory operation when applicable, never a blind stock overwrite.

## Continuous sourcing and gacha acceptance

Run this as one supervised staging scenario in addition to the segment regression suites:

1. Use a controlled official-source fixture or manually reviewed official URL; select franchise/lineup and preserve source-language names/partial dates/provenance. Import only reviewed selected candidates. Generic extraction is implemented; site-specific adapters are not guaranteed.
2. Create a watch and verify zero ownership/target gap. Add a manual marketplace candidate, compare same-currency price, convert to Purchase and confirm inventory remains zero.
3. Receive purchase into JP; verify PURCHASE, unit cost/reference/actor and duplicate receipt protection. Create shipment, dispatch JP → dedicated transit, then deliver to the selected FR shelf/box. Verify total preserved and source/transit/final placement history.
4. Enter actual shipment/import costs and explicit FX/weights as applicable. Review/finalize landed costs; check MSRP is unchanged and history retained. Unknown costs stay unknown.
5. Approve a valid managed image, map public category, set EUR TTC listing price, review/publish and check website. Execute the Stripe test flow above OR allocate a staging no-charge gacha prize, then verify fulfillment and movements. Record identifiers linking every step.

The suites plus restore drill exercise these services and cross-application boundaries, but this phase does not claim a live official-site-to-Stripe scenario was completed without external credentials. A continuous external staging acceptance record remains required.

First no-charge gacha banner checklist:

- [ ] Owner approves participation model, eligible geography/accounts and versioned terms; no legal conclusion is inferred by code.
- [ ] Confirm global draw switch, customer switch, banner customer enablement, schedule and correct immutable configuration.
- [ ] Allocate actual eligible FR stock and verify storefront availability decreases by reservations, not by premature consumption. Confirm exact odds/fractions and depletion behavior; no hidden reroll or marketing odds.
- [ ] Authenticate the intended customer; enforce the chosen email policy; issue a bounded expiring no-charge authorization with reason. A ordinary paid order is not gacha entitlement.
- [ ] Execute one pull; verify exact receipt/reward, duplicate key protection, refresh/lost-response recovery and history ownership.
- [ ] Claim the reward with a real eligible address; admin prepares, manually buys label, records dispatch/tracking, then delivery. Confirm one GACHA movement and no fabricated SaleListing order.
- [ ] Verify pause stops new execution while ownership/recovery/fulfillment remain accessible. Paid pulls and x10 remain disabled.

Before any future real-money gacha: explicitly decide price/currency, entitlement/payment proof, geography, age/account policy if required, terms/version, odds/depletion behavior, refunds/cancellation and fulfillment/shipping charges. Those are missing business/technical gates, not legal advice or a flag to flip.

## Monitoring, alerts and incident response

No monitoring/error-reporting provider, dashboards, paging destination or deployed log pipeline is configured. Assign one responsible operator and one tested alert destination before customer launch. Minimum MVP implementation can use host/provider metrics, structured job output, sanitized proxy logs and external HTTPS probes; an enterprise stack is unnecessary.

| Signal | Proposed alert / response |
|---|---|
| HTTP 5xx and transaction timeouts | Alert sustained >1% over 5 min or repeated P2028; correlate request/time/route class, DB health and pool load. Tune against observed baseline. |
| Public list latency | Track p50/p95/p99; proposed p95 <2 s under agreed staging load. Alert >3 s for 5 min. Current scale/load findings still govern release decisions. |
| Dashboard latency | Track separately; alert recurring timeout/503, not just a slow averaged public metric. |
| DB pool waits/active connections | Alert sustained saturation or connection errors; count all replicas/jobs. Do not respond by increasing replicas beyond DB capacity blindly. |
| Stripe webhook/payment reconciliation | Alert repeated delivery/signature/processing failures, REVIEW backlog or failed/missing maintenance runs. Inspect provider dashboard and immutable event/order state before replay. |
| Gacha execution | Alert unexpected 5xx/uncertain-request growth. Recover existing request IDs; never reroll to “repair” a failure. |
| Email rejection/bounces/provider outage | Observe provider events and test delivery; pause verification-dependent launch if customers cannot recover accounts. Generic auth acknowledgements alone do not surface transport failures. |
| Inventory mismatch | Immediate operator alert; pause affected selling/pulls, compare movement/reservation/physical stock, then authorize a reasoned adjustment if needed. No automatic repair. |
| Media/disk | Alert >80% capacity or failed image reads/writes; verify mount and backups before deleting anything. |
| Backup/restore | Alert failed upload/encryption/checksum, missing daily backup, failed restore drill or inaccessible key. |

Proxy reference logs include generated request ID, method, path without query string, status and duration. Apply retention/access controls to path identifiers as well. Do not log request bodies, cookies, Authorization, passwords, email action fragments, gateway/Stripe/Resend keys or card data. Avoid debug database query logging in production; the scale profiler captures SQL only in isolated synthetic fixtures. Application errors return generic public messages; full error correlation and provider-specific alert integration remain incomplete. Choose the provider and connect alerts rather than merely storing logs.

Health endpoints: backend `/api/health` is process liveness; new `/api/ready` checks DB connectivity and returns generic 200/503. Website `/healthz` is liveness; `/readyz` checks backend readiness. These do not certify migration state, media persistence, email, Stripe or backup status. Bound polling and protect them from abuse. Execute provider-specific synthetic probes separately without revealing dependency details publicly.

First real ordinary order checklist (only after separately enabling/qualifying live commerce):

- [ ] Confirm live mode was deliberately implemented and approved; recheck exact price/tax/shipping and eligible FR stock.
- [ ] Supervise payment provider event and PAID state; browser redirect is insufficient.
- [ ] Verify one reservation, immutable snapshots and customer-only order access.
- [ ] Verify expected customer communication; auth-only email integration does not provide an order confirmation.
- [ ] Pick the recorded location, buy the chosen label manually, enter actual carrier/tracking and dispatch once.
- [ ] Verify SALE movement, customer status and inventory reconciliation; monitor refunds/cancellation separately.
- [ ] Record outcome and alert checks before increasing traffic.

## Content and DNS work

Actual app routes do not provide finalized Terms, Privacy, company/contact/business/VAT identifiers, shipping/returns/refund policies or a full finished rewards collection. The footer explicitly describes Stripe test checkout. Review/remove prototype wording and publish owner-approved content before customer launch; do not invent legal language. Determine cookie-consent needs from the actual tracking/tools eventually installed. No legal audit was performed.

DNS checklist: choose S/A; create provider-directed A/AAAA/CNAME (publish AAAA only if IPv6 actually works); validate TLS issuance/renewal; configure exact Resend DKIM/SPF/provider verification and reviewed DMARC; confirm sender alignment; verify inbound support mailbox. Protect DNS account access and document ownership. No DNS changes were made.
