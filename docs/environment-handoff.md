# Environment handoff — what each value is and where it comes from

Secret-free by construction: this document names settings and states where their values originate.
It contains no keys, passwords or connection strings, and none should ever be added to it.

Templates: [`.env.production.example`](../.env.production.example) (backend) and the equivalent in
`kokoniv2`. A local production-like rehearsal profile can be generated at `.env.production.local`;
it is covered by `.gitignore` and must never be deployed.

Validate any candidate configuration before deploying it:

```bash
npx tsx --env-file=<file> scripts/production-preflight.ts
```

The strict form is the real gate. `--local-infrastructure` exists only for rehearsing on a machine
with no public DNS or TLS; it defers exactly three checks, names them in its output, and cannot be
switched on by an environment variable — so a deployed service cannot weaken its own preflight.

---

## A. Values you can choose now

Nothing external is required for these. Decide them and they are done.

| Setting | Meaning | Guidance |
|---|---|---|
| `CUSTOMER_EMAIL_SITE_NAME` | Name shown in email subjects and headers | Currently `Kokoni` |
| `COMMERCE_POLICY_JSON` | Shipping, VAT and reservation policy | France mainland / EUR / TTC defaults are in the template. Amounts are integer minor units, rates are basis points. Confirm the figures are the ones you actually trade on |
| `CUSTOMER_VERIFICATION_POLICY` | `off` \| `gacha` \| `all` | **You chose `gacha`**: checkout stays open, gacha pulls and reward claims require a verified address. All three are implemented and tested; switching is a config change |
| `ALLOW_DEVELOPMENT_SEED` | Synthetic demo merchandise | Must be `false`. The preflight rejects `true` |
| `STOREFRONT_PRODUCT_ROUTES_READY` | Storefront exposes `/products/:slug` | `true` |
| `COMMERCE_TEST_CHECKOUT_ENABLED` | Stripe **test** checkout | Keep `false` until section D is provisioned and section 10 of the VPS handoff is verified. Live payments are refused in code regardless |
| `GACHA_DRAWS_ENABLED` | Global gacha switch | `false` until a banner is deliberately launched |
| `GACHA_CUSTOMER_EXECUTION_ENABLED` | Customer-executed pulls | `false` until the same point. Paid gacha does not exist and no flag enables it |
| `NODE_ENV` | Runtime mode | `production` |

## B. Values generated randomly

Generate **independently per environment** — staging and production must never share a value, and
none of these may be committed or pasted into a ticket.

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

| Setting | Notes |
|---|---|
| `BETTER_AUTH_SECRET` | Admin session signing. Rotating it invalidates all staff sessions |
| `COMMERCE_GATEWAY_SECRET` | Shared server-to-server secret between kokoniv2 and kokono-inv. **The exact same value must be set in both**, and it must never reach the browser bundle |
| PostgreSQL role passwords | For `kokoni_migrator`, `kokoni_runtime`, `kokoni_backup`. Create them outside SQL history, source control and CI logs |
| Backup encryption key | Store in a password manager, **not on the VPS** — a key kept only on the host is lost with the host |

Preflight enforces at least 32 characters and rejects placeholder text.

## C. Values obtained from Resend

| Setting | Where it comes from | Status |
|---|---|---|
| `RESEND_API_KEY` | Resend dashboard → API keys | Present and working; a production key should still be issued separately |
| `CUSTOMER_EMAIL_FROM` | Must be on a **verified** domain | `Kokoni <noreply@mail.ex1j.iosys.fr>` — verified, DKIM and both SPF records confirmed, real mail delivered |
| `CUSTOMER_EMAIL_PROVIDER` | `resend` or `disabled` | `disabled` stops all sending and is the safe default until the sender is settled |
| `CUSTOMER_EMAIL_REPLY_TO` | A mailbox a person reads | `contact@iosys.fr` |

> The apex `iosys.fr` is **not** verified in Resend. Sending from `contact@iosys.fr` would be
> rejected by the provider. That mismatch existed in the configuration before this pass and would
> have failed only in production.

## D. Values obtained from Stripe

Test mode only. `sk_live_` is refused by the code, and there is no flag that enables live commerce.

| Setting | Where it comes from | Format |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys, **Test mode** | `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | Created when you add the webhook endpoint | `whsec_…` |

The endpoint URL is `https://A/api/commerce/webhooks/stripe`, so this value cannot be obtained until
**A** exists publicly. Both must be present, or `COMMERCE_TEST_CHECKOUT_ENABLED=true` fails preflight.

## E. Values provided by the VPS / PostgreSQL

| Setting | Where it comes from |
|---|---|
| `DATABASE_URL` | Provider host, port, database name and the `kokoni_runtime` password. Must end in `?sslmode=verify-full`; the password must be URL-encoded |
| `MERCHANDISE_UPLOAD_DIR` | An absolute path on a persistent volume **outside** the release directory, e.g. `/var/lib/kokoni/media`, owned by the runtime user |
| `TRUSTED_PROXY_IPS` | Literal IPs of the immediately connected proxy only. Never `*`, never a public client address, never an unreviewed CDN range |

The migration and backup roles use their **own** URLs. The long-running application must never run
as `kokoni_migrator`.

## F. Values dependent on the final domain

None of these can be filled in until S and A are chosen. All are validated by the preflight, which
rejects HTTP, credentials, paths, query strings, fragments and reserved `.example` hostnames.

| Setting | Project | Value |
|---|---|---|
| `STOREFRONT_BASE_URL` | backend | `https://S` |
| `SITE_ORIGIN` | backend (optional) | `https://S` — if set, must match `STOREFRONT_BASE_URL` exactly |
| `BETTER_AUTH_URL` | backend | `https://A` |
| `SITE_ORIGIN` | kokoniv2 | `https://S` |
| `COMMERCE_API_ORIGIN` | kokoniv2 | `https://A` |

Same scheme, hostname and port on both sides — these determine canonical URLs, CORS, cookie scope,
auth callbacks and the links inside customer emails. A mismatch does not fail loudly; it produces
emails whose links point at the wrong host.

---

## Quick check before deploying

```bash
# Must PASS with no relaxation on the real host:
npx tsx --env-file=/etc/kokoni/backend.env scripts/production-preflight.ts

# Must report connectivity, a non-owner runtime role, a writable mount and no pending migrations:
npm run ops:status
```
