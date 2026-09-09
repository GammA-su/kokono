# Environment and configuration inventory — Prompt 23

Inspected application source, config factories, scripts, tests, examples, Prisma config and the local Compose file in both repositories. Values below are placeholders, never copied credentials. There are no configured production domains/hosting files proving a deployed topology. `kokoni.example` is a reserved documentation placeholder, not a chosen domain.

Use [backend production template](../.env.production.example) and [website production template](D:/Project/kokoniv2/.env.production.example). `npm run ops:preflight` is a new non-mutating backend configuration/access check; it deliberately rejects HTTP public origins, short keys and absent verified database TLS. It does not certify external services or production readiness.

## Inventory legend

B = kokono-inv; W = kokoniv2. D/T/S/P = development/test/staging/production. R = required; C = required when the named capability is enabled; O = optional/default; — = omit. “Current validation” includes checks added in this phase. All runtime settings must be injected before process startup. Next and Prisma load conventional environment files; the website explicitly loads `.env`. A file named `.env.production.example` is **not** automatically active. Service-manager injection avoids ambiguous precedence. Node inherited environment takes precedence over `.env` defaults.

### Database, authentication, gateway, URLs, cookies

| Name | Project | D/T/S/P | Secret | Purpose; expected format; safe example | Current validation | Missing/invalid effect | Configure at / source |
|---|---|---|---|---|---|---|---|
| `DATABASE_URL` | B | R/R/R/R | Yes | PostgreSQL URI, URL-encoded user/password, optional validated `schema`; `postgresql://runtime:REPLACE@db.example/kokoni?sslmode=verify-full` | URL/schema in `src/db/client.ts`; TLS/credentials in production preflight | Database-dependent services fail | Backend runtime and migration command environment; `prisma.config.ts` reads the same name with the appropriate role |
| `TEST_DATABASE_URL` | B | O/R/—/— | Yes | Separate database ending `_test`; `postgresql://tester:REPLACE@localhost/kokoni_test` | Test scripts reject production, non-test name and development DB reuse | Integration tests refuse to run | Local/CI test secret, never production database |
| `BETTER_AUTH_URL` | B | R/R/R/R | No | Admin HTTPS origin; `https://admin.kokoni.example` | Better Auth base URL; preflight strict HTTPS origin | Development fallback is localhost; wrong callback/cookie/origin behavior | Backend service; `src/lib/auth.ts` |
| `BETTER_AUTH_SECRET` | B | R/R/R/R | Yes | Random 32+ characters; generate 48 random bytes | Auth factory length; preflight rejects obvious placeholders | Internal auth fails; signed CSV/bulk/import reviews unavailable | Backend secret store; also signs existing internal review tokens |
| `COMMERCE_GATEWAY_SECRET` | Both | C/C/R/R | Yes | Same random 32+ character value on both servers | Backend customer/commerce gateways enforce minimum and constant-time comparison; preflight | Accounts, checkout and customer gacha fail closed; public catalog can still browse | Both service secret stores; never `VITE_*` |
| `STOREFRONT_BASE_URL` | B | R/R/R/R | No | Public website HTTPS origin; `https://kokoni.example` | Public read helper, mutation exact-origin checks, email config, preflight | Wrong CORS/public links/payment returns; customer mutations rejected | Backend service |
| `SITE_ORIGIN` | W; optional B alias | R/R/R/R for W; O/O/O/O for B | No | Same origin as backend `STOREFRONT_BASE_URL`; `https://kokoni.example` | W rejects malformed origin and production HTTP; B email/preflight verifies alias matches | Website production startup fails if missing; wrong cookies/canonicals/links | Website service; optional backend email alias |
| `COMMERCE_API_ORIGIN` | W | R/R/R/R | No | Fixed backend HTTPS origin; `https://admin.kokoni.example` | Origin parser and new production HTTPS guard | Wrong/default localhost upstream; production HTTP startup rejected | Website service only; no general-purpose browser-selected proxy |
| `STOREFRONT_PRODUCT_ROUTES_READY` | B | O/O/R/R | No | Exact `true`/`false`; `true` after `/products/:slug` verified | Exact true check; explicit Boolean in preflight | “Open on Store” hidden; does not itself publish a listing | Backend service |
| `CUSTOMER_REQUIRE_VERIFIED_EMAIL` | B | O/O/R/R | No | Business gate, exact Boolean; existing default `false` | Exact true check; explicit Boolean in preflight | Default permits unverified checkout/free pulls; true requires working verification | Backend service; applies to checkout, customer gacha and claims |
| `NODE_ENV` | Both | O/R/R/R | No | `development`, `test`, `production` | Framework behavior; backend preflight requires production; W `npm start` sets it | Wrong build/runtime, test email safety or logging/cookie assumptions | Service manager/build/test runner |

There is **no separately configured customer-session secret, cookie domain or cookie signing key**. Customer session/token material is generated server-side; SHA-256 digests are stored. HTTPS uses `__Host-kokoni_customer`, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Internal Better Auth uses its separate session realm/base URL. Do not invent cross-subdomain customer cookies.

### Payments, email, merchandise and gacha

| Name | Project | D/T/S/P | Secret | Purpose; format; safe example | Current validation | Missing/invalid effect | Configure at / source |
|---|---|---|---|---|---|---|---|
| `COMMERCE_TEST_CHECKOUT_ENABLED` | B | O/C/C/R | No | Exact Boolean; production template `false` | Flag AND complete test-provider configuration | HTTP order/payment creation disabled; quotes remain usable | Backend service; `commerce/stripe.ts` |
| `STRIPE_SECRET_KEY` | B | C/C/C/— for live launch | Yes | Externally supplied `sk_test_...` only | Prefix/test mode; preflight rejects `sk_live_` | Payments disabled; live keys intentionally unusable | Backend secret store; no frontend publishable key needed for hosted Checkout |
| `STRIPE_WEBHOOK_SECRET` | B | C/C/C/— for live launch | Yes | Endpoint-specific `whsec_...` | Readiness prefix; actual signature validation | Webhook authentication/payment readiness fails | Stripe endpoint secret; CLI-forwarding secret is not deployed endpoint secret |
| `COMMERCE_POLICY_JSON` | B | O/O/O/O | No | Strict JSON with integer minor units/BPS; `{"shippingAmount":590,"freeShippingThreshold":8000}` | Zod schema and preflight | Invalid config rejects quote; omitted uses current France policy | Backend service; `commerce/policy.ts` |
| `CUSTOMER_EMAIL_PROVIDER` | B | O/disabled/C/C | No | `disabled` or `resend`; template `disabled` | Config factory enum | Disabled sends nothing; unsupported value rejects provider construction | Backend service |
| `RESEND_API_KEY` | B | C/—/C/C | Yes | Externally supplied `re_...` sending key | Key format; provider verifies actual permissions | No accepted delivery; enablement blocked | Backend secret store |
| `CUSTOMER_EMAIL_FROM` | B | C/—/C/C | No | Verified-domain mailbox or `Kokoni <accounts@your-domain>` | Email/header-injection validation | Provider setup fails or external sender rejected | Backend service + Resend domain dashboard |
| `CUSTOMER_EMAIL_REPLY_TO` | B | O/—/O/O | No | Plain monitored mailbox; `support@kokoni.example` | Email and CR/LF validation | Omitted: no explicit Reply-To | Backend service |
| `CUSTOMER_EMAIL_SITE_NAME` | B | O/O/O/O | No | Nonempty 1–80 character label; `Kokoni` | Config length/newline checks | Defaults Kokoni | Backend service |
| `MERCHANDISE_UPLOAD_DIR` | B | O/O/R/R | No | Absolute persistent writable directory; `/var/lib/kokoni/media` | Runtime key/path checks; preflight absolute path and access | Defaults to project `.local/uploads`, which can be lost on deployment | Backend and any same-host jobs; persistent mount and backup configuration |
| `GACHA_DRAWS_ENABLED` | B | O/C/R/R | No | Exact Boolean; template `false` | Existing default is enabled unless exact false; preflight requires explicit Boolean | False stops new draws; existing award recovery/fulfillment remains | Backend service; `gacha/validation.ts` |
| `GACHA_CUSTOMER_EXECUTION_ENABLED` | B | O/C/R/R | No | Exact Boolean; template `false` | Explicit opt-in plus global flag | Customer draws disabled; no effect on historical ownership | Backend service |

Shipping/tax defaults are **FR mainland, EUR, TTC, 20% included merchandise VAT, €5.90 TTC shipping, free from €80.00 TTC merchandise, 20% included shipping VAT**, reservation 60 minutes. Policy JSON also accepts `version`, `deliveryMethod`, `categoryVatRates`, rates and threshold settings. `supportedCountries`, `currency`, `zone` currently constrain the policy to FR/EUR/FR_MAINLAND; listing another country in JSON is not a supported feature. Address validation excludes Corsica/overseas. No separate `SUPPORTED_COUNTRIES`, VAT, FX or carrier API environment names exist. Accounting policy was not changed.

Paid gacha is disabled in validation/database constraints, not merely hidden by a flag. Free execution additionally needs enabled banner, valid schedule/configuration, allocated eligible stock and an expiring administrator-issued customer authorization. A stored pull price is not a payment integration.

### Tools, process manager and framework variables

| Name | Project | D/T/S/P | Secret | Purpose; format; safe example | Validation / missing behavior | Configure at |
|---|---|---|---|---|---|---|
| `PORT` | W; Next CLI conventional B | O/O/R/R | No | Listener integer, e.g. W `5173`, B `3000` | W number conversion/listener; Next CLI. Validate valid/unused port during deployment | Service process; prefer explicit backend `npm start -- --hostname 127.0.0.1 --port 3000` |
| `HOST` | W | O/O/R/R | No | Bind address; `127.0.0.1` reference | OS listener validates; default loopback | Website process; container networking requires deliberate change |
| `TRUSTED_PROXY_IPS` | W | O/O/C/C | No | Immediate proxy literal IPs only; `127.0.0.1,::1` for the nginx reference | Startup validation; only a matching socket peer may supply one valid overwritten X-Forwarded-For IP; chains/hostnames ignored | Website service; omit for direct access. Proxy must overwrite incoming headers and origin listeners must be isolated |
| `ALLOW_DEVELOPMENT_SEED` | B | O/—/—/false | No | Exact opt-in `true` only for demo seed | Seed refuses production; preflight rejects true | Local only; never launch with demonstration data |
| `PROVISION_NAME` | B | C/C/C/C one-time | No | Administrator name 1–200 chars; `Store owner` | Provisioning schema; absent rejects | Ephemeral bootstrap command environment |
| `PROVISION_EMAIL` | B | C/C/C/C one-time | PII | Admin mailbox; `owner@kokoni.example` | Email schema, normalized uniqueness | Ephemeral bootstrap environment; existing accounts not overwritten |
| `PROVISION_PASSWORD` | B | C/C/C/C one-time | Yes | 12–128 character password, preferably password-manager generated 24+ chars | Provisioning schema + library hashing; absent rejects | Ephemeral environment; unset immediately, never template/default credential |
| `PUBLIC_WEBSITE_PATH` | B | O/O/—/— | No | Path to sibling website; `../kokoniv2` | Verification scripts resolve path; missing project fails tests | Local/CI tests only |
| `PLAYWRIGHT_CHANNEL` | Both | O/O/—/— | No | Installed browser channel; `msedge` | Playwright checks installation; scripts otherwise use their existing default | Local/CI browser tests |
| `VITEST` | B tests | —/runner/—/— | No | Test-runner marker | Disables runtime email transport; never set in production | Vitest only |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | B local Compose | local/—/—/— | Password yes | Official image initialization settings | Local `compose.yaml` defines development-only values; changing initialized container env does not rotate an existing DB password | Local Docker Compose; not a production database deployment |

No application-owned `VITE_*` environment variables are required. Framework-derived Vite `import.meta.env` values are browser-public. Standard OS/Node/npm/Prisma tool variables (PATH, CA configuration, npm proxy, telemetry controls) are not application settings; configure their provider-specific use separately rather than placing secrets in frontend bundles.

**Absent configuration categories:** no chosen monitoring/error-reporting DSN, object-storage credentials, automatic-label credentials, backup destination/key, scheduler provider or application-wide public rate-limit setting exists. These are deployment decisions and/or the reference deployment files below, not secretly configured services. The new trusted-proxy setting still needs deployment-specific values. Database pool size 10, connect timeout 5 s, idle pool timeout 30 s are centralized code settings. Customer abuse limits are centralized database-backed policy, not environment overrides. Existing gacha reservation lifetimes are domain state, not invented cleanup flags.

## Secrets to provision and rotate

Generate independent Better Auth and gateway secrets using the existing Node runtime:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Run this locally into an approved secret manager, not into CI logs, a shared transcript, source control or a command-line argument containing the resulting secret. It generates 384 bits (64 base64url characters), above the enforced 32-character minimum. Use separate random database-role passwords (at least 32 random bytes) and a password manager for the one-time administrator password. URL-encode the database password. No generated production secret is supplied by this audit.

Stripe keys/webhook secrets and Resend sending keys come from their providers; do not manufacture values with matching prefixes. Backup encryption keys and storage credentials depend on the chosen backup/storage service. There is no current Sentry DSN or frontend Stripe publishable key requirement.

Gateway rotation currently supports one active key: coordinate both service restarts, expect a brief gateway failure window, then rerun account/quote/recovery checks. Better Auth rotation invalidates sessions and outstanding signed internal review tokens; plan staff reauthentication/review recreation. Customer session digests are separate. Resend rotation should deploy the new sending key, verify controlled delivery, then revoke the old key. Stripe endpoint signing-secret rotation must account for the current **single configured secret** and in-flight retries; use a controlled maintenance window or add tested dual-secret support before overlapping rotation. Do not enable live Stripe while rotating.

## Observed local configuration, not production certification

At inspection, backend `.env` contained local DB/auth/gateway/site settings; Stripe secret/signing-secret fields were empty, and no Resend key/provider/sender was configured there. No actual secret values were printed. External Stripe payment and email-delivery tests therefore could not be performed. Production/staging hosts, provider accounts, DNS and mail recipients were not established by the repository. Their values remain operator decisions.
