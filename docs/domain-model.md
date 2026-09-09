# Domain model and invariants

## Independent concepts

```
Franchise 1 ── N Lineup 1 ── N MerchandiseItem
                                  ├── 0..1 PurchaseWatch
                                  ├── N InventoryBalance (one per storage location)
                                  ├── N InventoryMovement
                                  ├── 0..1 SaleListing
                                  ├── N ItemSource
                                  ├── N ItemImage
                                  └── N ItemCharacter ── Character
```

`MerchandiseItem` identifies a design in a release. Five identical stands are one item with five units. Catalog membership is established by the record's existence, so there is no `catalogued` flag. No inventory, watch, or listing records are created implicitly with an item.

`PurchaseWatch` is one shared internal configuration per item, whether enabled or disabled. Disabling preserves its record. There is no coupling between its state, quantity owned, and publication. `savePurchaseWatch` is a full configuration save; send the fields to preserve when changing it.

Internal SKU and item slug are globally unique. Bulk entry generates SKUs as a readable lineup token, a digest of the lineup ID and a per-lineup sequence, allocated while the lineup row is locked; identity never comes from the item name, and a manual SKU that already exists is rejected rather than reused. Names are intentionally nonunique. JAN is indexed but nonunique for assortments. The runtime catalog creation service accepts JAN-8 and JAN-13 numeric strings; it does not claim to verify a barcode's identity. Franchise slug is globally unique; lineup slug is unique within its franchise. A listing has its own globally unique public slug. An item's franchise is reached through its lineup, so it is not duplicated on the item.

Character membership is many-to-many. A character has one primary franchise, but the item join does not prohibit cross-franchise characters, allowing collaboration merchandise. A later lineup-to-franchise join can add secondary crossover franchises while retaining the primary navigation hierarchy.

`LineupSource` supplies multiple release-level verification links alongside `ItemSource` for item-specific evidence. Both use the same provider, source type, URL, checked timestamp, and notes conventions. Lineup URLs are unique within a lineup. The admin source editor preserves IDs, creation timestamps, and the original precise checked timestamp for retained URLs; changing a checked calendar day records the newly selected day. Sources are not fetched or verified automatically.

## Partial dates

Lineup announced/release dates and the merchandise item's own release date all use a PostgreSQL `DATE` plus nullable `DatePrecision`:

| Source | Stored date | Precision | Display |
| --- | --- | --- | --- |
| 2026 | 2026-01-01 | YEAR | 2026 |
| November 2026 | 2026-11-01 | MONTH | November 2026 |
| 14 November 2026 | 2026-11-14 | DAY | 14 November 2026 |
| Unknown | NULL | NULL | Unknown/blank, chosen by future UI |

The first day/month is a storage anchor, **not an asserted release day**. PostgreSQL checks enforce paired nullability and normalized anchors on lineups and merchandise items alike.

`MerchandiseItem.releaseDate` exists because items in one lineup can ship on different dates and because bulk entry must allow a per-row override of the inherited lineup date. It is independent of the lineup's date: a null item date means the item has no separately recorded release, not that it inherits at read time. Bulk entry writes the inherited value onto each row explicitly, so what is stored is what was reviewed.

Use `parsePartialDate("2026-11")` to build the pair and `formatPartialDate(date, precision)` to render it. The formatter uses UTC so machine timezone cannot change the displayed calendar date. Input uses the strict forms `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` and rejects invalid calendar dates.

Always interpret date sorting and range filtering with precision. For a future date-overlap search, a YEAR represents the full calendar year and a MONTH the full month; comparing only the anchor against a narrow day range would lose imprecise releases. No date filtering UI is implemented yet.

## Money

All amounts are PostgreSQL integers, expressed in the currency's minor units. `1650 / JPY` means ¥1,650; `2500 / EUR` means €25.00. There is no implicit foreign exchange conversion and no floating-point price column. The per-value limit is 2,147,483,647 minor units.

- Official MSRP belongs to the merchandise item and includes `INCLUDED`, `EXCLUDED`, or `UNKNOWN` tax status.
- Purchase-watch maximum unit price belongs to the watch, defaults to JPY, and may have no amount yet.
- Acquisition unit cost belongs to the immutable receipt/movement snapshot.
- Selling price belongs to the sale listing.

Optional MSRP and acquisition amounts require their currency alongside them. An absent MSRP has `UNKNOWN` tax status. Currency fields must be three uppercase letters; currency formatting and any future supported-currency policy must use the currency's exponent rather than always dividing by 100. Tax status describes the official MSRP only.

Landed costs are not silently combined with receipt cost. A future cost-allocation table can reference stable movement IDs for freight, fees, and exchange-rate snapshots without rewriting acquisition history.

## Location-aware inventory

`InventoryBalance` has the composite primary key `(merchandise_item_id, storage_location_id)` and a nonnegative integer quantity. A missing row means zero. Balances are stored at the exact location, never duplicated as ancestor rollups.

Locations form an acyclic parent tree. PostgreSQL triggers serialize hierarchy edits and reject cycles. Location codes are globally unique and are identifiers, not slash-separated paths; the parent relation supplies the display breadcrumb.

Total **owned** quantity sums all balances, including in-transit and inactive locations. Those units remain owned. To calculate physically on-hand stock later, exclude locations in transit, including descendants of a transit node. A location becoming inactive does not make its units disappear.

`fulfillmentEnabled` is an explicit extra opt-in for public availability at the exact balance location. It defaults to false and is not inherited. All ancestors must be active and outside transit. This prevents warehouse stock still in Japan or shipment stock from automatically appearing locally available. A published listing can therefore be out of stock for fulfillment while the business still owns units elsewhere. Set fulfillment explicitly according to the business's actual shipping capability.

Incoming operations reject an inactive destination or ancestor. Existing stock can leave inactive locations so it can be relocated or reconciled. Archived merchandise can also be counted, transferred, or corrected; archival is not a ban on preserving accurate stock records.

## Inventory movement semantics

| Movement | Delta | Locations |
| --- | --- | --- |
| PURCHASE | Positive | Destination only |
| SALE, DAMAGED, LOST | Negative | Source only |
| TRANSFER | Positive units moved | Distinct source and destination |
| RETURN, ADJUSTMENT, GIFT, GACHA, OTHER | Signed | Positive: destination only; negative: source only |

`RETURN` supports customer returns into stock and returns to a supplier out of stock. Record the context in notes/reference fields. `DAMAGED` removes units from managed stock; retaining damaged units as separately sellable goods will require the deferred condition/lot model. `ADJUSTMENT` requires an explanation. All deltas are nonzero integers.

A transfer creates **one** immutable ledger row, subtracts its positive quantity from the source, and adds it to the destination. Consequently `SUM(quantity_delta)` across all movements is **not** an ownership total: transfers are not acquisitions. Use balances for current totals. Ledger reconciliation expands each movement into negative source and positive destination contributions.

Japan → in transit → France is two transfers using the same item ID. Customer shipment is an outgoing SALE to an external party, not a transfer into an owned customer location. Order/reservation and shipment timing rules are deferred.

`applyInventoryOperation` executes one PostgreSQL transaction:

1. Check internal membership for a human actor.
2. Acquire an operation-key advisory lock, then return an exact prior result or reject changed input.
3. Acquire a shared hierarchy advisory lock to serialize against location edits, then lock the merchandise row before touching any balances. This serializes operations for that item, including creation of previously missing balances.
4. Validate locations and destination availability.
5. Decrement source conditionally on sufficient quantity and increment/upsert destination.
6. Append the movement and commit. Any failure rolls back both balance effects and the ledger insertion.

The operation key is globally unique. Its SHA-256 fingerprint covers normalized inputs and the acting user. Retrying identical input returns `{ replayed: true }`; reusing the key for changed input or a different actor raises `OPERATION_KEY_CONFLICT`. Keep the same key for transport retries, and use a new key only for a new business operation. Clients never send `actorUserId`; the server obtains it from the authenticated session.

The lower-level operation function is a trusted server/CLI primitive, not a public endpoint. Only controlled seeds/imports may pass a null actor. All Next.js server actions require internal authorization and provide their actor automatically. Direct writes to balances or manual ledger inserts must not be used by application features. `reconcileInventory` reports discrepancies without rewriting anything.

PostgreSQL triggers reject UPDATE, DELETE and TRUNCATE on movement history. Corrections append a compensating movement, optionally referencing the original through `referenceType = InventoryMovement` and `referenceId`. Foreign keys use RESTRICT for merchandise, locations, and ledger actors, preserving historical references. Auth account/session cleanup may cascade only from users without protected inventory history.

## Publication and privacy

`SaleListing` is optional and unique per merchandise item. Saving a new listing creates a draft. Publishing records a timestamp; unpublishing preserves the most recent publication timestamp. Publication does not depend on stock quantity and never changes a watch or balance.

`getPublicListing` and `listPublicListings` both require a published listing and unarchived merchandise, lineup, and franchise. They use an explicit select and return a public DTO, including only approved image keys/captions/roles. They return availability, not exact stock quantities or location details.

Purchase costs, private notes, watch settings, movement history, and source/image provenance are neither selected for the DTO nor returned publicly. Public description is taken only from `SaleListing.publicDescription`. A missing public title falls back to the catalog item name. Objects added to the catalog later do not automatically become public fields.

There are no public storefront routes or caches yet. Internal merchandise routes are authenticated and invalidate their admin layout after mutations. When adding public routes, use the public query functions and invalidate relevant page/data caches on catalog, image approval, publication, location eligibility and stock changes. Recheck stock transactionally when orders are introduced; a browsing availability result is never a reservation.

Archiving preserves listing and watch configuration as well as stock/history. It hides the item from public queries, including direct slug lookups. The internal UI should expose archived stock for reconciliation. Restoring an archive would restore its previous publication eligibility, so a future restore flow should make that behavior explicit.

Bulk entry creates each item with its character relations, one initial `ItemSource`, one `PRIMARY` `ItemImage` and an optional `PurchaseWatch` inside a single transaction. Weak duplicate signals (JAN, Japanese name, normalized English name, and matching characters/category/MSRP) are reported for review and never silently reject a row; only unique-constraint conflicts such as an existing internal SKU are refused.

In the lineup admin, Delete permanently removes only an empty lineup and its sources. Any lineup containing merchandise is archived instead, after exact-name confirmation. Its items and stock remain visible internally; an Include archived filter and a clearly described Restore action make archival reversible. Duplicating creates only release metadata and source links, resets checked timestamps, and opens the new copy for editing. It does not duplicate merchandise, stock, watches, or listings.

## Future merchandise structures

No speculative parent-item column or full variant system is installed. Add an `ItemRelationship` table later with stable `parent_item_id`, `child_item_id`, a relation type such as `COLLECTION_MEMBER`, `PACK_CONTAINS`, or `VARIANT_OF`, and quantity where relevant. Its foreign keys can reference the existing merchandise IDs without replacing items, listings, or their history.

A collection parent need not have stock or a listing. A sealed box, an individual random pack, and an identified character design can each be independent merchandise items linked by this table. Opening a box will need a new multi-item transformation operation that consumes the box and creates appropriate contents in one transaction. It must not be represented as today's single-item transfer or by double-counting an unopened box and its contents.

Condition-specific stock, batches, physical-copy provenance, multiple offers per item, purchasing automation, and online checkout are separate additions. Inventory lots would introduce another balance dimension and an explicit migration of existing balances to a default lot, while retaining the canonical merchandise records and immutable historical movements.

## Reference documentation

- [Next.js server mutations and authorization](https://nextjs.org/docs/app/getting-started/mutating-data)
- [Better Auth with Prisma](https://better-auth.com/docs/adapters/prisma)
- [Better Auth Next.js integration](https://better-auth.com/docs/integrations/next)
- [PostgreSQL row and advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html)
- [DeepmergeTS 8 changes used by the scoped tooling override](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0)
