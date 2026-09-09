# Reviewed landed costs

Open a dispatched shipment and choose **Landed costs**. Costing never changes MSRP, selling prices, purchase prices, balances or inventory movements.

## Accounting configuration and currencies

An internal administrator must explicitly save the costing currency and whether import VAT is included as cost. The application does not infer VAT deductibility. This policy applies to future reviews; every finalized calculation retains its original policy.

Enter the exchange rate used by the business and a payment/rate reference. Rates are target **major units per 1 source major unit**: for EUR costing, `JPY = 0.00697` converts JPY 1,000 to EUR 6.97. Rates are never fetched or assumed. Zero amounts and same-currency values need no conversion. Each currency's exponent is respected, including zero-decimal JPY. Cross-currency amounts are rounded half-up to target minor units; all subsequent allocations use BigInt arithmetic.

## Acquisition batches

Select the actual received PurchaseItem for every shipment item. Split a shipment item across several batch rows if necessary. Every row records quantity and a first unit number within that purchase line, plus optional known unit weight in grams. These are costing ranges, not physical serial numbers or an inventory-lot tracking system. Merchandise must match, all shipment quantities must be covered, and batch units must exist.

Previously assigned ranges from other shipments are displayed and cannot be reused. Assignments from the latest finalized version of each shipment are authoritative; new versions may revise this shipment's ranges while preserving all previous snapshots. Finalization locks purchase lines to prevent concurrent shipments from claiming the same units. This does not create stock reservations or change inventory.

Purchase price is converted at the full purchase-line total, then apportioned to selected units. Japan domestic shipping, marketplace/proxy fees and additional purchase taxes are converted at the full purchase level and allocated **by quantity across all purchase units**, including units not in this shipment. Remainder cents go to earlier purchase positions and unit numbers. This prevents charging the entire domestic fee again for each shipment or losing cents across split batches.

## Shipment allocation methods

- **BY_QUANTITY:** weight each batch by its shipped quantity.
- **BY_WEIGHT:** use quantity times its recorded unit weight. All weights must be known and positive; total parcel weight is never substituted for item weights.
- **BY_ITEM_VALUE:** use each batch's converted purchase-price total. Positive shipment costs require a positive value basis.
- **MANUAL:** enter the target-currency batch total for each included shipment cost component. Each component must reconcile exactly with its converted shipment total. Excluded VAT cannot be allocated manually.

International shipping, insurance, other shipping fees, customs duty, import VAT, carrier customs fee and other import fees remain separate components. Automatic methods use largest-remainder allocation in stable purchase-batch/range order, so the sum equals every recorded component exactly. Known weights are preserved even when a different method is used.

## Review and finalization

The review shows original shipment charges, converted allocations, purchase batches, component totals, landed batch totals and rounded unit averages. Batch totals are exact; displayed unit averages can contain a rounding difference and must not be multiplied back to reconcile the batch.

Unknown shipment costs are not zero. The review can show a partial known-cost subtotal, but finalization requires all included charges to be recorded. Enter an explicit zero only if the charge is known to be zero. VAT excluded by policy does not need to be included in the cost total. Finalization requires explicit confirmation, revalidates the review against current source records and policy, and rejects stale or overlapping assignments.

Finalized calculations are append-only. New costs create another numbered version; previous versions retain source records, names, original currencies/amounts, exchange-rate reference, method, policy, weights, batch ranges and allocations. Reopening the allocation screen pre-fills the previous version for review. Changed target currencies clear prior conversion inputs. Duplicate finalization requests do not create another version. Database triggers reject changes, deletion, truncation and later additions to a finalized calculation.

## Pricing integration

Catalog item pricing, publication review and bulk selling-price review show the **latest finalized shipment batch estimate** when available. For mixed acquisitions within that shipment, the estimate uses their quantity-weighted exact totals. This is explicitly a batch estimate, not FIFO, a perpetual inventory valuation, or a claim that all remaining units have that cost. Margin compares the proposed selling price only in the same currency, excludes selling/payment fees and customer delivery costs, and remains unknown if currencies differ. Zero-price listings avoid percentage division by zero.

Unknown landed cost never blocks publication. Public storefront selectors never include costing, rates or acquisition metadata.

## Deployment and verification

Migration `20260908160000_landed_costs` adds settings, immutable calculation versions and linked batch lines without backfilling or mutating existing records. Apply with `npm run db:deploy` and regenerate with `npm run db:generate` in other environments.

The landed-cost test suites cover all methods, rounding, FX exponents, large integers, component reconciliation, partial purchase ranges, duplicate and concurrent finalization, VAT settings, missing weights/costs, stale reviews, history, authorization, pricing and public-data isolation.
