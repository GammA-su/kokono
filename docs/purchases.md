# Purchasing

The internal **Purchases** section lives at `/admin/purchases`. A purchase records the business order; a watch records sourcing intent, and the inventory ledger records physical stock. Creating or paying for a purchase never adds inventory or changes a public listing.

1. Create a purchase, search the existing catalog, and add one or more lines. Each line has its own quantity, price, condition, seller URL and notes. The same merchandise can appear on separate lines with different prices or deliveries.
2. Save as draft to edit later, or choose Ordered, Paid or Other. Commercial fields lock after the draft stage. Draft edits reject stale versions.
3. Open **Receive purchase**, select the lines that physically arrived and choose an active storage location. Each line is received in full once; use separate lines before ordering to represent split deliveries.
4. The detail page shows who received each line, where, when, its recorded cost and the current watch target gap. Watches are never disabled automatically.

All amounts use integer currency minor units and a single currency per purchase. The subtotal is calculated from line prices and quantities. Domestic shipping, fees and additional taxes are separate amounts; they are **not automatically allocated to landed inventory cost**. Enter only additional taxes that are not already included in the prices.

## Receiving and lifecycle

Receiving uses the existing inventory domain operation inside the purchase transaction. It creates one `PURCHASE` movement per line with the ordered quantity, line unit price, currency, receiving actor, optional receipt note and a `PURCHASE_ITEM` reference. The purchase row is locked for receipt, draft edits and status changes. Item locks are acquired in deterministic order.

The operation key is `purchase-item:<purchase-item-id>:receive`. A unique receipt relation and database receipt validation prevent multiple or mismatched receipts. A retry by another internal operator returns already-received counts. Retrying into a different destination is rejected: moving received stock requires a transfer. All selected lines commit together, or all roll back.

Japan is determined by configured/inherited location country, never its name. Completing all lines in Japan sets `RECEIVED_JAPAN`. Other destinations keep the commercial status; received line counts independently show completion. The country at receipt is retained even if location configuration changes later.

Draft, cancelled and refunded purchases cannot receive goods. Cancellation is allowed only before any receipt. A refund preserves physical inventory and history; physical returns must use explicit inventory movements. There is no destructive purchase-delete interface. Received purchase lines and inventory movements are immutable.

Creation also accepts a stable purchase UUID, with a request fingerprint to prevent duplicate form retries or conflicting reuse. No marketplace reference uniqueness is assumed: several sellers can use the same external reference.

## Migration and verification

`20260908120000_purchasing_records` adds the purchase status enum, purchases, purchase items, constraints and the receipt integrity trigger. Existing inventory movements are untouched and are not retrospectively matched to orders. On another environment run `npm run db:deploy` and `npm run db:generate` before starting the updated app.

`tests/purchases.integration.test.ts` exercises creation, multiple lines, money validation, draft concurrency, Japan and France receiving, watch satisfaction, cancellation/refund, duplicate and simultaneous receipts, transaction rollback, inactive location ancestry, database immutability and internal authorization against a disposable PostgreSQL schema.
