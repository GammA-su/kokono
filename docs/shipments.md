# International shipments and consolidation

Use **Shipments** at `/admin/shipments`, or **Create shipment** from inventory. Shipments reference the existing merchandise catalog and inventory ledger. No purchase lots, carrier integrations or second inventory system are introduced.

## Preparation

Choose an exact active Japan origin location, a configured in-transit group and a planned active France destination. Search reuses catalog queries, Japanese/NFKC matching, exact-location stock filtering and server pagination. Select merchandise and enter each quantity independently. Stock in child locations is not silently counted at its parent; consolidate it with normal inventory transfers first if necessary.

Draft creation validates availability but does not reserve or move stock. Contents and route can be edited in DRAFT, PACKING or READY. Dispatch checks availability again transactionally, so overlapping drafts cannot overdraw origin stock. PostgreSQL generates internal numbers shown as `JP-00012`; gaps after rolled-back operations are expected.

## Dispatch and delivery

**Ship shipment** records the actual shipment date and transfers every line from Japan into a dedicated child StorageLocation under the selected transit group. The child displays the shipment number and is explicitly in transit and non-fulfillable. Separate consignments therefore cannot draw from each other's transit balance during delivery.

Dispatch sets SHIPPED. Intermediate status updates can record IN_TRANSIT and CUSTOMS. **Deliver shipment** records the actual arrival date, transfers the entire consignment into the chosen France location (including a nested shelf or box), and sets DELIVERED. The final placement is retained. Country is resolved through existing location configuration and hierarchy, never through names. Explicit location fulfillment configuration determines availability.

Each shipment is dispatched and delivered in full. Partial deliveries, per-item loss resolution and purchase-lot allocation are outside this phase. Do not confirm complete delivery when quantities are missing. Dedicated transit locations remain as auditable empty locations after delivery.

Cancellation is allowed only before dispatch and does not change inventory. Intermediate status changes do not move stock. Physical exceptions after dispatch require explicit inventory operations.

## Integrity and audit

Shipment row locks serialize dispatch, delivery, cancellation and edits. Each leg uses the existing inventory transfer service in the same PostgreSQL transaction. Item locks are taken in deterministic order. Transit storage is created through the existing location service, with its hierarchy lock acquired before shipment/item locks. All lines, status changes and newly created transit storage commit together or roll back.

Each ShipmentItem links its dispatch and delivery movements. Operation keys are `shipment-item:<id>:ship` and `shipment-item:<id>:deliver`. Repeated or simultaneous requests from different internal operators do not move inventory again. Retries with conflicting dates or final destination are rejected. Database triggers validate movement type, reference, merchandise, quantity and route, and protect dispatched contents against destructive edits. Detail pages show both legs, actors, timestamps, movement IDs and inventory-history links.

Draft creation also has a stable UUID and request fingerprint. Edits reject stale versions. Route and contents lock after dispatch or cancellation; tracking, packages and costs remain editable, including customs invoices received after delivery. Purchase records and watch settings are unchanged, and total owned stock is preserved.

## Costs and tracking

Tracking is recorded manually without carrier scraping. Weight supports G, KG and LB with up to three decimal places. Monetary values reuse integer minor units and shared money helpers. Shipping, insurance and other shipping fees share a currency; customs duty, import VAT, carrier customs fee and other import fees have a separate currency. Blank means unknown; explicit zero means known to be zero. No automatic currency conversion, landed-cost allocation or acquisition-cost overwrite occurs.

## Deployment and verification

Apply additive migration `20260908140000_international_shipments` with `npm run db:deploy`, then `npm run db:generate` on other environments. Existing inventory and purchase records are untouched.

`tests/shipments.integration.test.ts` covers drafts, stock validation, dispatch/delivery, geography, nested placement, preserved totals, cancellation, duplicate and concurrent actions, consignment isolation, shortages, rollback, customs updates, immutable contents, missing costs, dates, inactive locations and internal authorization using disposable PostgreSQL schemas.
