# Prompt 24 — local production hardening addendum

This supersedes the performance, migration, role, email, selector and flag rows in
[production-readiness.md](production-readiness.md). Everything else in that assessment still
stands. No deployment, DNS change, live payment, production inventory change or paid gacha
enablement occurred in this pass.

New handoff documents: **[vps-handoff.md](vps-handoff.md)** (only what cannot be done locally) and
**[environment-handoff.md](environment-handoff.md)** (secret-free settings inventory).

Verification at the end of the pass: **365 tests passed across 38 files**, lint clean, both
production builds pass.

---

## Pending migration — applied

`20260913120000_audit_query_indexes` was inspected, applied through `prisma migrate deploy` (never
`db push`) after a `pg_dump` backup, and verified: both indexes report `indisvalid`, `migrate
status` reports checksums matching, and the suite passed afterwards.

## Root cause of the storefront performance ceiling

Earlier work assumed stock aggregation was the cost. `EXPLAIN (ANALYZE, BUFFERS)` at 50k listings
attributed the 2,960 ms page as: base joins and filters 181 ms, slug regex 27 ms, stock aggregate
over 150,000 balances **124 ms**, and the managed-media `storage_key` regex **1,491 ms** — one
regex evaluation per candidate row, 50,000 times.

Three changes followed, and the third matters more than the other two:

1. **`item_images_public_managed_idx`** (migration `20260914120000_public_listing_media_index`) — a
   partial index whose predicate is the same regex, so the pattern is evaluated at write time
   instead of once per row read.
2. **Stock is aggregated for the page's rows only** when no availability filter is applied, since
   only those rows are ever projected. Both phases share one `RepeatableRead` snapshot, so a
   restricted aggregate cannot observe stock the selecting query could not. Availability filtering
   still uses the catalog-wide aggregate, because there it decides row membership. Public
   eligibility remains one shared expression and is not duplicated.
3. **The pattern reaches the planner as a SQL literal, not a bind parameter.** With the regex bound
   as `$5`, PostgreSQL cannot prove the query predicate implies the partial-index predicate under a
   generic plan; it silently falls back to `Seq Scan on item_images` and the page returns to
   ~2,100 ms with no error and no failing test. This regressed twice during the pass before being
   isolated. `tests/publication.media-index.test.ts` now asserts both that the migration predicate
   is byte-identical to `managedImagePattern.source` and that the query emits it as a literal.

Facets now derive all three projections from one materialized visible set instead of running three
independent eligibility scans.

The dashboard was split by measurement, not guesswork: `inventoryValue` 968 ms, `acquisition`
694 ms and `retail` 607 ms are whole-ledger valuation. They now load after the operational panels
through a Suspense boundary and are labelled with their own computation time. They are computed
live, not cached, so no stale figure is presented as current.

## Measured before/after — same 50k fixture

Single calls with the full history fixture (1,000 orders, 3,000 reservations, 400 rewards):

| Call | Before | After |
|---|---:|---:|
| Public listing page | 2,396 ms | **337 ms** |
| Public listing, repeat | 2,489 ms | **347 ms** |
| Public facets | 4,116 ms | **360 ms** |
| Public detail | 44 ms | **22 ms** |
| Dashboard, operational | 9,326 ms | **1,779 ms** |
| Dashboard, valuation (loaded after) | included above | 2,179 ms |
| Catalog page / search / deep page | 92 / 458 / 118 ms | 85 / 428 / 122 ms |

Controlled mixed load: 12 workers, 70 operations, 10-connection pool. Peak 10 connections /
10 active / 2 waiting. **Zero failed operations, zero prize-ledger mismatches.**

| Operation | p50 before | p50 after | p95 before | p95 after |
|---|--:|--:|--:|--:|
| Listings | 4,330 | **541** | 4,500 | **660** |
| Product detail | 155 | 41 | 1,679 | **124** |
| Cart resolution | 170 | 42 | 233 | 121 |
| Login | 279 | 234 | 641 | 396 |
| Quote → reserve → cancel | 493 | 208 | 725 | 421 |
| Popular banner odds | 55 | 38 | 215 | 100 |
| Customer pull | 170 | 133 | 1,989 | 254 |

Nothing regressed. These remain short local domain/DB measurements on development hardware with
ten observations per group — not sustained HTTP/TLS capacity, and not a substitute for qualifying
the target host.

## Database roles — proven, not just documented

`npm run ops:roles` provisions `kokoni_migrator` / `kokoni_runtime` / `kokoni_backup` on a
disposable database, applies the documented grants and asserts **23/23** expectations. The runtime
role performs ordinary application DML but is denied `CREATE TABLE`, `DROP`, `ALTER`, `TRUNCATE`,
`CREATE INDEX`, reading or writing `_prisma_migrations`, disabling ledger triggers, dropping the
protection functions, rewriting or deleting ledger history, `CREATE ROLE`, self-granting
`SUPERUSER` and `CREATE EXTENSION`. The backup role reads everything, including customer records,
and writes nothing.

## Email — real provider, real delivery

A **configuration defect** was found and fixed. `CUSTOMER_EMAIL_FROM` was `contact@iosys.fr`, an
apex domain that is *not* verified in Resend; the only verified domain is `mail.ex1j.iosys.fr`.
Every send would have been rejected by the provider, and it would have surfaced only in production.

With the sender corrected to `noreply@mail.ex1j.iosys.fr`, verification, password-reset,
order-confirmation and shipment emails were all **delivered** to `contact@iosys.fr`. Resend reports
DKIM and both SPF records verified; the organisational domain publishes `DMARC p=reject`, so
delivery into that inbox is practical evidence of alignment.

Failure paths were exercised against the real provider: invalid credential, unverified sender,
timeout and invalid recipient all fail with one generic message and no leakage. A replayed message
carrying the same token **collapsed to a single email at the provider**, confirming the idempotency
key works end to end.

Remaining: reading the raw `Authentication-Results:` header (needs mailbox access), and verifying
the apex domain only if the customer-facing sender must be `contact@iosys.fr`.

## Verification policy — all three options implemented

`CUSTOMER_VERIFICATION_POLICY` is `off` | `gacha` | `all`, replacing a single boolean that could
express only two of the three. The legacy `CUSTOMER_REQUIRE_VERIFIED_EMAIL` still works (`true` =
`all`), and an unrecognised value is refused rather than failing open — a typo must not silently
remove a gate the operator believed was configured.

**Owner decision: `gacha`.** Checkout stays open; gacha pulls and reward claims require a verified
address.

Note on precedence: the new variable wins over the old boolean. Two fixtures and two test suites
expressed "no gate" through the old boolean and began failing when the policy was set — that is the
gate correctly biting, and they now pin the policy explicitly rather than depending on ambient
configuration.

## Order and shipment email — implemented

Payment confirmation and shipment notification now send through the existing Resend transport.

Both are raised **after** their transaction commits. An external call inside a commerce transaction
would hold inventory and order locks for the length of a network request, and a mail failure must
never roll back a payment Stripe has already taken or a dispatch that has already consumed stock —
so `notifyOrder` deliberately swallows provider errors. Replay is guarded twice: the existing
`paidAt`/`paymentStatus` guard, and a provider idempotency key derived from the order number. No
marketing capability was added.

## New operator tooling

| Command | Purpose |
|---|---|
| `npm run ops:status` | Version, DB connectivity, non-owner role check, media mount round-trip, pending migrations, maintenance signals, ledger agreement, flag states, secret presence. Reports whether things work, never the values that make them work |
| `npm run ops:roles` | Provisions and tests the production role model on a disposable database |
| `npm run media:review` | Classifies every managed image: approved-and-deliverable, valid-not-approved, unreadable, unmanaged. Never approves or repairs anything |
| `npm run test:customer-email -- --to <addr>` | Real controlled provider send plus the failure matrix |
| `npm run ops:preflight -- --local-infrastructure` | Rehearses production config locally, deferring only public HTTPS and TLS-database checks and naming them in its output |

The preflight relaxation is a command-line flag, never an environment variable, so no deployed
process can weaken its own preflight. Run strictly against the local production-like profile it
still fails on exactly the three infrastructure checks — the production gate is unchanged.

## Decisions taken on evidence

**pg_trgm was evaluated and not adopted.** A GIN trigram index cut a ≥3-character ASCII substring
search from 103 ms to 3.2 ms, but gave **no** benefit for two-character terms (86 → 89 ms) — and
two-character Japanese queries are exactly what this catalog will receive. The real search is an OR
across nine columns plus `unnest(aliases)`, which would need nine GIN indexes and write
amplification on every catalog edit, for no gain on the common case. Catalog search is 428 ms at
50k items. Revisit only behind a single denormalized NFKC search column.

**Selector truncation fixed.** Lineup and character selectors were capped at 500 options with no
indication, so at 5,000 lineups an operator simply could not select most of them. They are now
searched server-side, capped at 200 with the true total shown, and the currently applied option is
always retained — otherwise reloading a filtered page would silently clear the filter.

## Also verified this pass

- **Feature flags fail closed in the domain layer**, not just the UI: only a literal `"true"`
  enables checkout, the Stripe provider refuses to construct when disabled, live keys are refused
  regardless of flags, customer execution cannot re-enable draws the global switch turned off, and
  paid gacha is unavailable under every combination of switches.
- **Maintenance jobs are idempotent** — commerce ×3 and customer ×2 produce identical results and
  exit 0. `inventory:reconcile` detected a deliberately isolated balance/ledger mismatch, reported
  the item and location, **exited 1, and repaired nothing**; it returned to 0 only after the drift
  was corrected by hand.
- **Media persists across rebuild and restart** with the directory outside build output.
- **Log sanitization is a regression test** covering config validation, unexpected commerce
  failures, email idempotency keys and forged correlation headers. It also established that the
  `Headers` API rejects newline injection before a request can even be constructed.
- **Request correlation**: one id generated at the storefront edge, forwarded through both proxies,
  honoured by the backend only when well-formed, and returned to the customer as an opaque
  `reference` on unexpected failures only. Domain errors are unchanged; no stack trace is exposed.

## Known gaps this pass did not close

- ~~Stripe TEST end-to-end was not executed.~~ **Now closed** — a full external test-mode purchase,
  webhook, dispatch and refund were qualified against real Stripe. See
  [stripe-test-qualification.md](stripe-test-qualification.md).
- **The full sourcing-to-sale and gacha scenarios were not re-run** end to end in this pass. Their
  Prompt 23 evidence stands but predates these changes.
- **The reverse-proxy topology was not exercised locally**; forwarded-header handling remains
  unit-tested only.
- **Commerce reconciliation timing under realistic history was not measured** — the job reports
  `disabled` while checkout is off.
- **Crash/restart recovery and the focused abuse-test matrix were not re-run** in this pass.
- **Pre-existing schema drift**: `purchase_watch_checked_idx` and the `customer_events_actor_fk`
  foreign key exist in the database but not in `schema.prisma`. Harmless today, but a
  shadow-database replay would not recreate them.
