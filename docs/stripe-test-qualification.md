# Stripe TEST-mode qualification

A complete external Stripe **test-mode** purchase was driven through both running applications
and the real Stripe API: storefront → quote → checkout → hosted Stripe Checkout → test card →
**real webhook delivered by Stripe** → order PAID → reservation confirmed → admin dispatch →
exactly one SALE movement → refund.

**No live mode was enabled.** `sk_live_` keys and `livemode: true` events remain refused in code,
and nothing in this pass relaxed that.

Result: **41 qualification checks passed, 0 failed**, plus 370 automated tests and clean lint.

---

## Environment used

| Setting | Value |
|---|---|
| Stripe account | `acct_1T4iMl2ZJAI0wcar`, country FR, **test mode** |
| Secret key | `sk_test_…` (live keys rejected by `paymentConfiguration()`) |
| `COMMERCE_TEST_CHECKOUT_ENABLED` | `true` |
| Webhook delivery | Stripe CLI 1.50.10 `stripe listen --forward-to http://localhost:3000/api/commerce/webhooks/stripe` |
| Backend / storefront | `http://localhost:3000` / `http://localhost:5173` |

### The webhook secret is a CLI forwarding secret, not a deployed endpoint secret

The `whsec_…` in `.env` is byte-identical to what `stripe listen --print-secret` returns. It is
tied to the CLI/account pairing and is **only valid while `stripe listen` is running**. A deployed
endpoint gets a *different* `whsec_` generated when the endpoint is created in the dashboard.

Related finding: the only webhook endpoint currently registered on this Stripe account is
`https://ex1j.iosys.fr/api/stripe/webhook`, subscribed to `payment_intent.*`. That belongs to a
**different project sharing the account**. Kokoni needs its own endpoint at
`https://A/api/commerce/webhooks/stripe` subscribed to `checkout.session.*`, `refund.*` and
`charge.refunded`, and that endpoint's own signing secret.

---

## Defect found and fixed: gateway secret mismatch

`COMMERCE_GATEWAY_SECRET` **differed between the two applications**. Every customer and commerce
request across the gateway failed with `401`, so no quote, checkout, payment or account operation
was possible at all. Both values were 64 characters and looked plausible in isolation; only
comparing them revealed it.

Fixed by aligning `kokoniv2/.env` to the backend value. Prior `.env` files are backed up under
`.local/`. This is precisely the failure `docs/environment-handoff.md` warns about — the two values
must be identical, and a mismatch produces a blanket 401 rather than a descriptive error.

---

## Stage 1 — purchase path (12/12)

| Check | Result |
|---|---|
| Stripe mode is TEST and enabled | `mode=TEST enabled=true` |
| Customer registered through the storefront | 200 |
| Product publicly visible with France stock | 5 available @ 2500 EUR |
| Quote created | 3090 EUR TTC (2500 + 590 shipping) |
| **Browser cannot set price** | injected `totalAmount:1` rejected, 400 |
| Order created | `K-20260909-2F8DA5D8B2DE`, total 3090 |
| Checkout creation idempotent | same `operationKey` returned the same order |
| One order per quote | exactly 1 |
| Hosted session created | `checkout.stripe.com` |
| Payment start retry idempotent | same hosted session URL returned |
| Session is test mode and matches order | `livemode=false`, `amount_total=3090` |
| **Browser return alone cannot mark paid** | still `UNPAID` after visiting `success_url` |

Payment was then completed on the **real hosted Stripe Checkout page** with test card `4242…`
(Playwright; there is no API that pays a Checkout Session). Stripe delivered
`checkout.session.completed` → HTTP 200 → order `PAID/PAID`, attempt `SUCCEEDED`, reservation
`CONFIRMED`.

## Stage 2 — webhook robustness, fulfillment, refund (22/22)

**Signature verification** — invalid secret, missing header, stale timestamp (1 hour old) and a
tampered payload signed over the original body were **all rejected with 400** and
`INVALID_SIGNATURE`. The backend log shows exactly 4× 400 against 14× 200.

**Duplicate and replay** — re-delivering the same signed event was accepted (200) but stored no
additional `PaymentEvent` and left `paidAt` unchanged. A late replay after the order had already
moved on did not regress its state.

**Ownership and authority** — another customer got 404 for the order, anonymous access got 404,
and a browser attempt to POST `{"paymentStatus":"PAID"}` was refused.

**No card data, no secrets** — no PAN, CVC or card field exists anywhere in order or payment
records; no `sk_`/`whsec_` value appears in any stored record.

**Fulfillment** — `PREPARING` → `SHIPPED` (Colissimo + tracking) produced **exactly one SALE
movement of −1**, the reservation moved to `CONSUMED` bound to that one movement, and a **dispatch
retry produced no second movement**.

**Refund** — a real refund was issued at Stripe. Three real webhooks arrived
(`refund.created`, `charge.refunded`, `refund.updated`), all 200. A repeated refund produced
**exactly one refund at Stripe**, and `refunded_amount` converged on **3090** — the order total —
rather than accumulating across four separate REFUNDED notifications. The SALE movement was **not**
reversed: the goods had already shipped, so restocking stays an explicit operator decision.

## Stage 3 — expiry, decline, and lost-webhook recovery (7/7)

**Expired session** — expiring the session at Stripe produced a real `checkout.session.expired`;
the order became `CANCELLED/FAILED`, the reservation was `RELEASED`, and no PAID event was written.

**Declined card** (`4000000000000002`) — declined on the hosted page, no redirect, **no webhook
emitted**. Order stayed `PENDING/UNPAID` with 0 payment events, attempt `OPEN`, and the reservation
still `HELD` so the customer can retry.

**Lost webhook → reconciliation** — the strongest case. The CLI listener was **stopped** so the
notification was genuinely lost, then a real payment was made. The order correctly remained
`PENDING/UNPAID`. `npm run commerce:maintenance` reported `reconciled: 1` and the order converged
to `PAID/PAID` with the reservation `CONFIRMED` and exactly one PAID event.

**Out-of-order after recovery** — the real webhook was then re-sent with `stripe events resend`.
It was accepted and **logged** as a distinct provider notification, but applied no second effect:
the order stayed `PAID` at 3090 with one `CONFIRMED` reservation.

> `PaymentEvent` is an audit log of notifications *received*; idempotency of *effects* is enforced
> separately by order state. Two rows for one payment is correct — two charges would not be.

**Foreign events** — `stripe trigger` events belonging to no order of ours were accepted with 200
and produced **zero** payment events. Unknown events are ignored safely, not errored.

## Maintenance and inventory

`commerce:maintenance` run four times: `reconciled: 2` each time with `payment_events` stable at
**8 → 8**. Reconciliation is idempotent and does not accumulate rows.

`inventory:reconcile`: **5 items checked, 0 mismatches**, exit 0. Ledger for the qualification
item: `PURCHASE +5` → `SALE −1` → balance **4**. Stock conserved exactly.

Order-event audit trail: `CHECKOUT_RESERVED → PAYMENT_CONFIRMED → PREPARING → SHIPPED →
FULL_REFUND_REQUESTED → REFUNDED ×4`.

Order-confirmation email fired on the PAID webhook to a `@example.test` address; the provider
rejected it and `notifyOrder` swallowed the failure exactly as designed — the webhook still
returned 200 and the order still reached PAID. Live confirmation that mail cannot break commerce.

---

## Not exercised, and why

**Async payment events.** `checkout.session.async_payment_succeeded` / `async_payment_failed` are
handled in the adapter, but sessions are created with `payment_method_types: ["card"]`, and card
payments never produce async events. These paths are **structurally unreachable** with the current
configuration. They share `sessionEvent()` with the completed/expired paths that were exercised
live. To qualify them a delayed method (SEPA, Bacs) would have to be added to the session first —
which is a product decision, not a test gap.

**Deployed endpoint delivery.** All webhooks arrived via the Stripe CLI. Delivery to a public HTTPS
endpoint, its distinct signing secret, and Stripe's retry schedule on 5xx remain VPS-phase work.

---

## Tests added

`tests/commerce.webhook-route.test.ts` (5 tests) covers the boundary in front of the service layer,
which `commerce.integration.test.ts` did not: TEST mode never enables without all four settings,
live keys refuse provider construction, only a current signature from the configured secret
verifies (wrong secret / stale / tampered / empty / malformed all rejected), live-mode events are
refused even when correctly signed, and route errors name no provider internals.

Full suite after this pass: **370 tests across 39 files**, lint clean, types clean.

## Reproducing

```bash
stripe listen --forward-to http://localhost:3000/api/commerce/webhooks/stripe
npm run stripe:fixture                              # publishable product + France stock
npm run stripe:qualify  -- --slug <slug>            # stage 1
npm run stripe:pay                                  # hosted Checkout, test card
npm run stripe:qualify2                             # stage 2
npm run stripe:qualify3 -- --slug <slug> --case expired
```

## Verdict

**Stripe TEST mode is fully qualified locally**, apart from the two items named above as not
exercised. What remains before real money is not configuration: live mode is a separately
implemented and reviewed capability, and `COMMERCE_TEST_CHECKOUT_ENABLED` must be `false` on any
publicly reachable host until then.
