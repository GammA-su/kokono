# Resend customer email — Prompt 19B

## Implementation

The existing `CustomerMail` function is now backed by a Resend transport in `src/modules/customer-email/resend.ts`. `src/lib/customer-handler.ts` constructs it once for both customer/auth route namespaces, behind `server-only`. `config.ts` validates enabled configuration; `templates.ts` exports CustomerEmailVerification and CustomerPasswordReset. There is no new auth flow, schema migration, frontend API, email database or dependency.

The transport uses Node's built-in fetch for the single fixed `POST https://api.resend.com/emails` endpoint. This keeps the existing small dependency footprint and makes timeout, redirect and error handling explicit. Requests include HTML, plain text, From, one recipient, optional Reply-To and a stable idempotency header, following the [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email).

## Server configuration

Set these in **kokono-inv only**, never kokoniv2 or a VITE variable:

```dotenv
CUSTOMER_EMAIL_PROVIDER=resend
RESEND_API_KEY=re_your_server_only_key
CUSTOMER_EMAIL_FROM="Kokoni <account@your-verified-mail-domain.example>"
CUSTOMER_EMAIL_REPLY_TO=support@your-domain.example
CUSTOMER_EMAIL_SITE_NAME=Kokoni
SITE_ORIGIN=https://your-customer-site.example
STOREFRONT_BASE_URL=https://your-customer-site.example
CUSTOMER_REQUIRE_VERIFIED_EMAIL=false
```

`CUSTOMER_EMAIL_PROVIDER` defaults to `disabled`. Setting credentials alone does not send mail. `CUSTOMER_EMAIL_REPLY_TO` is optional and takes one plain email address. Site name is optional, default Kokoni. SITE_ORIGIN may be omitted to reuse existing STOREFRONT_BASE_URL; if both are set their normalized origins must match. Origins cannot contain credentials, query, fragment or a path. Enabled production mail requires HTTPS. Explicit local development configuration may use HTTP localhost/127.0.0.1/::1.

Missing/invalid enabled settings fail at provider construction with only the setting name in the error, never its value. Restart/rebuild the backend after changing configuration. Keep the gateway/frontend origin configuration from Prompt 19A aligned. The frontend only receives the existing emailDeliveryAvailable capability, not provider credentials.

## Configure the sending domain

1. Add a domain you control in the Resend dashboard; a dedicated transactional subdomain is suitable.
2. At your DNS provider, add the exact records Resend presents for that domain/region. Verify SPF and DKIM; configure DMARC as appropriate. Do not copy placeholder record values from this document.
3. Wait until Resend reports the sending domain verified.
4. Set CUSTOMER_EMAIL_FROM to an address at that verified domain, and optionally set a support Reply-To mailbox you monitor. Use a sending-scoped API key for this deployment.

Resend documents required domain verification records in [Managing domains](https://resend.com/docs/dashboard/domains/introduction). No DNS records, domain registration or account configuration were mutated by this implementation.

Keep **open and click tracking disabled for this authentication sending domain**. Tracking rewrites links; these emails deliberately use direct frontend links with secret fragments and need no engagement telemetry. See [Resend tracking configuration](https://resend.com/docs/dashboard/domains/tracking). Do not add analytics query parameters or a redirect/link-shortening service around verification/reset links.

## Messages and token lifecycle

Verification is requested on registration and through the existing account action. The email uses `/verify-email#token=...`, a 24-hour expiry notice, a clear action, visible fallback URL and ignore-if-unrequested guidance. Reset uses `/reset-password#token=...`, a one-hour expiry notice and explains that an unsolicited request does not change the password. Both have inline styles, presentation tables, high-contrast text/buttons, responsive width, escaped branding and a plain-text alternative. No customer ID, password, hash, session token or internal credential is included.

Tokens are still generated and hashed by Prompt 19A's domain. Email acceptance **does not verify the account**. The existing explicit form redemption consumes the expiring token. Reset revokes existing sessions; no other ownership or session logic changes.

## Delivery failure and idempotency

An eight-second timeout bounds the entire provider request/body read. Redirects are rejected. Non-2xx, missing confirmation ID, malformed responses and network/timeout errors all reject with a generic message. Provider error bodies are not logged or propagated; they may echo personal data or credentials. The existing domain then deletes only the newly issued token. Registration remains valid; reset retains the same generic acknowledgement for known/unknown accounts, and verification reports a request rather than claiming delivery. A configured transport is a capability, not proof that an inbox received a message.

Idempotency uses `customer-verify:<digest>` or `customer-reset:<digest>`. The digest is SHA-256 over a namespaced purpose plus the already random 256-bit token; it is stable for the same logical message and contains no plaintext token, email, customer ID or database token hash. It changes for a fresh domain token. Resend retains keys for 24 hours and accepts keys up to 256 characters, per its [idempotency documentation](https://resend.com/docs/dashboard/emails/idempotency-keys).

There is no automatic queue/retry or persistent plaintext token store. The transport supports safely retrying an identical message while still held in memory. A timed-out request may have been accepted upstream: the domain conservatively invalidates that token, so a late-arriving link may be invalid and the customer should request a new one. Do not reconstruct a plaintext token from stored hashes or retry invalidated links from an outbox.

## Development, tests and enablement

Default local mode sends nothing. Tests continue injecting an in-memory CustomerMail sink; adapter tests inject a fake fetch response. NODE_ENV=test / VITEST disables configured runtime mail, and the live adapter refuses its default network transport inside tests. Production-build HTTP/browser verification scripts explicitly set CUSTOMER_EMAIL_PROVIDER=disabled even if the developer's environment contains real credentials. No automated test sends mail.

To manually use Resend locally, explicitly set CUSTOMER_EMAIL_PROVIDER=resend and the sender/key/origin settings. The same domain throttles apply. Do not print tokens or turn on request-body/header logging. Provider content necessarily contains the transaction recipient and intended action link; do not attach other customer data or tags.

CUSTOMER_REQUIRE_VERIFIED_EMAIL remains false by default and was not enabled by this change. Once sender setup and the following manual flows pass, operators may deliberately enable true to enforce Prompt 19A's existing checkout verification gate. Do not enable it before reliable mail delivery and redemption work.

## Manual acceptance checklist

Use a mailbox you control and disposable development customers:

1. Register through kokoniv2, receive the verification email, inspect its sender/Reply-To and both desktop/mobile appearance, open the direct fragment link, explicitly verify, and confirm the account becomes verified. Reopening/redeeming again must fail.
2. Sign in, request a reset, receive and open the fragment link, set a new password, confirm old sessions are revoked, and sign in with the new password. The old password and a repeated reset token must fail.
3. Confirm no query-string tokens or secrets appear in application/proxy logs. Confirm unrequested-reset copy and expiry notices are present.

At implementation time RESEND_API_KEY and CUSTOMER_EMAIL_FROM were absent, so real delivery/inbox/click-through verification was **not performed**. Tests validate template/adapter contracts and the real PostgreSQL token lifecycle using mocked delivery; they are not evidence of actual email receipt or rendering in Gmail/Outlook.

## Checks completed

- `npx vitest run tests/customer-email.test.ts tests/customer-email.integration.test.ts tests/customers.integration.test.ts`: 17 passed, including the unchanged account tests. Nine new tests cover configuration, templates, REST payload/idempotency, safe errors, no logging/key exposure, real token redemption/session revocation and failure cleanup.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- `PLAYWRIGHT_CHANNEL=msedge npm run test:customer-browser`: real two-application account regression passed with email explicitly disabled and isolated test data.
- Browser previews at 900px and 360px: verification/reset layouts fit without horizontal overflow. Ignored `.local/customer-email-preview/` contains only clearly synthetic preview tokens, never actual customer tokens.

Webhooks are intentionally deferred as optional delivered/bounced/complained observability. Future handlers must verify Resend signatures. Verification itself must continue depending on token redemption, not delivery webhooks.
