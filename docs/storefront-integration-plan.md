# Existing storefront integration review

Inspected 7 September 2026. Planning only: neither application's implementation nor its database was changed by this review. The public project's `npm run typecheck` passes. Inspection covered the application source, all components/hooks/data modules, styles, package/configuration files and build/deployment layout. `reference/kokoni-standalone.html` is an approximately 6 MB archived design export, not imported by the application; `dist` and `node_modules` are generated artifacts, not additional application backends.

**Recommendation: keep `D:\Project\kokoniv2` as the customer-facing website and `D:\Project\kokono-inv` as the merchandise/commerce backend. Use one PostgreSQL database behind the backend and a small public-safe HTTP API. Do not create a second Product table, storefront, stock store or database synchronization process.**

## 1. Current website architecture

| Area | Observed implementation |
| --- | --- |
| Frontend | React with TypeScript, Vite, CSS Modules and shared CSS tokens. Lockfile: React/React DOM 19.2.8, Vite 8.2.2, TypeScript 7.0.2, React plugin 6.1.1. |
| Entry/routes | `src/main.tsx` mounts `App`; one landing page with hash anchors such as `#shop`. No router or product detail routes. |
| Backend/database/ORM | None. No API client, server, database configuration, migrations or ORM. |
| Authentication/admin | None for customers or administrators. |
| Products | Twelve hard-coded objects `p1`–`p12` in `src/data/products.ts`, indexed by `productsById`. |
| Categories | Four TypeScript literals: Figures, Apparel, Prints, Goods. Filtering is entirely local React state. |
| Inventory | No quantities, reservations or stock source. Manually assigned product tags include In stock and Pre-order. |
| Images | Filename labels rendered by `ArtSlot`; no real product images, image records, uploads or storage service. `public` contains a favicon. |
| Cart | Existing reducer/context in `src/hooks/useCart.tsx`; in-memory map of product ID to quantity; no persistence, reservation or quantity limit. |
| Checkout/orders/payment | Checkout button has no handler. No checkout route, order model, payment provider or payment endpoints. |
| API/network behavior | No product HTTP calls. Search input is unconnected; newsletter only changes local state and does not submit email anywhere. |
| SEO | One title/description in `index.html`. No per-product metadata, canonical URLs, structured data, sitemap or server-rendered product HTML. |
| Caching | React `useMemo` and card memoization only. No data cache, service worker, revalidation hooks or webhooks. |
| Deployment | `vite build` targets `dist`, with source maps enabled. No hosting/CI/domain configuration found. Two sibling project folders; the public folder is not currently a Git repository. Actual live hosting cannot be established from these files. |

Relevant sources: `kokoniv2/package.json`, `vite.config.ts`, `index.html`, `src/App.tsx`, `src/data/types.ts`, `src/data/products.ts`, `src/hooks/useCart.tsx`, `src/components/{Shop,ProductCard,CartDrawer,SiteHeader,Newsletter}.tsx`.

The visual system, homepage sections, product-card layout, cart drawer and modal accessibility behavior are reusable. A package/framework upgrade is not a prerequisite for connecting live data. The missing functionality is the prerequisite. Vite's normal output can be hosted as static assets; `vite preview` is not a production server ([official deployment documentation](https://vite.dev/guide/static-deploy.html)). Meeting the complete future SEO requirement additionally needs SSR or a correctly invalidated prerendering system. The recommended Prompt 17 path is SSR in this existing React/Vite project, which adds a public rendering runtime without adding a second commerce backend. Vite supports SSR, but its built-in integration is low-level and that work must be budgeted explicitly ([official SSR documentation](https://vite.dev/guide/ssr.html)).

## 2. Exact Product/cart/order model and ownership mapping

There is a `Product` TypeScript interface, not a persistent Product entity. Choose **B at the data/view-model level**: extend/replace that interface with a public projection of SaleListing. Preserve its UI consumers where practical. A has no persisted entity to retain; C would introduce synchronization between a real database and a mock array without any business need.

| Current Product field | Current meaning | Authoritative future owner |
| --- | --- | --- |
| `id: string` | Literal p1–p12, also cart identity | Stable `SaleListing.id` UUID, exposed as `listingId`; slug is never cart identity. |
| `name` | Hard-coded card title | `SaleListing.publicTitle`, falling back to `MerchandiseItem.name`. |
| `universe` | Unstructured franchise name; one value is Mixed | Franchise reached through MerchandiseItem → Lineup → Franchise. Do not silently turn Mixed into a real franchise or a six-item bundle. |
| `meta` | Scale/material/dimensions marketing line | Optional listing-owned public subtitle if preserving this card line is necessary; never repurpose private notes. |
| `price` | Whole euros, e.g. 289 | `SaleListing.sellingPriceAmount` in integer minor units plus currency; 289 EUR becomes 28,900 minor units. |
| `category` | Figures/Apparel/Prints/Goods | Resolved public navigation category, mapped from the internal merchandise category with optional listing override. |
| `tag` | One mixed editorial/availability label | Availability derived from regional available stock; featured from SaleListing. Grail/Limited have no trustworthy field and must be omitted or separately modeled later. Pre-order is not inferred from lineup release status. |
| `slot` | Placeholder filename, not an asset reference | Selected, approved ItemImage objects delivered through a public-safe media endpoint. |
| Slug/description/featured | Absent | SaleListing slug, publicDescription and featured. |
| Stock/publication state | No quantities or explicit published flag | Inventory services and `SaleListing.published`, with archive visibility rules. Presence in the mock array is not a durable publication state. |
| Variants/timestamps | Absent | No variants in MVP. Existing SaleListing createdAt/updatedAt/publishedAt; item release precision retained separately. |

Cart lines currently resolve their name, price and image label through the mock `productsById` map. Preserve the reducer/context and drawer, but identify lines by listing UUID and resolve them through the API even when the item is outside the currently loaded shop page. Saved browser cart quantities are only purchase intent, never a price quote or reservation. Slug changes must not break a cart.

No website order/customer/payment tables exist. Future orders should be implemented once in the existing backend database, with the current website providing checkout presentation. Order items retain listing and merchandise IDs plus historical title/price/currency snapshots; that history is intentionally immutable, not another editable product catalog.

## 3. Recommended database, application and authentication boundaries

```text
Existing KOKONI React/Vite website (presentation, cart, later checkout)
                 │ public-safe reads / later commerce requests
                 ▼
kokono-inv Next.js backend (public API + protected admin/domain services)
                 │ only server-side database credentials
                 ▼
Existing PostgreSQL: catalog + inventory + SaleListing + later orders
```

They do not currently share a database: the public website has none. Keep one database, owned and migrated by the existing backend. Do not put Prisma, DATABASE_URL or internal services into the Vite browser bundle. Do not give a public rendering process general database credentials either; it can consume the same safe API. A separate database is unnecessary.

Keep two applications/deployments. A monorepo may later share pure public types/formatting, but is not required and should not move either project during publication work. The public site may initially use static hosting; Prompt 17's recommended SSR upgrade requires a compatible Node runtime. No hosting provider is prescribed because none is configured in the project. Production PostgreSQL and the current filesystem image store require persistent hosting/backups, not ephemeral function filesystems.

Prefer same-origin public `/api/storefront/*` forwarding to the backend. Future `/api/commerce/*` forwards only explicitly implemented commerce routes. Keep admin under a separate hostname with host-only internal session cookies. Do not proxy every backend path onto the public site. Cross-origin public reads are possible with deliberate CORS settings; CORS is not authorization. Public reads require no admin session. Internal Better Auth remains private; no public customer authentication exists to replace. Guest checkout is a sensible first order workflow, with customer authentication added only when required. All browser `VITE_*` values are public, so only non-secret configuration such as an API base URL belongs there ([official environment-variable documentation](https://vite.dev/guide/env-and-mode.html)).

## 4. Minimal integration contract

Extend existing `src/modules/publication/queries.ts`; do not publish `createCatalogQueries` results. Reuse pure normalization, date and money helpers and the shared fulfillment resolver. Its current public whitelist is a useful foundation, but currently lacks a listing UUID, numeric availability, public navigation mapping and usable image URLs.

Proposed versioned endpoints:

- `GET /api/storefront/v1/listings`: bounded pagination and public-safe filters; response `{items, pageInfo}`.
- `GET /api/storefront/v1/listings/by-slug/:slug`: one visible listing; unpublished/archived/not found returns 404.
- `POST /api/storefront/v1/listings/resolve`: bounded listing-ID array; a read-only batch resolution for cart lines, with unavailable IDs identified. No per-cart-line request loop.
- `GET /api/storefront/v1/facets`: visible public categories/franchises/characters only.
- `GET /api/storefront/v1/images/:imageId`: bytes only after checking selected image, approval and visible listing association.

DTO shape: `{listingId, slug, title, description, subtitle?, price:{amount,currency}, featured, franchise, lineup, characters, category, merchandiseCategory?, release:{value,precision}|null, images:[{id,url,alt}], availability:{status,availableQuantity}}`. Metadata includes only explicitly public values. Release value can be `2026-11`, never an invented public day. Selling price is the only catalog price in this contract. Currency must be explicit; mixed currencies cannot be silently sorted as comparable amounts or combined into one cart total.

`availableQuantity` initially equals the eligible France physical quantity. When reservations arrive, it becomes eligible physical quantity minus active allocations. Preserve the internal physical fulfillable total as a distinct concept; reservations must not rewrite balances or double-subtract units after a sale movement.

Create/update/publish remain protected admin service operations, not anonymous storefront write endpoints. No synchronization worker, database-to-database copy, event bus or publication webhook is required for the initial integration. Future checkout/order/payment endpoints are a separate contract, not part of public listing reads.

## 5. Inventory and pricing gaps

`fulfillableLocationIds` already requires explicit opt-in at each balance location and active, non-transit ancestry. It does **not** impose a country boundary: a JAPAN_WAREHOUSE marked fulfillmentEnabled can currently qualify. The seed opts France locations in and Japan out, but a seed convention is not a regional guarantee.

Extend that shared resolver with an explicit France storefront scope; do not add a separate stock calculator. Recommended small schema addition: physical-root `countryCode` (nullable, validated) inherited through traversal. Backfill FRANCE_HOME roots as FR and JAPAN_WAREHOUSE as JP; require review of generic WAREHOUSE/OTHER roots. Unknown geography is ineligible for France fulfillment. Do not derive country from editable location-code prefixes. Reject incompatible tree moves or resolve geography from the new root immediately. Japan and transit ancestry must never qualify for France delivery even after a mistaken fulfillment toggle. Existing internal global stock summaries remain global.

Public stock is a sum of direct balances at eligible locations, without counting hierarchy rollups twice. Example: JP 15 + France 3 + transit 2 means 3 available, not 20. Publication with zero eligible units remains visible as Out of stock; Add/Checkout cannot promise instant stock.

Website `src/lib/format.ts` currently rounds to whole euros. Reuse the existing shared minor-unit formatter semantics instead. Never feed 2,490 minor units to a formatter expecting 2,490 euros; display EUR 24.90 accurately. MSRP, acquisition cost and any future landed cost remain separate. Landed cost/margin are not implemented: publication review must display unavailable, not invent landed cost from the last receipt or subtract JPY cost from EUR price. Only compute margin from a defined comparable cost basis; percentage margin is `(selling price - cost) / selling price`, with zero-price handling and tax/FX assumptions stated internally.

## 6. Images, categories and required schema changes

The website has no image storage to migrate or merge. Existing ItemImage rows have approval/provenance fields, while bytes live under a private runtime upload volume. The private `/api/admin/media/[key]` route correctly requires an internal session. Do not remove its authentication.

Add a public media delivery path that references the same stored object, keyed by public image ID, validating approval and a selected association with a visible listing on every request. Return no storage key, source URL, originalUrl, provider, filesystem path or sourcing metadata. No file copy is needed for existing managed assets. External placeholder URLs are not automatically safe/public-ready; ingestion or a controlled delivery adapter may be required. Do not introduce an arbitrary URL-fetch proxy. Approval revocation/unpublication must stop future authorized delivery; already downloaded bytes cannot be recalled. Start with no-store public media until a revocation-aware cache policy exists.

For chosen image order/subsets, add `SaleListingImage(listingId,itemImageId,displayOrder)` with unique associations and same-MerchandiseItem integrity enforced in domain validation and, where feasible, composite database constraints. Selection never grants approval; both conditions are required. Backfill existing listing associations only from already-approved images belonging to the linked item.

Internal Category is a hierarchical design taxonomy (e.g. Acrylic Stand); website categories are broad navigation. Keep both meanings explicit. Recommended minimal mapping: `PublicCategory(id,slug,name,displayOrder,active)`, optional `Category.publicCategoryId` default mapping and optional `SaleListing.publicCategoryId` override. This is many internal categories to one navigation category; it does not require a generic many-to-many mapping table in the MVP. Seed the four existing public labels. Resolve override then default; flag unmapped items for review instead of silently assigning Goods. Customer-facing categories may be changed without changing item identity or stock.

Retain SaleListing's existing UUID, unique merchandiseItemId, unique slug, price, featured/publication flags and timestamps. Optional sale-only additions for the reviewed design: `publicSubtitle`, `seoTitle`, `seoDescription`. Maintain one SaleListing per item. A `SaleListingSlugRedirect` table is needed only if changing already-public slugs is allowed; otherwise keep published slugs stable for the MVP. No persistent public Product table and no stock-copy columns are required.

Reservations, Customers, Orders, OrderItems, payment attempts/events and shipments belong to Prompt 19, not the publication migration.

## 7. Publication and cache flow

Item detail or existing bulk action → existing internal review extended with required fields and approved image selection → validated SaleListing/category/image changes committed through the publication service → website reads the new public projection → `/products/:slug` becomes available.

The prior bulk phase already implemented `publication.publishReviewed`, basic listing validation, stale-review checking and bulk handoff. Extend these; do not recreate them. Add the missing item-detail entry point, public description/image/category/featured/SEO controls, richer review columns and Open on Store URL. Show Open on Store only for public listings; drafts can have a clearly internal preview.

First publication and edits are database transactions; independent bulk rows may keep the current explicit per-item transaction/results policy. A public API read is synchronous against that database. Start public data endpoints and SSR product HTML with explicit no-store behavior. Client data is refetched on navigation/focus and before cart validation; existing open tabs are not pushed updates magically. Do not fall back to mock items on network errors.

Current admin `revalidatePath` calls affect the admin application only. They do not update a separately deployed Vite site. With request-time data and no-store responses, publication requires neither a frontend rebuild nor a Next revalidation webhook. If caching is added later, invalidate not just listing edits but also inventory changes, location eligibility, image approval, category visibility, archival and future reservations. Restrict cross-application cache hooks if introduced. Publication success means the database commit succeeded; a public site outage is a separate delivery/preview error.

## 8. Routes and migration

There are no existing product URLs to preserve in this local code. Retain the homepage and its `#shop` anchor for compatibility; add `/shop` and canonical `/products/:slug`. Upgrade product cards to link to detail pages. Convert universe/category navigation into actual filters. Do not assume that local inspection proves there are no independently deployed legacy URLs: obtain any live domain/redirect requirements before rollout.

The user confirms the twelve products are mockups. Preserve them as development fixtures; remove them from the production data path when live reads work. Do not import p1–p12 as genuine merchandise or publish them automatically. No existing orders, customer accounts or persisted carts need migration in this codebase. If subsequent evidence reveals real records, export/backup first and produce a reviewed link map `legacyProductId → merchandiseItemId → saleListingId`; compare trusted SKU/JAN and franchise/lineup/category identity, treating names only as suggestions. Persist that legacy mapping only if real legacy references exist. Never auto-merge by name alone.

Any later import must convert whole-euro mock/legacy amounts to EUR minor units exactly once, preserve real public slugs where present, and require manual interpretation of bundle/variant-like mock records. Data with no reviewed match stays unlinked. Cut over production reads using environment configuration with fixtures explicitly development-only; API errors must not make fake products appear for sale.

## 9. Files/modules to change later

| Project | Existing files to extend | New modules expected |
| --- | --- | --- |
| Merchandise backend | `prisma/schema.prisma`; `modules/publication/{queries,service}.ts`; `modules/locations/service.ts`; shared fulfillment/money/date helpers; `modules/bulk-management/{service,actions}.ts`; `components/admin/bulk-review-dialog.tsx`; catalog item detail page | Public contract/validation, public API route handlers, approved-media resolver/route, image/category publication controls, schema migrations and isolation/contract tests. |
| Public website data | `data/types.ts`, `data/products.ts`, `lib/format.ts`, `components/{Shop,FilterBar,ProductCard}.tsx` | Public API client and adapter; loading/error/empty states; URL filter/pagination helpers; product detail route. |
| Public website cart | `hooks/useCart.tsx`, `components/CartDrawer.tsx` | Batched line resolution, optional versioned cart persistence, availability validation; later checkout client. |
| Public website presentation | `App.tsx`, `main.tsx`, `index.html`, `components/{SiteHeader,Universes,Hero,ArtSlot}.tsx`, associated CSS modules | Reusable real product image view, shop/product route composition; for SSR, server/client entries and production server configuration. |
| Public deployment | `vite.config.ts`, `package.json`, configuration examples and README | API forwarding/base URL config, SSR build/start scripts when implemented, public route status/metadata tests. Do not deploy the archived reference export. |
| Future commerce backend | Existing inventory operation/fulfillment services; publication lookup | One order/reservation/payment/shipment service set, migrations and public-safe commerce routes. |

Preserve current CSS tokens, card/drawer appearance and unrelated sections. All source-level updates above are proposed, not made during this inspection.

## 10. Risks and readiness

1. **Ready for reuse, not ready for sales:** mock products/images, nonfunctional search/checkout and local-only newsletter confirmations must not be mistaken for live commerce.
2. **Regional inventory:** current opt-in alone can count a Japanese warehouse; geographic eligibility must be explicit and tested in shared logic.
3. **Cents/currency:** existing formatter hides cents and current cart assumes EUR everywhere. Server-priced, single-currency checkout is required.
4. **Image disclosure:** returning a raw storageKey is not a usable or sufficiently isolated public media contract; private endpoints must stay private.
5. **No reservation system:** concurrent buyers can oversell if a display-time availability check is treated as a stock reservation. All outgoing stock operations eventually need reservation awareness.
6. **Two-app cache behavior:** Next admin revalidation is not public Vite revalidation. Cached prices/availability, HTML or approved images need explicit freshness rules.
7. **SEO:** current HTML is a single client-rendered shell; real product metadata/404 responses require the explicit rendering upgrade in Prompt 17. Do not transfer the admin root's `robots: noindex` or global CSS to the public app.
8. **Internal data boundary:** the public website has no leaking product API today because it has no API. Existing internal Server Actions expose rich internal records only after authorization. The dangerous future shortcut is wiring these or `createCatalogQueries` directly to anonymous routes. Keep dedicated public selectors; also test metadata, JSON-LD, API errors and media redirects for leaks.
9. **Operational assumptions:** footer says Rotterdam, while the requested stock policy is France; hero/ticker promise dispatch times, preorders and free shipping without supporting business logic. Confirm/replace these mock claims before launch. Gacha is a banner mockup with no engine; do not turn its promises into checkout features implicitly.
10. **Deployment unknown:** no current public host, domain, customer auth or payment provider was established. Keep secrets out of source maps/client bundles; choose production runtime, geography, image volume, payment flow and tax/shipping rules before enabling sales.

## 11. Small implementation phases and prompt changes

1. Freeze the integration contract, France fulfillment policy, public taxonomy, image policy and storefront URL. No second database.
2. Prompt 7: extend the existing publication service/review; migrate only required sale/category/image/geography fields; expose public-safe listing/media reads; add contract and authorization tests. Do not rebuild the storefront here.
3. Prompt 17: connect and complete the existing Vite site's shop/cards/cart/product routes; add SSR/public SEO delivery and deployment support explicitly. Replace the instruction to use an existing Next storefront cache: there is no Next storefront. Preserve the existing visual design and demo fixture archive.
4. Prompt 19: build the one missing order/reservation/checkout backend, connect the existing cart/drawer to it, and choose payment/customer policy. Extend all inventory mutation paths to respect reservation allocations. Do not create a parallel cart or order application.

The three complete replacement prompts accompanying this report are the execution specifications for those later phases. They must begin by inspecting the then-current code because work may have advanced since this review.
