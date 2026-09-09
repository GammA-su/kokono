"use client";
import { useState, useTransition } from "react";
import { ActionForm } from "./action-form";
import { LandedCostReview } from "./landed-cost-review";
import {
  allocationMethods,
  shipmentComponents,
  componentLabels,
  type CostPreview,
} from "@/modules/landed-costs/validation";
import {
  reviewLandedCosts,
  finalizeLandedCosts,
} from "@/app/admin/shipments/[id]/costs/actions";
import { parseMoneyInput, moneyInputValue } from "@/modules/shared/money";
type Batch = {
  id: string;
  merchandiseItemId: string;
  quantity: number;
  position: number;
  purchase: {
    supplier: string;
    externalReference: string | null;
    currency: string;
  };
};
type Row = {
  key: string;
  shipmentItemId: string;
  purchaseItemId: string;
  quantity: string;
  firstUnit: string;
  weight: string;
  manual: Record<string, string>;
};
export function LandedCostEditor({
  id,
  shipmentId,
  items,
  batches,
  currency,
  sourceCurrencies,
  previous,
  usedRanges,
}: {
  id: string;
  shipmentId: string;
  items: {
    id: string;
    merchandiseItemId: string;
    quantity: number;
    merchandiseItem: { name: string };
  }[];
  batches: Batch[];
  currency: string;
  sourceCurrencies: string[];
  previous?: CostPreview | null;
  usedRanges: {
    purchaseItemId: string;
    unitOffset: number;
    quantity: number;
  }[];
}) {
  const [rows, setRows] = useState<Row[]>(
    previous
      ? previous.input.rows.map((row, index) => ({
          key: `batch-${index}`,
          shipmentItemId: row.shipmentItemId,
          purchaseItemId: row.purchaseItemId,
          quantity: String(row.quantity),
          firstUnit: String(row.unitOffset + 1),
          weight: row.unitWeightGrams || "",
          manual:
            previous.currency === currency
              ? Object.fromEntries(
                  Object.entries(row.manual).map(([key, value]) => [
                    key,
                    moneyInputValue(BigInt(value), currency),
                  ]),
                )
              : {},
        }))
      : items.map((item) => ({
          key: item.id,
          shipmentItemId: item.id,
          purchaseItemId: "",
          quantity: String(item.quantity),
          firstUnit: "1",
          weight: "",
          manual: {},
        })),
  );
  const [method, setMethod] = useState<(typeof allocationMethods)[number]>(
      previous?.input.method || "BY_QUANTITY",
    ),
    [rates, setRates] = useState<Record<string, string>>(
      previous?.currency === currency ? previous.input.rates : {},
    ),
    [reference, setReference] = useState(
      previous?.currency === currency ? previous.input.rateReference : "",
    );
  const [review, setReview] = useState<CostPreview>(),
    [error, setError] = useState(""),
    [pending, start] = useTransition();
  const clear = () => {
    setReview(undefined);
    setError("");
  };
  const update = (key: string, patch: Partial<Row>) => {
    clear();
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };
  return (
    <>
      <form
        className="panel form-section form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          start(async () => {
            clear();
            try {
              const result = await reviewLandedCosts({
                id,
                shipmentId,
                method,
                rates: Object.fromEntries(
                  Object.entries(rates).filter(([, value]) => value.trim()),
                ),
                rateReference: reference,
                rows: rows.map((row) => ({
                  shipmentItemId: row.shipmentItemId,
                  purchaseItemId: row.purchaseItemId,
                  quantity: Number(row.quantity),
                  unitOffset: Number(row.firstUnit) - 1,
                  unitWeightGrams: row.weight || null,
                  manual:
                    method === "MANUAL"
                      ? Object.fromEntries(
                          shipmentComponents.map((key) => [
                            key,
                            String(
                              parseMoneyInput(row.manual[key] || "0", currency),
                            ),
                          ]),
                        )
                      : {},
                })),
              });
              setReview(result.review);
              setError(result.error || "");
            } catch (error) {
              setError(
                error instanceof Error ? error.message : "Review failed.",
              );
            }
          });
        }}
      >
        <fieldset disabled={pending} className="form-fieldset form-stack">
          <h2>Allocation inputs</h2>
          <label className="field">
            <span>Allocation method</span>
            <select
              aria-label="Allocation method"
              value={method}
              onChange={(event) => {
                clear();
                setMethod(event.target.value as typeof method);
              }}
            >
              {allocationMethods.map((method) => (
                <option key={method}>{method}</option>
              ))}
            </select>
          </label>
          <p className="muted">
            Select the actual received purchase batches. Unit numbers identify
            costing assignments within each purchase line, not physical serial
            numbers. Split rows for mixed acquisitions; quantities must match
            the shipment. Units assigned to other shipments cannot be reused.
          </p>
          {rows.map((row, index) => {
            const item = items.find((item) => item.id === row.shipmentItemId)!;
            return (
              <section className="panel form-section form-stack" key={row.key}>
                <h3>
                  {item.merchandiseItem.name} · batch {index + 1}
                </h3>
                {row.purchaseItemId && (
                  <p className="muted">
                    Units already assigned to other shipments:{" "}
                    {usedRanges
                      .filter(
                        (range) => range.purchaseItemId === row.purchaseItemId,
                      )
                      .map(
                        (range) =>
                          `${range.unitOffset + 1}–${range.unitOffset + range.quantity}`,
                      )
                      .join(", ") || "none"}
                    . Choose a disjoint unit range.
                  </p>
                )}
                <div className="field-grid">
                  <label className="field">
                    <span>Purchase batch</span>
                    <select
                      aria-label={`Purchase batch ${index + 1}`}
                      required
                      value={row.purchaseItemId}
                      onChange={(event) =>
                        update(row.key, { purchaseItemId: event.target.value })
                      }
                    >
                      <option value="">Select received purchase line</option>
                      {batches
                        .filter(
                          (batch) =>
                            batch.merchandiseItemId === item.merchandiseItemId,
                        )
                        .map((batch) => (
                          <option key={batch.id} value={batch.id}>
                            {batch.purchase.supplier} ·{" "}
                            {batch.purchase.externalReference ||
                              batch.id.slice(0, 8)}{" "}
                            · line {batch.position + 1} · {batch.quantity} units
                            · {batch.purchase.currency}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Quantity</span>
                    <input
                      aria-label={`Batch quantity ${index + 1}`}
                      type="number"
                      min={1}
                      required
                      value={row.quantity}
                      onChange={(event) =>
                        update(row.key, { quantity: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>First purchase unit (1-based)</span>
                    <input
                      aria-label={`First purchase unit ${index + 1}`}
                      type="number"
                      min={1}
                      required
                      value={row.firstUnit}
                      onChange={(event) =>
                        update(row.key, { firstUnit: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Known unit weight (grams)</span>
                    <input
                      aria-label={`Unit weight ${index + 1}`}
                      inputMode="decimal"
                      required={method === "BY_WEIGHT"}
                      value={row.weight}
                      onChange={(event) =>
                        update(row.key, { weight: event.target.value })
                      }
                    />
                    <small>
                      Do not use parcel weight or an invented average.
                    </small>
                  </label>
                </div>
                {method === "MANUAL" && (
                  <div className="field-grid">
                    {shipmentComponents.map((key) => (
                      <label key={key} className="field">
                        <span>
                          {componentLabels[key]} ({currency}, batch total)
                        </span>
                        <input
                          aria-label={`${componentLabels[key]} batch ${index + 1}`}
                          inputMode="decimal"
                          value={row.manual[key] || ""}
                          placeholder="0"
                          onChange={(event) =>
                            update(row.key, {
                              manual: {
                                ...row.manual,
                                [key]: event.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                )}
                <div className="form-actions">
                  <button
                    className="button small"
                    type="button"
                    onClick={() => {
                      clear();
                      setRows((current) => [
                        ...current,
                        {
                          key: crypto.randomUUID(),
                          shipmentItemId: row.shipmentItemId,
                          purchaseItemId: "",
                          quantity: "1",
                          firstUnit: "1",
                          weight: "",
                          manual: {},
                        },
                      ]);
                    }}
                  >
                    Add another batch for this item
                  </button>
                  {rows.filter((other) => other.shipmentItemId === item.id)
                    .length > 1 && (
                    <button
                      className="button small"
                      type="button"
                      onClick={() => {
                        clear();
                        setRows((current) =>
                          current.filter((other) => other.key !== row.key),
                        );
                      }}
                    >
                      Remove batch
                    </button>
                  )}
                </div>
              </section>
            );
          })}
          <h3>Explicit exchange rates</h3>
          <p className="muted">
            Target currency: {currency}. Enter the target major-unit amount per
            1 source major unit. Rates are never fetched or assumed. Only
            currencies actually used in this calculation require a rate.
          </p>
          <div className="field-grid">
            {[...new Set(sourceCurrencies)]
              .filter((source) => source !== currency)
              .map((source) => (
                <label className="field" key={source}>
                  <span>
                    1 {source} = … {currency}
                  </span>
                  <input
                    aria-label={`${source} to ${currency} rate`}
                    inputMode="decimal"
                    value={rates[source] || ""}
                    onChange={(event) => {
                      clear();
                      setRates((current) => ({
                        ...current,
                        [source]: event.target.value,
                      }));
                    }}
                  />
                </label>
              ))}
            <label className="field">
              <span>Rate / payment reference</span>
              <input
                aria-label="Rate / payment reference"
                required
                maxLength={2000}
                value={reference}
                onChange={(event) => {
                  clear();
                  setReference(event.target.value);
                }}
                placeholder="Payment conversion reference/date, or same currency"
              />
            </label>
          </div>
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" type="submit">
            {pending ? "Calculating…" : "Review allocation"}
          </button>
        </fieldset>
      </form>
      {review && (
        <>
          <LandedCostReview review={review} />
          {!review.blockers.length && (
            <ActionForm
              key={review.reviewHash}
              action={finalizeLandedCosts}
              submitLabel="Finalize landed costs"
              className="panel form-section"
            >
              <input
                type="hidden"
                name="input"
                value={JSON.stringify(review.input)}
              />
              <input type="hidden" name="hash" value={review.reviewHash} />
              <label>
                <input name="confirmed" type="checkbox" required /> I reviewed
                the batches, exchange rates, VAT policy and allocated costs.
              </label>
              <p className="muted">
                This creates an immutable version. Existing calculations remain
                in history. Editing any input above requires a new review.
              </p>
            </ActionForm>
          )}
        </>
      )}
    </>
  );
}
