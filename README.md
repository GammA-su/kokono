# Kokono merchandise domain

Internal Japanese anime merchandise catalog, location-aware inventory, and independent public sale listings. The backend includes catalog, sourcing, inventory, commerce, customer accounts and gacha services. The separate kokoniv2 website consumes its public and authenticated customer APIs.

Current operational assessment: [production readiness](docs/production-readiness.md), [environment configuration](docs/environment.md), [deployment](docs/deployment.md), and [runbooks](docs/runbooks.md). These supersede historical phase limitations below; live commerce is currently test-only.

## Stack and structure

- Next.js 16 App Router and TypeScript, with protected admin pages, a login screen, `/api/health`, private media, and Better Auth's `/api/auth/*`.
- PostgreSQL and Prisma 7, using the PostgreSQL driver adapter.
- Better Auth with explicitly provisioned internal accounts; public signup is disabled.
- Zod for runtime validation at mutation boundaries; Vitest for unit and PostgreSQL integration tests.

```
prisma/schema.prisma                 relational model and indexes
prisma/migrations/                   generated schema plus PostgreSQL constraints/triggers
prisma/seed.ts                       opt-in, repeatable development examples
src/db/client.ts                     injectable database client for server/CLI/tests
src/lib/                            server-only database, sessions, authorization and service wiring
src/modules/catalog/                catalog creation, bulk item entry, catalog queries/presentation, duplicate detection, SKUs, partial dates
src/modules/lineups/                paginated queries, lineup mutations, source management and form actions
src/components/admin/               shared dense admin components and forms
src/app/admin/merchandise/          dashboard, franchises, lineups, catalog and inventory
src/app/admin/inventory/            inventory overview, movement forms and storage-location management
src/modules/inventory/               atomic operations, validation, ownership totals, reconciliation
src/modules/locations/               authorized location creation and hierarchy changes
src/modules/publication/             listing mutations, public field allowlists and fulfillable locations
src/modules/internal/actions.ts     authenticated Next.js server actions
src/modules/auth/                    account authorization and CLI provisioning
tests/                              domain, authentication and database integration checks
docs/domain-model.md                 business conventions and future extension points
```

Prisma 7 is pinned because the selected Better Auth adapter declares support through Prisma 7. ESLint 9 is pinned to the peer range supported by the Next.js React/import lint plugins; move to ESLint 10 when those plugins support it. Two scoped package overrides update Prisma tooling's `deepmerge-ts` and `mysql2` dependencies to patched releases. The Prisma configuration uses plain objects, not the Map behavior changed in DeepmergeTS 8. Revisit these overrides when upgrading Prisma. Commit `package-lock.json` and use `npm ci` for reproducible installs.

`src/db/sequential-pg.ts` queues statements within each Prisma transaction to avoid overlapping queries on one PostgreSQL connection ([upstream Prisma issue](https://github.com/prisma/prisma/issues/29407)). Separate connections remain concurrent. This compatibility adapter also queues savepoints and cleanup, and allows rollback after a query failure. Revisit it when upgrading Prisma. After changing the database adapter, restart `npm run dev` because development caches the database client across hot reloads.

## Local setup (PowerShell)

Requires Node.js 22.18+ (Node.js 24 used for verification), npm, and Docker Compose or an existing PostgreSQL database.

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Put the generated value into `BETTER_AUTH_SECRET` in `.env`. The example intentionally has no usable authentication secret. `.env` is gitignored.

```powershell
npm run db:up
npm run db:generate
npm run db:deploy
```

Compose provides **project-local development databases** `kokono_dev` and `kokono_test`, bound to `127.0.0.1:55432`. It does not use or modify any PostgreSQL service already on port 5432. The credentials in Compose and `.env.example` are for this local container only. The named volume preserves data across restarts. The test database initializer runs when the volume is first created.

For an existing PostgreSQL installation, create separate development and test databases and configure their URLs. A URL may include `?schema=some_schema`; schema names must be lowercase SQL identifiers. Prisma queries and raw domain SQL use the same schema.

To add development examples, set `ALLOW_DEVELOPMENT_SEED=true`, then run:

```powershell
npm run db:seed
npm run dev
```

Open `http://localhost:3000/admin/merchandise/lineups` to manage lineups; sign-in is required. Use the origin configured in `BETTER_AUTH_URL` for login. `GET http://localhost:3000/api/health` returns `{"status":"ok"}`; this is a process health check, not a database readiness check.

See [the admin interface guide](docs/admin-lineups.md) for filtering, dates, images, source management, duplication, safe deletion, and the bulk merchandise entry grid reached with **Add items** on a lineup. See [the catalog guide](docs/admin-catalog.md) for the visual merchandise catalog at `/admin/merchandise/catalog`, its status badges, stock summaries, search, filters and item detail pages.

## Development examples

See [catalog CSV import/export](docs/catalog-csv.md) for lineup exports, filtered/selected catalog exports, previewed imports, duplicate decisions, supported columns and protected update policies. No stock is imported through catalog CSV.

Use `/admin/watchlist` for the [private PurchaseWatch sourcing workflow](docs/admin-watchlist.md): quantity gaps, geographic stock, quick updates and external marketplace searches. Apply migration `20260907230000_watchlist_geography` with `npm run db:deploy` before starting the updated application.

See [the inventory and physical storage guide](docs/admin-inventory.md) for `/admin/inventory`, hierarchical locations, receive/transfer/removal commands, acquisition valuation, and filtered movement history.

The sample Re:Zero / Marine Ver. 2026 catalog is illustrative, not a verified official release. It contains Rem, Ram and Emilia, the requested category examples, and these items:

| Item | Watch | Owned | Listing |
| --- | --- | --- | --- |
| Rem Acrylic Stand | Enabled, quantity 5, maximum JPY 1,000 | 0 | None |
| Ram Acrylic Stand | None | 3 in JP-WAREHOUSE | None |
| Emilia Acrylic Stand | None | 3 at FR-HOME, 2 in Box A1 | Published, EUR 25.00 |
| Rem and Emilia Clear File | None | 0 | None |

The fourth item demonstrates the completely catalog-only state and a multiple-character item. The location tree includes `FR-HOME → Shelf A → Box A1`, plus `JP-WAREHOUSE` and `IN-TRANSIT`.

Seeds use upserts and fixed inventory operation keys. Rerunning preserves existing edits and does not add stock twice. Placeholder image keys are metadata only; no images are uploaded. Seeding never creates users, passwords, or sessions, and refuses to run with `NODE_ENV=production` or without its explicit opt-in.

## Provisioning an internal account

There are no demo login credentials. A trusted operator provisions an account through the CLI. Set `PROVISION_NAME` and `PROVISION_EMAIL`, then use a masked password prompt:

```powershell
$env:PROVISION_NAME = "Your name"
$env:PROVISION_EMAIL = "you@example.com"
$provisionSecret = Read-Host "New internal account password (12–128 characters)" -AsSecureString
$provisionCredential = New-Object System.Management.Automation.PSCredential('provision', $provisionSecret)
try {
  $env:PROVISION_PASSWORD = $provisionCredential.GetNetworkCredential().Password
  npm run auth:provision
} finally {
  Remove-Item Env:PROVISION_PASSWORD -ErrorAction SilentlyContinue
  $provisionSecret.Dispose()
}
```

The script hashes the password through Better Auth and creates its credential account relation. Existing accounts are never overwritten or silently promoted. Sign in at `/login` with the provisioned account. No default admin credentials or authentication bypass are installed.

Every internal server action checks its session and an active `isInternal` database membership. Request input cannot set the actor or grant internal membership. Services recheck membership inside transactions. Disabling `User.active` or clearing `User.isInternal` immediately blocks subsequent internal operations. Deactivate users with inventory history instead of deleting them.

## Database changes and validation

The initial migrations are:

1. `20260907144108_core_domain` — enums, tables, foreign keys and indexes, including Better Auth tables.
2. `20260907145000_domain_constraints` — partial dates, monetary values, movement shapes, nonnegative stock, immutable history, and hierarchy protection.
3. `20260907154208_lineup_sources` — multiple lineup source records and indexes for release management.
4. `20260907170000_item_release_date` — per-item release date, its precision enum, the matching partial-date check constraint, and its index.

Create future migrations with `npm run db:migrate -- --name descriptive_name`. Review generated SQL and add SQL constraints when Prisma cannot express a rule. Apply reviewed migrations with `npm run db:deploy`. Do not substitute `prisma db push`: it does not install the history and hierarchy triggers maintained in SQL migrations.

Migration `20260907213000_inventory_management` adds outgoing GACHA support and an index for latest acquisition costs. Apply it before using the inventory management interface.

```powershell
npm run db:format
npm run db:validate
npm run db:generate
npm run typecheck
npm run lint
npm test
npm run build
npm audit
```

With the local server running, `npm run test:admin-http` checks authenticated admin routes and anonymous access controls. It provisions a temporary local verification account and an empty sample lineup, then deletes only those temporary records. It refuses production, non-loopback hosts, and databases whose names do not end in `_dev`. This is HTTP verification, not browser visual testing.

Tests require `TEST_DATABASE_URL`, insist on a database name ending in `_test`, and reject the development database as a target. Each run creates a unique test schema, applies **all real migrations**, and removes only that schema afterward. They never truncate development tables. Tests cover stock races, idempotency, transfer rollback, immutable history, partial dates, independent prices, public data filtering, and real Better Auth sign-in.

Use a separate migration owner and a non-owner, non-superuser application role for production. Grant only the required table operations; the application does not need schema changes, ledger UPDATE/DELETE/TRUNCATE, or user-provisioning access through a public endpoint. Database owners can bypass database protections and should not be used by public application processes. Configure production PostgreSQL backups and restore procedures before live inventory is entered.

See [marketplace candidate tracking](docs/marketplace-candidates.md) for manual offers, price comparison and conversion into purchasing records. Apply migration `20260908180000_marketplace_candidates` before using this workflow.

See [storefront publication](docs/storefront-publication.md) for the shared review, France availability, approved image delivery, API v1, migration and remaining website work.

See [customer checkout](docs/customer-checkout.md) for Stripe test setup, France-only TTC policy, orders, reservations, dispatch/refund operations and scheduled reconciliation. The local checkout migration is applied; Stripe credentials are still required.

## Deferred work

Live payments, customer accounts/recovery emails, automated source checks and marketplace watching, inventory lots/conditions, and merchandise sets/variants remain deferred. The existing public website now supports catalog browsing and guest checkout in Stripe test mode, subject to configuration. The new admin navigation includes supporting dashboard, franchise creation/listing and inventory views; the full management workflows are Lineups, bulk merchandise entry and the merchandise catalog. Catalog and Lineup pages support [bulk merchandise management](docs/bulk-management.md) through the existing domain services, including stock movements, watches, publication review, metadata changes, export and archival. Individual item details remain a read view. Bulk entry records one initial source and one primary image per item; further sources, additional images and image approval remain per-item work. Images use a private local filesystem adapter that requires a persistent volume in hosted environments; an object-storage adapter can replace it later. See [the domain model](docs/domain-model.md) for extension design. No public deployment has been created.
