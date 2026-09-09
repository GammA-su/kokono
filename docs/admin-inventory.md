# Inventory and physical storage

The internal navigation links to `/admin/inventory` and `/admin/inventory/locations`. The former `/admin/merchandise/inventory` address redirects while retaining filters. Item details and movement history link directly to inventory commands.

## Locations

Create and edit warehouses, shelves, boxes and other locations with a unique code, name, type, parent, active flag, explicit fulfillment flag and notes. Every balance belongs directly to its location; parent counts do not duplicate child stock. Full paths such as `FR-HOME / Shelf A / Box A1` appear in inventory, item details, commands and history.

Fulfillment uses the existing shared service: the balance's exact location must opt in, and every ancestor must be active and outside transit. Enabling FR-HOME does not automatically enable its boxes. Names and location codes do not determine eligibility.

Deactivate a location using Edit → Active. Existing stock and history remain visible. Stock may leave inactive locations, but neither they nor descendants can receive it. Reactivation uses the same form. Location saves validate cycles, serialize hierarchy changes and reject stale edit timestamps. Deletion is not offered. Reparenting changes the current physical path without creating a stock transfer; use it when a whole shelf/box changes its physical parent.

## Inventory commands

`/admin/inventory/record` searches the existing catalog, including unowned and archived items. Receive stock creates PURCHASE; Transfer uses source and destination; all other supported movement types are available in the same form. Every command goes through the existing `applyInventoryOperation` service and records the authenticated internal actor.

- PURCHASE adds units and accepts optional acquisition unit cost and currency together, purchase/source reference, and note. Prices are entered as decimal currency amounts and stored in exact minor units.
- TRANSFER requires positive quantity and distinct endpoints, atomically checks and removes source stock and adds destination stock. Ownership remains unchanged.
- SALE, DAMAGED and LOST remove units.
- RETURN, GIFT, GACHA and OTHER explicitly select incoming or outgoing. Existing positive GACHA acquisitions remain valid; negative GACHA records represent issued prizes.
- ADJUSTMENT accepts a nonzero signed delta, location, mandatory reason and mandatory note. The reason and note are saved together in immutable movement notes. There is no direct balance assignment.

Each form receives an operation key retained across failed submissions and retries. Successful submission disables that operation; Start new operation explicitly creates a fresh key. Replaying a key with the same payload returns the original movement; a changed payload is rejected. Operation-key locks and item row locks prevent duplicate changes and concurrent overdrafts. A shared hierarchy lock prevents location edits racing destination validation. Inactive source stock can still be reconciled or transferred out.

## Read views

Inventory reuses `createCatalogQueries` for filtering, NFKC search, sorting, pagination and stock summaries. It includes archived owned items by default. A location filter matches direct stock at that location; item totals and the physical-location column still show all owned stock.

Latest acquisition cost means the latest incoming, non-transfer movement with a recorded unit cost. A later movement with no cost does not erase the last known price. Estimated value is this latest known unit cost multiplied by all currently owned units. It is explicitly an estimate, not FIFO, weighted average, landed cost or accounting valuation. No foreign-exchange conversion or mixed-currency total is provided. Large estimates retain exact integer precision.

Item history remains at `/admin/merchandise/catalog/[itemId]/movements`. Filters cover movement type, either source/destination location, inclusive UTC dates and page size. It shows timestamp, signed quantity (or units moved for transfers), current source/destination paths, actor, recorded cost, reference, notes and operation key. Location names/paths reflect the current hierarchy; immutable movement IDs, location IDs and amounts retain their original meaning.

## Migration and verification

Run `npm run db:deploy` before using the new interface. Migration `20260907213000_inventory_management` permits outgoing GACHA movements while preserving all existing rows and adds a partial index for latest recorded acquisition costs. It does not create parallel inventory or order tables.

`npm test` exercises the domain and management command adapters against an isolated PostgreSQL test schema. Inventory coverage includes receive, hierarchy paths, multiple locations, JP → transit → France, preserved ownership, insufficient balances, replay/conflict handling, concurrent deductions, fulfillment, damage/loss and other removals, adjustments, archival, cyclic/stale location edits, history filters, exact money, authorization and immutable history. `npm run test:admin-http` checks a running local app's protected routes and form controls without creating inventory movements in the development database.
