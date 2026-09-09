# Assisted merchandise source import

Open **Import from official page** from the Lineups list or a lineup detail page, or visit `/admin/merchandise/import-source`.

## Administrator workflow

1. Choose an active franchise and one of its active lineups, enter the source provider, source type and public HTTPS source URL.
2. For a new lineup, use **Create a lineup in a new tab**. This opens the existing lineup workflow. Return to the importer and **Refresh lineups**; the provider and URL remain in the form.
3. **Extract candidates** downloads and parses one page. This makes no catalog writes. Every candidate starts unselected, including confidently matched products.
4. Review the extracted names, unresolved character names, category suggestions, dates, prices, images and sources. Edit any extracted merchandise field. Character associations use the existing picker; no character/category records are created automatically. Image and source editors support multiple references.
5. Select products and **Validate selection and duplicates**. Errors refer to the selected records in displayed order. Original extraction warnings remain visible as context; current server validation determines whether import can proceed.
6. Review current duplicate warnings, acknowledge unresolved names and extracted fields, and explicitly acknowledge duplicates if present. Click **Import Selected Products**. Changing any candidate or selection invalidates the validated review and removes the final action until validation runs again.

Only the selected products are inserted, in one atomic transaction using the shared catalog writer and SKU allocator. This importer creates no inventory, InventoryMovement, PurchaseWatch or SaleListing. It never changes existing items, and it never publishes anything to the storefront.

Extraction/review tokens are signed, actor-bound and expire after 30 minutes. A reviewed candidate has a fixed item ID so a repeated/concurrent confirmation cannot insert it twice. If only some candidates were imported through a different selection, re-extraction/review is required. Database/category/character/archive and duplicate checks run again before the transaction writes. If a transaction fails, none of its selected products are created.

Failures preserve the source URL in the interface. Retry a failed extraction or change the source. Source content is not persisted before confirmation, and review state does not survive a page reload.

## Supported extraction and limitations

The initial adapter is **structured-v1**, a provider-independent adapter for Schema.org Product JSON-LD (including products inside graphs/variant collections) and Product microdata. A page without structured products can yield one low-confidence candidate from its Open Graph title/image or heading. That fallback may describe the whole release, so the administrator must decide whether it is an individual merchandise item.

The importer does not run JavaScript, follow product links to crawl a site, bypass authentication/anti-bot pages, scrape marketplaces in the background, or use AI translation. Dynamic or custom merchandise grids may require a provider-specific adapter or manual/CSV entry. The provider suggestions in the input record attribution; they do not imply a dedicated KADOKAWA, Animate, Good Smile, AmiAmi, COSPA, Movic or Ichiban Kuji parser already exists, or certify a site's ownership.

Japanese names retain their original spelling, full-width characters and internal spacing. When structured data supplies a separate English alternate name, it may be used for display; otherwise the original name is used. No translation is generated. The original Japanese extraction is also retained in ItemSource notes after confirmation.

Dates accept unambiguous `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, Japanese year/month/day forms and English month/year or day/month/year forms. Year/month dates keep YEAR/MONTH precision; the shared storage anchor never becomes invented display precision. Ambiguous ranges, seasons, timestamps and unsupported date text remain warnings for manual review.

MSRP is populated only from explicit MSRP price specifications or labelled manufacturer-suggested-price properties. An ordinary offer price remains a warning, not an assumed MSRP. Amounts use shared exact minor-unit parsing. Tax inclusion remains UNKNOWN until reviewed. Missing fields stay blank.

Category matching requires a unique exact normalized category name/slug or a small explicit Japanese terminology mapping. Character matching uses existing franchise-scoped names/aliases; exact Japanese names appearing in a product title can be suggested with a warning. Ambiguous or unmatched names remain visible for deliberate association or omission.

## Provenance and images

Every imported item retains the fetched source page, the original requested URL when a redirect occurred, and a product URL when supplied, as distinct ItemSources. Edited/additional sources are added; original extraction evidence cannot be removed by changing the editable source list. Shared page/image references are weak duplicate signals, alongside the existing JAN/name/lineup duplicate checks.

Images preserve original URL, source URL and provider. Preview downloads use an authenticated same-origin proxy, not the source page's HTML or a direct untrusted browser request. The proxy returns only PNG/JPEG/WebP with matching signatures/content types, reusing the application's media detection policy. Preview bytes are not stored. Imported images remain remote references in the existing image model and always have `approvedForPublicUse = false`. Public redistribution approval remains separate per-item work.

## Network and payload boundaries

- HTTPS only, standard port 443, without userinfo or URL fragments; local hostnames, IP literals on private/reserved networks and unsupported protocols are rejected.
- Every DNS answer must be public. Mixed public/private answers fail. IPv4 private, loopback, link-local, carrier NAT, benchmark, documentation, multicast, reserved and known cloud virtual endpoints are blocked. IPv6 is limited to ordinary global unicast, excluding transition/documentation/special-purpose ranges.
- The HTTPS socket uses the validated address through a pinned lookup and address family, with the original hostname retained for normal TLS verification. Connection pooling is disabled. No cookies, authorization headers or ambient proxy settings are forwarded.
- At most three redirects; every destination goes through the complete URL/DNS checks again. No implicit redirects, meta refresh, scripts, frames, stylesheets or linked-page fetches execute.
- A 12-second deadline covers DNS, redirects and body receipt. Limits are 2 MiB HTML, 1 MiB image data and 16 KiB response headers. Both declared and streamed sizes are checked. Unexpected compression is rejected; UTF-8, Shift-JIS/Windows-31J and EUC-JP text are supported.
- Up to four concurrent downloads per application process. Extraction is limited to 50 candidates, 25,000 parsed elements/structured-data nodes, eight images and ten editable sources per candidate. Oversized or malformed data fails without writes.
- HTML is parsed inertly with `parse5`; text appears through normal escaped React rendering. Neither arbitrary source HTML nor SVG/script payloads are embedded. Image responses are private, uncached, same-origin, nosniff and sandboxed.

## Adding adapters and verification

Add a module under `src/modules/assisted-import/adapters/` implementing `SourceAdapter`: an ID, label, strict host `supports` predicate and pure `extract(SourcePage)` function returning candidate values and warnings. Register it before the generic fallback. Keep provider selectors/terminology in that adapter, reuse date/money/reference helpers and add sanitized local HTML fixtures. Adapters receive downloaded HTML; they must not perform their own network calls or database writes.

Fixtures live under `tests/fixtures/sources/`. Tests cover structured/microdata/fallback extraction, original Japanese names, multiple images/sources, precision, explicit MSRP, unmatched references, selection/confirmation, duplicates, atomic validation, idempotency, authorization, DNS pinning, redirects, address rejection, streaming limits and content handling. No unit/integration test depends on live third-party websites.

No schema migration is required. The only new direct runtime dependency is `parse5`, a standards-based HTML parser. See its [official parsing API](https://parse5.js.org/functions/parse5.parse.html) and Node's [DNS API](https://nodejs.org/api/dns.html) for the underlying parsing/resolution interfaces.
