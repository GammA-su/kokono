import {
  components,
  componentLabels,
  type CostPreview,
} from "@/modules/landed-costs/validation";
import { formatMoney } from "@/modules/shared/money";
import { roundRatio } from "@/modules/landed-costs/math";
export function LandedCostReview({ review }: { review: CostPreview }) {
  const money = (amount: string) =>
    formatMoney(BigInt(amount), review.currency);
  return (
    <section className="panel form-section form-stack">
      <h2>Cost review · version {review.revision}</h2>
      <p>
        {review.input.method} · {review.currency} · Import VAT{" "}
        {review.importVatAsCost
          ? "included in cost"
          : "excluded under configured policy"}
      </p>
      <p className="muted">Exchange basis: {review.input.rateReference}</p>
      {Object.entries(review.input.rates).map(([currency, rate]) => (
        <p key={currency}>
          1 {currency} = {rate} {review.currency}
        </p>
      ))}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Shipment charge</th>
              <th>Recorded amount</th>
              <th>Allocated amount ({review.currency})</th>
            </tr>
          </thead>
          <tbody>
            {review.shipmentCosts.map((row) => (
              <tr key={row.component}>
                <td>{componentLabels[row.component]}</td>
                <td>
                  {row.amount !== null && row.currency
                    ? formatMoney(BigInt(row.amount), row.currency)
                    : "Not recorded"}
                </td>
                <td>
                  {!row.included
                    ? "Excluded by policy"
                    : row.convertedAmount === null
                      ? "Unknown"
                      : money(row.convertedAmount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {review.blockers.length > 0 && (
        <div className="alert error" role="alert">
          <strong>Incomplete estimate — cannot finalize</strong>
          <ul>
            {review.blockers.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      <h3>Purchase batches and landed unit costs</h3>
      {review.lines.map((line, index) => (
        <details
          key={`${line.purchaseItemId}:${line.unitOffset}`}
          open={review.lines.length <= 3}
        >
          <summary>
            {line.name} × {line.quantity} · ≈{" "}
            {money(
              roundRatio(
                BigInt(line.totalAmount),
                BigInt(line.quantity),
              ).toString(),
            )}{" "}
            per unit
          </summary>
          <p>
            {line.purchaseLabel} · Units {line.unitOffset + 1}–
            {line.unitOffset + line.quantity}
            {line.unitWeightGrams
              ? ` · ${line.unitWeightGrams} g per unit`
              : ""}
          </p>
          <div className="table-scroll">
            <table
              className="data-table"
              aria-label={`Cost breakdown batch ${index + 1}`}
            >
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Batch total</th>
                  <th>Per unit (rounded)</th>
                </tr>
              </thead>
              <tbody>
                {components.map((key) => (
                  <tr key={key}>
                    <td>{componentLabels[key]}</td>
                    <td>{money(line.components[key])}</td>
                    <td>
                      ≈{" "}
                      {money(
                        roundRatio(
                          BigInt(line.components[key]),
                          BigInt(line.quantity),
                        ).toString(),
                      )}
                    </td>
                  </tr>
                ))}
                <tr>
                  <th>
                    Landed cost
                    {review.blockers.length ? " (known costs only)" : ""}
                  </th>
                  <td>
                    <strong>{money(line.totalAmount)}</strong>
                  </td>
                  <td>
                    <strong>
                      ≈{" "}
                      {money(
                        roundRatio(
                          BigInt(line.totalAmount),
                          BigInt(line.quantity),
                        ).toString(),
                      )}
                    </strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      ))}
      <p>
        <strong>
          {review.blockers.length ? "Known-cost subtotal" : "Total landed cost"}
          : {money(review.totalAmount)}
        </strong>
      </p>
      <p className="muted">
        Batch totals retain exact minor units. Displayed unit averages are
        rounded; multiply the exact batch total, not the rounded average, when
        reconciling. Purchase shipping, proxy fees and additional purchase taxes
        are allocated by quantity over the whole purchase. MSRP and selling
        prices are unchanged.
      </p>
    </section>
  );
}
