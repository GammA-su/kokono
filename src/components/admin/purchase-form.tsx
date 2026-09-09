"use client";
import { useState, useTransition } from "react";
import { ActionForm, Field } from "./action-form";
import {
  savePurchase,
  searchPurchaseItems,
} from "@/app/admin/purchases/actions";
import { purchaseStatusLabels } from "@/modules/purchases/validation";

type Choice = {
  id: string;
  name: string;
  japaneseName: string | null;
  internalSku: string;
};
type Row = {
  key: string;
  merchandiseItemId: string;
  name: string;
  quantity: string;
  unitPrice: string;
  condition: string;
  sellerListingUrl: string;
  notes: string;
};
export type PurchaseFormValues = {
  id: string;
  version?: string;
  supplier?: string;
  marketplace?: string;
  externalReference?: string;
  purchaseDate: string;
  currency: string;
  domesticShipping?: string;
  fees?: string;
  taxes?: string;
  status?: string;
  notes?: string;
  items: Row[];
};
export function newPurchaseRow(item: Choice): Row {
  return {
    key: crypto.randomUUID(),
    merchandiseItemId: item.id,
    name: `${item.name} · ${item.internalSku}`,
    quantity: "1",
    unitPrice: "",
    condition: "",
    sellerListingUrl: "",
    notes: "",
  };
}
export function PurchaseForm({ initial }: { initial: PurchaseFormValues }) {
  const [rows, setRows] = useState(initial.items),
    [currency, setCurrency] = useState(initial.currency);
  const [query, setQuery] = useState(""),
    [result, setResult] =
      useState<Awaited<ReturnType<typeof searchPurchaseItems>>>(),
    [error, setError] = useState("");
  const [pending, start] = useTransition();
  function search(page = 1) {
    start(async () => {
      try {
        setError("");
        setResult(await searchPurchaseItems(query, page));
      } catch {
        setError("Unable to search catalog. Please try again.");
      }
    });
  }
  function update(key: string, field: keyof Row, value: string) {
    setRows((current) =>
      current.map((row) =>
        row.key === key ? { ...row, [field]: value } : row,
      ),
    );
  }
  return (
    <>
      <section
        className="panel form-section form-stack"
        aria-label="Find merchandise"
      >
        <h2>Add catalog merchandise</h2>
        <div className="form-actions">
          <input
            aria-label="Search catalog"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                search();
              }
            }}
            placeholder="Name, Japanese name, SKU or JAN"
            maxLength={200}
          />
          <button
            className="button"
            type="button"
            disabled={pending}
            onClick={() => search()}
          >
            {pending ? "Searching…" : "Search catalog"}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {result && (
          <>
            <p className="muted">
              {result.total} matches · Page {result.page} of {result.pageCount}
            </p>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Merchandise</th>
                    <th>SKU</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.name}
                        <div className="muted" lang="ja">
                          {item.japaneseName}
                        </div>
                      </td>
                      <td>{item.internalSku}</td>
                      <td>
                        <button
                          type="button"
                          className="button small"
                          disabled={rows.length >= 200}
                          onClick={() =>
                            setRows((current) => [
                              ...current,
                              newPurchaseRow(item),
                            ])
                          }
                        >
                          Add {item.name}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="button small"
                disabled={pending || result.page <= 1}
                onClick={() => search(result.page - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                className="button small"
                disabled={pending || result.page >= result.pageCount}
                onClick={() => search(result.page + 1)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </section>
      <ActionForm
        action={savePurchase}
        submitLabel={initial.version ? "Save purchase" : "Create purchase"}
        cancelHref={
          initial.version
            ? `/admin/purchases/${initial.id}`
            : "/admin/purchases"
        }
        className="panel form-section form-stack"
      >
        <input type="hidden" name="id" value={initial.id} />
        <input type="hidden" name="version" value={initial.version || ""} />
        <input type="hidden" name="items" value={JSON.stringify(rows)} />
        <div className="field-grid">
          <Field name="supplier" label="Supplier / source">
            <input
              name="supplier"
              required
              maxLength={500}
              defaultValue={initial.supplier}
            />
          </Field>
          <Field name="marketplace" label="Marketplace">
            <input
              name="marketplace"
              maxLength={500}
              defaultValue={initial.marketplace}
              placeholder="Mercari, AmiAmi, direct supplier…"
            />
          </Field>
          <Field name="externalReference" label="External order / reference">
            <input
              name="externalReference"
              maxLength={500}
              defaultValue={initial.externalReference}
            />
          </Field>
          <Field name="purchaseDate" label="Purchase date">
            <input
              name="purchaseDate"
              type="date"
              required
              defaultValue={initial.purchaseDate}
            />
          </Field>
          <Field
            name="currency"
            label="Currency"
            hint="All prices and charges use this currency. Changing it does not convert amounts."
          >
            <input
              aria-label="Currency"
              name="currency"
              required
              pattern="[A-Z]{3}"
              maxLength={3}
              value={currency}
              onChange={(event) =>
                setCurrency(event.target.value.toUpperCase())
              }
            />
          </Field>
          <Field name="status" label="Status">
            <select
              aria-label="Status"
              name="status"
              defaultValue={initial.status || "DRAFT"}
            >
              {(["DRAFT", "ORDERED", "PAID", "OTHER"] as const).map(
                (status) => (
                  <option key={status} value={status}>
                    {purchaseStatusLabels[status]}
                  </option>
                ),
              )}
            </select>
          </Field>
        </div>
        <h2>Purchase items ({rows.length})</h2>
        <p className="muted">
          Each line is received in full once. For split deliveries, create
          separate lines before ordering. Recording an order does not add
          inventory.
        </p>
        {!rows.length && (
          <p className="alert">
            Search the catalog above and add at least one item.
          </p>
        )}
        {rows.map((row, index) => (
          <section key={row.key} className="panel form-section">
            <div className="page-heading">
              <h3>
                {index + 1}. {row.name}
              </h3>
              <button
                type="button"
                className="button small"
                onClick={() =>
                  setRows((current) =>
                    current.filter((item) => item.key !== row.key),
                  )
                }
              >
                Remove line {index + 1}
              </button>
            </div>
            <div className="field-grid">
              <Field name={`quantity${index}`} label="Quantity">
                <input
                  aria-label={`Quantity line ${index + 1}`}
                  type="number"
                  min={1}
                  max={1000000}
                  required
                  value={row.quantity}
                  onChange={(event) =>
                    update(row.key, "quantity", event.target.value)
                  }
                />
              </Field>
              <Field
                name={`price${index}`}
                label={`Unit purchase price (${currency})`}
              >
                <input
                  aria-label={`Unit price line ${index + 1}`}
                  inputMode="decimal"
                  required
                  value={row.unitPrice}
                  onChange={(event) =>
                    update(row.key, "unitPrice", event.target.value)
                  }
                />
              </Field>
              <Field name={`condition${index}`} label="Condition">
                <input
                  aria-label={`Condition line ${index + 1}`}
                  maxLength={500}
                  value={row.condition}
                  onChange={(event) =>
                    update(row.key, "condition", event.target.value)
                  }
                />
              </Field>
              <Field name={`url${index}`} label="Seller listing URL">
                <input
                  aria-label={`Seller URL line ${index + 1}`}
                  type="url"
                  maxLength={4000}
                  value={row.sellerListingUrl}
                  onChange={(event) =>
                    update(row.key, "sellerListingUrl", event.target.value)
                  }
                />
              </Field>
              <Field name={`notes${index}`} label="Line notes" full>
                <textarea
                  aria-label={`Notes line ${index + 1}`}
                  maxLength={20000}
                  value={row.notes}
                  onChange={(event) =>
                    update(row.key, "notes", event.target.value)
                  }
                />
              </Field>
            </div>
          </section>
        ))}
        <div className="field-grid">
          <Field
            name="domesticShipping"
            label={`Domestic shipping (${currency})`}
          >
            <input
              aria-label="Domestic shipping"
              name="domesticShipping"
              required
              inputMode="decimal"
              defaultValue={initial.domesticShipping || "0"}
            />
          </Field>
          <Field name="fees" label={`Fees (${currency})`}>
            <input
              aria-label="Fees"
              name="fees"
              required
              inputMode="decimal"
              defaultValue={initial.fees || "0"}
            />
          </Field>
          <Field
            name="taxes"
            label={`Additional taxes (${currency})`}
            hint="Only taxes not already included in line prices."
          >
            <input
              aria-label="Additional taxes"
              name="taxes"
              required
              inputMode="decimal"
              defaultValue={initial.taxes || "0"}
            />
          </Field>
          <Field name="notes" label="Purchase notes" full>
            <textarea
              name="notes"
              maxLength={20000}
              defaultValue={initial.notes}
            />
          </Field>
        </div>
        <p className="muted">
          Subtotal and total are calculated from the line quantities and prices.
          Shipping, fees and additional taxes are recorded separately and are
          not allocated to inventory unit costs.
        </p>
      </ActionForm>
    </>
  );
}
