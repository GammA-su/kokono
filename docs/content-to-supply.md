# Customer-facing content the owner still needs to supply

Result of scanning `kokoniv2` for prototype wording (`TODO`, `placeholder`, `mock`, `fake`,
`coming soon`, `demo`, `prototype`, `lorem`, `FIXME`).

## Prototype wording found: none

Every `placeholder` match is a legitimate HTML input attribute or a CSS class for the hatched
art-slot fill. Nothing was removed, because nothing was accidental.

## Accurate disclosures — keep until they stop being true

These three are **not** prototype leftovers. They are honest statements about a checkout that
really is test-only, and removing them while that remains the case would misrepresent the site.

| Location | Text |
|---|---|
| `src/components/SiteFooter.tsx` | "Explore the shelf. Stripe test checkout only." |
| `src/components/Ticker.tsx` | "Stripe test checkout only" |
| `src/components/Checkout.tsx` | "Stripe test mode. Payment is confirmed by the server; returning from…" |

**Launch gate:** remove all three in the same change that enables real payments — not before, and
not after. Live payments are a separate implementation task, not a configuration switch.

## Legal and company text — none exists yet

No terms, privacy, company-identity or returns content is present anywhere in the storefront.
This is a business/legal deliverable: none of it can be drafted from the codebase, and inventing
it would be worse than leaving it absent.

France-specific note: **mentions légales** and identifying company details are legally required for
a French commercial site, and distance-selling rules give consumers a withdrawal right that your
returns text must state accurately. Treat the list below as a starting point to take to whoever
advises you, not as legal advice.

| Page | Must state |
|---|---|
| Mentions légales | Registered company name, legal form, address, SIREN/SIRET, VAT number, publication director, hosting provider name and address |
| Conditions générales de vente (CGV) | Prices and currency, that displayed prices are TTC, VAT treatment, ordering steps, payment methods, delivery times and zones, transfer of risk, guarantees |
| Privacy / données personnelles | What is collected (account email, order and shipping address, IP for rate limiting), why, retention periods, processors used (**Stripe** for payments, **Resend** for email, your VPS host), and how to exercise GDPR rights |
| Cookies | Which cookies are set and why. Current cookies are strictly-functional session cookies only; confirm before publishing a banner that implies more |
| Returns and withdrawal | Withdrawal period, its start, how to exercise it, who pays return shipping, refund timing, any lawful exclusions |
| Shipping | Zones actually served (currently France mainland), costs, free-shipping threshold, dispatch times, carrier(s) |
| Contact | A monitored address. `contact@iosys.fr` is already the configured Reply-To |
| Gacha terms | Odds disclosure and where published, what a pull costs (**currently nothing — pulls are free and no paid path exists**), what a reward entitles the customer to, fulfilment timing, expiry of unclaimed rewards, eligibility and age limits |

The gacha page already publishes exact odds from the frozen configuration; the terms need to
explain them in words, not replace them.

## Configuration that is not content but is customer-visible

| Setting | Where it shows | Current value |
|---|---|---|
| `CUSTOMER_EMAIL_SITE_NAME` | Email subjects and headers | `Kokoni` |
| `CUSTOMER_EMAIL_FROM` | Sender customers see | `Kokoni <noreply@mail.ex1j.iosys.fr>` — the only verified domain. Using `contact@iosys.fr` requires verifying the apex in Resend first |
| `COMMERCE_POLICY_JSON` | Shipping cost, free-shipping threshold and VAT shown at checkout | France mainland / EUR / TTC defaults. Confirm these are the figures you actually trade on |
