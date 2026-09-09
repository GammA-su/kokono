# Storefront publication backend

Implemented in `kokono-inv`; the separate `D:\Project\kokoniv2` website was rechecked on 8 September 2026. It remains the React/Vite mockup: hard-coded Product objects, an in-memory cart, no product routes, database, customer authentication or checkout backend. Its source and dependencies were not changed by this phase. This document supersedes the publication-related gaps in the earlier [integration review](storefront-integration-plan.md).

## Administrator workflow

Use **Publish to Store** on an item detail page or the existing Catalog/Lineup bulk actions. All entry points open the same signed review dialog. Review public title, description, subtitle, unique slug, selling price/currency, price tax basis, category override, selected approved managed images and order, featured state, publication state and optional SEO text. Existing content and image selections are preserved when reopening. New titles/slugs use the catalog name/slug, but prices are never inferred from MSRP or costs.

Review shows merchandise/characters, image preview, original MSRP, owned stock, global fulfillable stock, France-eligible stock, internal location paths, listing state and the latest finalized landed-cost batch where available. Margin uses the existing exact arithmetic and only comparable currency and an explicitly net selling price. Unknown tax basis or tax-inclusive selling price without a VAT conversion shows margin unavailable. Percentage margin is profit divided by revenue; zero-price percentage is undefined. Costs never block publication and acquisition cost is never substituted for landed cost.

Previously published slugs are fixed, including after unpublication. This MVP does not need a redirect table because it does not allow those slugs to change. Draft slugs can change until first publication. Listing UUIDs stay stable and are the cart identity.

`/admin/publication` provides a paginated readiness report and public category defaults. Figures, Apparel, Prints and Goods are seeded as public navigation categories. Internal categories are intentionally unmapped initially: map their default here, or choose an override in a listing review. Override wins over default; an inactive override never falls back silently. Changing a default changes the effective mapping of all listings using it.

Publication validates active merchandise/parents, effective title, price, one supported currency (EUR, JPY, USD or GBP), valid unique slug, active resolved category and selected image ownership, approval and managed-file deliverability. Drafts can have incomplete category/image configuration; they still require the existing SaleListing price and slug fields. Selection never grants image approval. Use the existing source/image editor for uploads and approval.

Each bulk row keeps its existing independent transaction, optimistic review versions and explicit failure result. A failed row rolls back its own fields/associations. Unpublication preserves listing identity, stock, catalog and history. Stock is never created by publication.

## Migration and remediation

Apply `20260908190000_storefront_publication` using `npm run db:deploy`, then `npm run db:generate` (also included in production build). It adds PublicCategory, optional Category defaults and SaleListing overrides, selected-image/order associations, subtitle/SEO metadata and selling-price tax basis. Existing geography from the inventory phase is reused; no duplicate geography or inventory schema is added.

The migration preserves existing IDs, prices, flags, timestamps and inventory. It selects up to 20 already-approved managed image references for existing listings; it cannot check filesystem availability from SQL. No internal category is guessed, no website mocks are imported, and no existing listing is deleted or automatically republished. Existing records need deliberate category mapping and review. The readiness report detects missing mappings, approval problems and missing files without changing records. Database triggers prevent image/item mismatches and changes to previously published slugs.

The API dynamically excludes unpublished/archived records, unmapped/inactive categories, unsupported currencies and records without an approved selected managed-image reference. File availability is verified at publication/review and again for image delivery. If a previously valid managed file is later lost from its runtime volume, its image endpoint returns 404 and the readiness report flags it; restore the file or replace the selection. Persistent media storage and backups remain necessary.

## France availability

The shared `fulfillableLocationIds` resolver accepts a `FRANCE` scope; its default global scope remains unchanged for internal inventory. Regional eligibility requires explicit opt-in at the exact balance location, active ancestry, no transit ancestry and explicit/inherited French geography. Any known non-French or JAPAN_WAREHOUSE ancestry excludes the location even if a descendant is marked FR. Unknown geography does not qualify. Location codes are not geographic evidence.

Only direct balances are summed, through the existing stock aggregate helper. France parent and box balances are distinct physical balances, never hierarchy rollups. JP 15 + France 3 + transit 2 yields `availableQuantity: 3`. Zero France units remain visible as `OUT_OF_STOCK`.

Before reservations, availableQuantity equals eligible France physical stock. Prompt 19 must subtract active reservation allocations from availability without changing the meaning of physical balances, and avoid subtracting reservations again after finalized SALE movements.

## HTTP API v1

All endpoints are anonymous public reads. Publication writes remain internal Better Auth Server Actions/domain commands. All successful, missing-resource and handled-error responses explicitly use `Cache-Control: no-store`; image responses use the same policy. There is no public catalog mutation endpoint.

| Operation | Route | Response |
| --- | --- | --- |
| Browse | `GET /api/storefront/v1/listings` | `{ items, pageInfo: { page, size, total, pageCount, hasNextPage } }` |
| Detail | `GET /api/storefront/v1/listings/by-slug/:slug` | One DTO; 404 if unavailable |
| Cart resolution | `POST /api/storefront/v1/listings/resolve` | `{ items, unavailableListingIds }` |
| Facets | `GET /api/storefront/v1/facets` | `{ categories, franchises, characters, currencies }` |
| Image | `GET /api/storefront/v1/images/:imageId` | PNG/JPEG/WebP bytes; 404 if unauthorized for public delivery or missing |

Browse parameters: `page` (default 1), `size` (1–100, default 24), `q` (literal, NFKC search), `franchise`, `lineup`, `character` (UUIDs), `category` (public slug), `currency`, `minPrice`/`maxPrice` (integer minor units), `availability` (`IN_STOCK` or `OUT_OF_STOCK`), and `sort` (`newest`, `release`, `alphabetical`, `price-asc`, `price-desc`). Price ranges and price sorting require an explicit currency. Unrecognized/invalid parameters return 400; there is no cross-currency price ordering. Page numbers beyond the end return an empty page. Ordering includes listing ID as a stable tie-breaker. `release` uses the item release, otherwise its lineup release.

Resolve body: `{"listingIds":["<SaleListing UUID>","<another UUID>"]}` with `Content-Type: application/json`. At most 100 IDs and 16 KiB body. Duplicate IDs are resolved once; absent, hidden or otherwise ineligible IDs are returned in unavailableListingIds without private reasons. This POST is read-only, creates no reservation and does not validate a checkout price quote.

DTO example (illustrative IDs):

```json
{
  "listingId": "<stable SaleListing UUID>",
  "slug": "rem-marine-acrylic-stand",
  "title": "Rem Marine Acrylic Stand",
  "description": "Public description",
  "subtitle": "Acrylic, 15 cm",
  "price": { "amount": 2490, "currency": "EUR" },
  "featured": false,
  "franchise": { "id": "<UUID>", "slug": "re-zero", "name": "Re:Zero", "japaneseName": null },
  "lineup": { "id": "<UUID>", "slug": "marine-2026", "name": "Marine 2026", "japaneseName": null },
  "characters": [{ "id": "<UUID>", "name": "Rem", "japaneseName": "レム" }],
  "category": { "id": "<UUID>", "slug": "goods", "name": "Goods" },
  "images": [{ "id": "<ItemImage UUID>", "url": "/api/storefront/v1/images/<ItemImage UUID>", "alt": "Rem Marine Acrylic Stand" }],
  "release": { "value": "2026-11", "precision": "MONTH" },
  "availability": { "status": "IN_STOCK", "availableQuantity": 3 },
  "seo": { "title": null, "description": null }
}
```

Release values use `YYYY`, `YYYY-MM` or `YYYY-MM-DD` with their original precision; unavailable release information is null. Selling prices are integer minor units, not whole euros. The DTO contains no costs/MSRP, sourcing/watch data, private notes, storage keys, source URLs, location names, actors or raw inventory records. Images use explicit selected-image approval and the same visible-listing eligibility as public queries. Revocation/unpublication prevents subsequent delivery requests. Already downloaded bytes cannot be recalled. The private admin media endpoint remains authenticated; there is no remote image proxy or object copy.

Errors are `{ "error": { "code": "INVALID_REQUEST|NOT_FOUND|SERVICE_UNAVAILABLE", "message": "generic public message" } }`, with 400/404/503 respectively. No database, filesystem or input payload details appear in public errors.

## Configuration and website connection

Only the backend uses DATABASE_URL, Better Auth secrets and MERCHANDISE_UPLOAD_DIR. Keep the two applications separate; no Product table, database synchronization, webhook or worker is needed.

Set backend `STOREFRONT_BASE_URL` to the website origin (development example: `http://localhost:5173`). It is also the exact CORS allowlist for these public reads; credentials are not enabled. Prefer forwarding only `/api/storefront/*` from the public site to this backend, preserving no-store headers. Do not forward admin/auth paths to the public hostname. If accessing the API across origins, resolve relative image URLs against the configured API origin.

`STOREFRONT_PRODUCT_ROUTES_READY=false` initially. Set it true only after Prompt 17 implements the website's `/products/:slug` route. The item page then exposes **Open on Store** for an API-visible listing at `${STOREFRONT_BASE_URL}/products/:slug`. The setting is an explicit deployment readiness flag, not a claim that the website has been deployed.

Publication becomes readable after database commit; a frontend rebuild is unnecessary. Admin revalidatePath updates only the manager. Prompt 17 is now implemented in the existing `D:\Project\kokoniv2` website: request-time React/Vite SSR, live `/shop` and `/products/:slug`, same-origin public forwarding, saved UUID cart intent, focus/cart refresh, safe metadata and dynamic sitemaps. See that project's `README.md` for the required Node production runtime and configuration. It has not been publicly deployed. Keep the readiness flag false in environments where the website has not yet been upgraded; set true once its product routes are running. Guest checkout, Stripe test payments, orders and reservations are now implemented; see [customer checkout](customer-checkout.md) for configuration and operational requirements.

The additive API extension for that website includes deliberately public `merchandiseCategory: {name, slug}`, and franchise facets now include `japaneseName` and visible-listing `count`. Public NFKC search uses the displayed title, public description/subtitle, franchise/lineup names, public and merchandise category names, and public character names. Internal item Japanese names hidden by public presentation and all private fields are excluded from search. No migration is required for this query/DTO extension.

After building both projects, `npm run test:storefront-http` starts both production runtimes against a fresh, isolated schema in `TEST_DATABASE_URL`, creates temporary approved image bytes and exercises publication, actual France-only stock, image authorization, price changes, zero stock, unpublication and batch cart resolution. It cleans its servers/schema/images, never seeds the development catalog, and uses `PUBLIC_WEBSITE_PATH` only when the public project is not at `../kokoniv2`.

## Verification

Integration fixtures use real managed image bytes in isolated PostgreSQL test schemas. Tests cover first publication, manual-content preservation, stale and duplicate prevention, slugs, currency/category/image rules, image order/ownership, approval revocation, France/Japan/transit/unknown geography, zero stock, archival/unpublication, public facets/filter/pagination/cart lookup, private DTO/error isolation, legacy readiness reporting, signed bulk partial results and unauthorized mutations. HTTP helpers verify no-store, bounded bodies, CORS and product-route gating. Browser verification exercises real admin Server Actions and the anonymous public routes.
