# VPS handoff

Everything in this document is work that **could not be completed on localhost**. Anything that
could be built, configured, measured or tested locally was done in the Prompt 24 hardening pass
and is recorded in [production-readiness.md](production-readiness.md); it is not repeated here.

Two conventions are used throughout:

- **S** — the public storefront hostname (kokoniv2).
- **A** — the backend/admin hostname (kokono-inv).

Neither is chosen yet. Every command below that contains `S` or `A` must have them substituted;
the reserved `.example` domains in the templates are placeholders and the production preflight
deliberately rejects them.

---

## 1. Public DNS for S and A

**Why not local.** A hostname only resolves publicly once its records exist in the authoritative
zone. Nothing on a developer machine can create them, and `/etc/hosts` entries prove nothing
about what a customer's resolver will return.

**Resource needed.** DNS zone control for the chosen domain, plus the VPS public IPv4 (and IPv6
if offered).

**Configuration.**

```
S.  A    <vps-ipv4>
A.  A    <vps-ipv4>
S.  AAAA <vps-ipv6>     # only if the host actually has one
A.  AAAA <vps-ipv6>
```

**Verify.**

```bash
dig +short S A
dig +short A A
# Must return the VPS address from an off-host resolver, not a local cache:
dig +short @1.1.1.1 S
```

**Rollback.** Lower TTL to 300 s before the first publish so a wrong record can be corrected in
minutes. Do not point DNS at the host until section 3 serves a valid certificate, otherwise
visitors reach a broken TLS handshake that browsers cache aggressively.

---

## 2. Production PostgreSQL with verified TLS

**Why not local.** The local instance runs `sslmode` off with a superuser role. `verify-full`
requires a certificate chain the client can validate against a CA, which a loopback container
does not have. The role model itself **was** proven locally — see section 2b.

**Resource needed.** A managed or self-hosted PostgreSQL 18.x instance with TLS enabled and a
published CA certificate.

**Configuration.**

```
DATABASE_URL=postgresql://kokoni_runtime:<url-encoded-password>@<db-host>:5432/kokoni?sslmode=verify-full
```

Reviewed server settings to apply before first traffic:

```sql
ALTER DATABASE kokoni SET statement_timeout = '60s';
ALTER DATABASE kokoni SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE kokoni SET lock_timeout = '5s';
```

**Verify.**

```bash
psql "$DATABASE_URL" -c "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
npm run ops:status     # reports connectivity and that the runtime role is a non-owner
```

**Rollback.** Keep the pre-migration dump from section 6 and the previous `DATABASE_URL` in the
secret store. A failed TLS change is recoverable by reverting the URL; a failed migration is not,
which is why the dump is taken first.

### 2b. Roles — already proven locally, only provisioning remains

`npm run ops:roles` created `kokoni_migrator` / `kokoni_runtime` / `kokoni_backup` on a disposable
local database, applied the documented grants and asserted **23/23** expectations: the runtime role
can do ordinary application DML but cannot `CREATE TABLE`, `DROP`, `ALTER`, `TRUNCATE`,
`CREATE INDEX`, read or write `_prisma_migrations`, disable ledger triggers, drop the protection
functions, rewrite or delete ledger history, create roles, grant itself `SUPERUSER`, or create
extensions; the backup role can read (including customer records) and write nothing.

What remains is provisioning the same roles on the real instance with passwords generated outside
source control and CI logs, then re-running the same script against a disposable database on that
host to confirm the provider has not granted anything extra.

---

## 3. TLS certificates and renewal

**Why not local.** A publicly trusted certificate requires a CA to validate control of a public
domain. Self-signed certificates prove nothing about what a browser will accept.

**Resource needed.** ACME client (certbot or the proxy's built-in issuer) and ports 80/443 reachable
from the internet.

**Configuration / command.**

```bash
sudo certbot certonly --nginx -d S -d A --agree-tos -m <ops-mailbox> --no-eff-email
sudo systemctl enable --now certbot.timer
```

**Verify.**

```bash
curl -sSI https://S | head -1
echo | openssl s_client -connect S:443 -servername S 2>/dev/null | openssl x509 -noout -dates
sudo certbot renew --dry-run
```

**Rollback.** Certificates are additive; a failed issuance leaves the previous one in place. Do not
enable HSTS beyond the reference one day until renewal has succeeded at least once unattended —
HSTS is not revocable within its max-age.

---

## 4. Reverse proxy, forwarded headers and edge rate limits

**Why not local.** The application's trusted-proxy logic authenticates the *immediate socket peer*
by literal IP. That peer address only exists once a real proxy sits in front of the app on the real
host. Header-forgery behaviour is unit-tested locally, but the deployed chain is not.

**Resource needed.** nginx (reference config in [`deploy/nginx.conf.example`](../deploy/nginx.conf.example),
syntax-checked in a disposable container, never installed).

**Configuration.** Set `TRUSTED_PROXY_IPS` to the literal IPs of the immediately connected proxy
only — never `*`, never a CDN's published ranges without a separately reviewed chain. The proxy
must **overwrite** `X-Forwarded-For`, not append to it.

**Verify.**

```bash
sudo nginx -t && sudo systemctl reload nginx
# A forged client IP must not be believed:
curl -sS -H 'X-Forwarded-For: 1.2.3.4' https://S/api/storefront/v1/config -o /dev/null -w '%{http_code}\n'
# Rate limit must actually engage:
for i in $(seq 1 100); do curl -s -o /dev/null -w '%{http_code} ' https://S/; done; echo
# Backend must not be reachable except through the proxy:
curl -sS --max-time 5 http://<vps-ip>:3000/ && echo "FAIL: backend is directly reachable"
```

**Rollback.** `sudo nginx -t` before every reload; a failed test leaves the running config intact.
Keep the previous `sites-enabled` file so a reload can be reverted in one command.

---

## 5. Firewall

**Why not local.** There is no public attack surface on a loopback host to close.

**Command.**

```bash
sudo ufw default deny incoming
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

**Verify.** From another machine: `nmap -Pn -p 22,80,443,3000,5173,5432 <vps-ip>` — only 22/80/443
may be open. Confirm SSH still works **before** closing the session.

**Rollback.** `sudo ufw disable`. Never enable the firewall from a session you cannot re-establish.

---

## 6. Applying migrations on the production instance

**Why not local.** The local database is now fully migrated (18 applied, none pending). The
production instance's actual applied state cannot be known from here.

**Command.**

```bash
pg_dump "$DATABASE_URL" -Fc > /var/backups/kokoni-pre-migration-$(date +%F-%H%M).dump
npx prisma migrate status        # inspect BEFORE applying; never `db push`, never `migrate reset`
npx prisma migrate deploy        # run as kokoni_migrator, not the runtime role
```

**Note on `item_images_public_managed_idx`.** Prompt 24 added a partial index that is the single
largest storefront performance factor (public listing 2,541 ms → 402 ms at 50k listings). Ordinary
`CREATE INDEX` takes a write lock on `item_images`. On a populated production table prefer the
concurrent form, outside a transaction, then mark the migration applied:

```sql
CREATE INDEX CONCURRENTLY item_images_public_managed_idx
  ON item_images (merchandise_item_id, id)
  WHERE approved_for_public_use
    AND storage_key ~ '^admin-media\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp)$';
```

The predicate must stay **byte-identical** to `managedImagePattern.source`. PostgreSQL only skips
the per-row regex when it can prove the query predicate implies the index predicate; any drift
silently costs ~1,500 ms per page with no error.
`tests/publication.media-index.test.ts` guards this.

**Verify.**

```bash
npx prisma migrate status                    # "Database schema is up to date!"
psql "$DATABASE_URL" -c "SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid;"
```

An invalid index from a failed concurrent build must be dropped concurrently and rebuilt — it is
not used by queries but is still maintained on writes.

**Rollback.** Restore the dump taken above. Do not run `prisma migrate resolve` merely to silence a
failed deploy.

---

## 7. Persistent media mount

**Why not local. (Partly.)** Persistence *across rebuild and restart* was verified locally with a
media directory outside the build output. What cannot be tested locally is survival across host
replacement and volume remount.

**Configuration.** `MERCHANDISE_UPLOAD_DIR=/var/lib/kokoni/media`, on a volume that is **not**
inside the release directory, owned by the runtime user.

```bash
sudo mkdir -p /var/lib/kokoni/media && sudo chown kokoni:kokoni /var/lib/kokoni/media
```

**Verify.**

```bash
npm run ops:status         # media_mount must report readable and writable
npm run media:review       # every approved image must decode
```

Then upload one image through the admin UI, redeploy, restart, and confirm it is still served.

**Rollback.** Media is paired with the database: an image row without its file is a broken product
page. Restore both from the same backup instant, never one alone.

---

## 8. Off-site encrypted backups and PITR

**Why not local. ** A local dump on the same disk as the database is not a backup. Off-site storage
requires a provider, credentials and an encryption key held somewhere other than the VPS.

**Resource needed.** Object storage bucket, its credentials, and a passphrase stored in a password
manager — not on the VPS.

**Command (paired database + media, encrypted before it leaves the host).**

```bash
pg_dump "$DATABASE_URL" -Fc | age -r "$AGE_RECIPIENT" > kokoni-db-$(date +%F-%H%M).dump.age
tar -C /var/lib/kokoni -cf - media | age -r "$AGE_RECIPIENT" > kokoni-media-$(date +%F-%H%M).tar.age
```

**Verify — the only verification that counts is a restore.** Restore the most recent pair onto a
clean staging host and re-run the paired restore audit:

```bash
npx tsx scripts/audit-restore.ts
```

**Rollback.** Not applicable; this only adds copies. The real risk is an untested backup, so
schedule a restore drill and record its measured recovery time.

---

## 9. Scheduler (systemd timers)

**Why not local.** systemd is not installed and the intended cadence cannot be observed in a short
session. The jobs themselves were run repeatedly and proven idempotent locally.

**Resource needed.** The units in [`deploy/`](../deploy/) — `kokoni-job@.service`,
`kokoni-commerce.timer`, `kokoni-customers.timer`, `kokoni-inventory.timer`.

**Command.**

```bash
sudo cp deploy/kokoni-*.service deploy/kokoni-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kokoni-commerce.timer kokoni-customers.timer kokoni-inventory.timer
```

**Verify.**

```bash
systemctl list-timers 'kokoni-*'
journalctl -u 'kokoni-job@*' --since '1 hour ago'
```

`inventory:reconcile` exits **1** on any balance/ledger disagreement and never repairs anything —
a non-zero exit must page a human, not be retried.

**Rollback.** `sudo systemctl disable --now kokoni-*.timer`. Exactly one host may own these jobs;
two schedulers against one database will duplicate work.

---

## 10. Stripe TEST webhook endpoint

**Why not local.** Stripe must reach a public HTTPS URL to deliver events. Signature verification,
replay rejection, duplicate handling and idempotency are covered by local tests, but no webhook has
been delivered by Stripe itself.

**Resource needed.** Stripe dashboard (test mode). A `sk_test_` key and `whsec_` secret are already
present in the local `.env`; production needs its own.

**Configuration.** Endpoint URL: `https://A/api/commerce/webhooks/stripe`. This path must bypass any
staff access challenge and must preserve the raw request body and `stripe-signature` header — a
proxy that rewrites the body breaks signature verification.

**Verify.**

```bash
stripe listen --forward-to https://A/api/commerce/webhooks/stripe
stripe trigger checkout.session.completed
```

Then confirm in the admin UI that the order reached PAID and its reservation is CONFIRMED, and that
**returning from Stripe in the browser without a webhook does not mark the order paid**.

**Rollback.** Disable the endpoint in the Stripe dashboard and set
`COMMERCE_TEST_CHECKOUT_ENABLED=false`; the switch is enforced server-side and the provider refuses
to construct when disabled (`tests/operations.feature-flags.test.ts`).

---

## 11. Resend — only if the customer-facing sender must change

**Mostly already done.** `mail.ex1j.iosys.fr` is verified in Resend with DKIM and both SPF records
confirmed, and real verification, password-reset, order-confirmation and shipment emails were
**delivered** to `contact@iosys.fr` during this pass — through an inbox whose organisational domain
publishes `DMARC p=reject`, which is practical evidence of alignment.

**What remains.**

1. Open one delivered message and read its raw `Authentication-Results:` header to confirm
   `spf=pass dkim=pass dmarc=pass`. This needs mailbox access that automation did not have.
2. **Only if** you want customers to see `contact@iosys.fr` rather than
   `noreply@mail.ex1j.iosys.fr`: add Resend's DKIM and SPF records for the apex `iosys.fr` and
   verify the domain. The apex currently publishes `v=spf1 include:spf.infomaniak.ch -all`, so its
   SPF must be extended rather than replaced or existing mail will start failing.

**Rollback.** `CUSTOMER_EMAIL_PROVIDER=disabled` stops all sending. Account tokens are invalidated
when delivery cannot be confirmed, so no customer is left holding a token that was never delivered.

---

## 12. Monitoring and alert routing

**Why not local.** An alert that is not delivered to a person is not monitoring, and there is no
on-call recipient configured.

**Minimum to route somewhere a human reads.**

| Signal | Source | Why it pages |
|---|---|---|
| Timer job failed | `systemctl` / `journalctl` exit status | Reservations stop expiring; stock stays locked |
| `inventory:reconcile` exit 1 | job exit code | Ledger and balances disagree — never auto-repaired |
| Orders in `REVIEW` | `npm run ops:status` | Payment taken without a dispatchable allocation |
| Certificate < 14 days | certbot | Total outage when it lapses |
| Disk > 80% | node exporter | Media writes and WAL both fail |
| 5xx rate | proxy access log | Everything else |

**Rollback.** Not applicable. Note that no external error-tracking provider is configured; error
correlation is currently limited to what the application logs itself.

---

## 13. Live payments — not a configuration step

`sk_live_` keys are **refused in code**, and there is no flag that enables live commerce. Accepting
real money requires a separately implemented and reviewed live-mode transition, not a VPS task.
Keep `COMMERCE_TEST_CHECKOUT_ENABLED=false` on any host reachable by the public until that work is
done and qualified.

---

## 14. Still to be qualified on the target host

These were measured on local development hardware and must be re-measured on the VPS, which will
have different CPU, disk and memory:

- Public listing 402 ms, facets 317 ms, product detail 22 ms, operational dashboard 1,728 ms at the
  50k-item fixture. See the latency table in [production-readiness.md](production-readiness.md).
- Sustained concurrency, real image traffic through the proxy, and connection-pool headroom against
  the provider's `max_connections`.
- Whether the partial index is chosen by the planner on the production instance:

```sql
EXPLAIN (ANALYZE, BUFFERS) /* the public listing query */ ;
-- must show: Index Only Scan using item_images_public_managed_idx
-- must NOT show: Seq Scan on item_images ... Filter: storage_key ~ ...
```
