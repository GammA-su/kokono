# Customer accounts — Prompt 19A

> Current operations: customer gacha execution, ownership and physical fulfillment now exist; the phase history below contains earlier deferrals. Use [customer-gacha.md](customer-gacha.md), [gacha-fulfillment.md](gacha-fulfillment.md) and [production-readiness.md](production-readiness.md) for current capability and launch gates. Trusted proxy configuration is now described in [environment.md](environment.md).

Customer identity now lives in the existing backend PostgreSQL database. kokoniv2 has no customer database. This phase precedes Prompt 18.75: gacha browsing remains public, but customer execution and reward ownership remain unimplemented.

## Architecture and migration

The internal Better Auth instance, `User`, `Account`, `Session`, `Verification` tables and internal permissions are unchanged. The new `Customer` realm is independent. Customer UUIDs never create or authorize internal users; administrators are not automatically customers.

Better Auth's installed `better-auth/crypto` scrypt password implementation is reused. No password cryptography or dependency was added. A separate, small customer service owns explicit safe DTOs, hashed bearer sessions and single-use tokens instead of exposing the internal Better Auth HTTP surface or copying admin permissions. One password hash is stored per customer.

`20260910120000_customer_accounts` adds Customer, CustomerSession, CustomerToken, CustomerAddress, CustomerEvent, CustomerRateLimit, and a nullable indexed immutable `Order.customerId` FK. It preserves all existing guests, admin users, merchandise, inventory and gacha configurations. It does not claim guest orders by matching email or reset/backfill the database. Run `npm run db:deploy`, then rebuild both applications; backend build regenerates Prisma.

Customer fields include normalized unique email, password hash, display/last name, verification timestamp, status, last login, timestamps and a private durable commerce credential. Email is trimmed/lowercased; database constraints prevent duplicate normalized emails. No provider-specific dot/plus rewriting occurs. Registration/reset accept passwords of 12–1024 characters. Accounts remain PENDING_VERIFICATION until verified; pending customers may sign in. DISABLED customers cannot authenticate. ACTIVE is assigned only after verification.

## Session and deployment boundary

The existing Node storefront gateway provides same-origin customer APIs even when the backend is on another domain. Set matching website `SITE_ORIGIN` and backend `STOREFRONT_BASE_URL`; website `COMMERCE_API_ORIGIN` points to the backend. Both servers need the same random 32+ character `COMMERCE_GATEWAY_SECRET`. These are never VITE/browser variables. Use HTTPS for customer access and the server-to-server connection in deployment. No CORS relaxation or shared parent-domain cookie is necessary.

Cookies are host-only, Path=/, HttpOnly, SameSite=Lax, 30 days. HTTPS uses `__Host-kokoni_customer; Secure`; local HTTP uses `kokoni_customer`. No Domain attribute is set. Each registration/login creates a new random 256-bit session and revokes the previous cookie session. Only SHA-256 session digests are stored. Every authenticated request checks expiry and account status; there is no cookie cache. Logout revokes the server session. Reset and staff disable/re-enable revoke all sessions. Authentication does not depend on periodic expiry cleanup.

The gateway allowlists routes and forwards only its server key, selected customer cookie and a keyed TCP-peer identity. It strips browser Authorization, admin cookies and upstream session transport headers. Customer secrets never enter JSON, SSR, localStorage or URLs. HTML and APIs use no-store and no-referrer; account/auth/order pages are noindex. SSR hydrates the safe session to avoid an unnecessary logged-out flash.

## APIs and DTOs

Routes are rooted at `/api/storefront/v1/` on kokoniv2. Backend access requires the trusted gateway. POST requests require exact configured Origin and bounded JSON.

| Route | Method | Purpose |
| --- | --- | --- |
| auth/register | POST | email/password/optional displayName; safe session and fresh cookie |
| auth/login | POST | generic credential failure; safe session and fresh cookie |
| auth/logout | POST | revoke session and clear cookie |
| auth/session | GET | authenticated/customer/emailDeliveryAvailable |
| auth/forgot-password | POST | same acknowledgement for known/unknown email |
| auth/reset-password | POST | token + password; revoke all sessions |
| auth/request-verification | POST | request verification for signed-in account |
| auth/verify-email | POST | redeem one-use verification token |
| customer/profile | POST | displayName/lastName only |
| customer/addresses | GET / POST | own addresses / create or update owned address |
| customer/addresses/:id/delete | POST | delete own address |
| customer/orders?page=N | GET | own orders, 20 per page |

CustomerDTO exposes only id, email, displayName, lastName, emailVerified, createdAt. Address responses include delivery fields and ID. History contains order ID/number/date/status/total/currency and pagination. Existing order detail uses its existing safe selector. Strict profile validation rejects role, account ID, status and verification edits.

## Website behavior

Routes `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`, `/account`, `/account/orders`, `/account/addresses` use the existing shell and CSS Modules. Account shows profile/verification, orders, addresses, rewards link and logout, with no invented statistics. Addresses support CRUD, one default and a maximum of 20.

Account routes, checkout and `/gacha/rewards` require authentication in SSR and the client. Anonymous requests redirect to login with a validated local returnTo. The allowlist includes local account, checkout, order and gacha destinations; external URLs, backslashes and control characters are rejected. Cart data remains in its existing browser store throughout login/logout. Public browsing remains public.

One CustomerProvider/useCustomer exposes customer, authenticated, loading, login, register, logout and refreshSession. Header, checkout, account and gacha share it. SSR supplies initial safe state; focus/pageshow refresh it. Gacha provides a login return to the selected banner, and remains disabled after login pending Prompt 18.75. The authenticated rewards placeholder explains the missing execution/history phase.

## Checkout and guests

New commerce quote/checkout/payment/cancel HTTP actions require requireCustomer(). The private per-customer commerce key connects the existing guest-hash-based domain services to persistent accounts without a second order/checkout implementation. It never reaches the browser. Checkout validates the session/key match inside its transaction and locks the customer before creation. Order.customerId is immutable. Existing TTC tax, shipping, price and address snapshots, reservations and Stripe test payment policy are unchanged.

Saved France-mainland addresses prefill checkout's existing form. Editing an address never rewrites an old order. Account history survives logout and login on another browser.

Old guest orders are not automatically claimed by matching email. Their original credential still grants read access to `/orders/:id` when no customer session is presented. They do not appear in account history. Guest mutations now require an account; existing guest purchases needing intervention use the internal order workflow. A future account-claim flow must verify ownership explicitly. The domain's legacy credential call form remains for existing internal consumers/historical test scenarios; public new checkout requires a customer session.

## Verification and reset delivery

Prompt 19B adds a Resend-backed CustomerMail transport, disabled until explicitly configured. Both production customer namespaces share the server-only provider wiring. See [Resend setup, templates and manual verification](customer-email.md). Tests continue injecting in-memory/mock delivery; nothing logs tokens or writes a plaintext mailbox.

Tokens are random 256-bit secrets stored as SHA-256 hashes. Reset expires in one hour; verification in 24 hours. Redemption locks the customer, consumes one matching unexpired token atomically and invalidates other tokens of that purpose. Password reset uses the library hash and revokes all sessions in that transaction. Disabled accounts cannot redeem. Delivery failure removes the new token. Unknown/known reset requests return the same acknowledgement.

Resend templates send links to the configured frontend origin: `/reset-password#token=...` or `/verify-email#token=...`. Fragments stay out of request logs, referrers and SSR. The customer explicitly submits the form to redeem; success clears the fragment. Never accept caller-supplied callback origins. Email changes are deferred.

`CUSTOMER_REQUIRE_VERIFIED_EMAIL=false` remains the initial policy. True blocks new checkout until the email is verified; it never marks it verified automatically. Configure and manually verify Resend delivery before enabling that requirement for normal onboarding.

## Security, staff and maintenance

Durable atomic PostgreSQL limits apply across replicas: 60 customer mutations/client/10 minutes; registration 10/client/10 minutes; other auth 20/client/10 minutes; login 10/email/10 minutes; reset or verification 3/email-or-account/hour. Only derived/hashed rate keys are stored. The gateway uses its actual TCP peer and does not trust browser forwarded IPs. Behind a proxy configure shared edge limits and a reviewed trusted-proxy policy; current peer limits are conservative. JSON is capped at 16 KiB, with password length validation before expensive hashing.

CustomerEvent records registration, successful login, logout, reset, verification and staff disable/re-enable without credentials, raw IPs or user-agent strings. Database guards protect customer identity, order ownership and append-only events. `/admin/customers` requires existing internal authorization, and provides email search, pagination, ID/status/dates/order counts and disable/re-enable. Gacha counts explicitly remain unavailable. Disabling revokes sessions/tokens and preserves historical records.

Schedule `npm run customer:maintenance` to remove expired sessions, tokens and rate-limit windows. Authorization already enforces expiry. Configure deployment logs to exclude auth headers, cookies, bodies and PII.

## Verification and next-phase handoff

Verified for this phase: both production builds, backend lint/typecheck, all 293 backend tests (28 files), 21 frontend unit/HTTP tests, real two-application customer browser verification, real storefront HTTP checkout/inventory regression and existing storefront navigation/cart and checkout browser checks. The checkout UI regression uses fixture payment responses and now supplies the authenticated prerequisite; the customer end-to-end test uses real backend accounts. The customer migration was applied to the local development database without resetting it. No test customer or demonstration inventory was inserted into that development schema.

Backend tests: `tests/customers.integration.test.ts`, account ownership in `tests/commerce.integration.test.ts`, existing gacha regression tests. Frontend: `tests/customer.test.mjs` plus existing storefront/gacha tests. `npm run test:customer-browser` starts both production builds against a unique schema in a dedicated `_test` database, performs actual registration/login/profile/address/logout, protected SSR, cart preservation and gacha login return, checks DB state, and makes no gacha pull/payment. Set PLAYWRIGHT_CHANNEL=msedge where needed. Schema, temporary media and servers are cleaned up; screenshots are in ignored `.local/customer-check/`.

Prompt 18.75 should reuse Customer.id, requireCustomer, gateway cookies/headers, CustomerProvider and login returnTo. Add explicit customer ownership FKs to pulls/rewards; do not infer identity from old admin-grant customerReference or guest email. Execution/entitlement, idempotent recovery, immutable receipts and inventory-backed reward ownership remain missing. No customer pull/reward endpoint or fulfillment was introduced here. Verification-dependent gacha eligibility also needs an explicit email-delivery policy. Full fulfillment and final My Prizes UI remain later phases.
