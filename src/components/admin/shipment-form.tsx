"use client";
import { useState, useTransition } from "react";
import { ActionForm, Field } from "./action-form";
import {
  saveShipment,
  searchShipmentStock,
} from "@/app/admin/shipments/actions";
import {
  shippingAmounts,
  importAmounts,
  costLabels,
} from "@/modules/shipments/validation";
export type ShipmentFormValues = {
  id: string;
  version?: string;
  locked?: boolean;
  originLocationId: string;
  destinationLocationId: string;
  transitParentId: string;
  fields: Record<string, string>;
  items: { merchandiseItemId: string; name: string; quantity: string }[];
};
export type ShipmentLocation = {
  id: string;
  path: string;
  effectiveActive: boolean;
  effectiveCountry: string | null;
  inTransit: boolean;
};
export function ShipmentForm({
  initial,
  locations,
}: {
  initial: ShipmentFormValues;
  locations: ShipmentLocation[];
}) {
  const [origin, setOrigin] = useState(initial.originLocationId),
    [rows, setRows] = useState(initial.items),
    [query, setQuery] = useState("");
  const [result, setResult] =
      useState<Awaited<ReturnType<typeof searchShipmentStock>>>(),
    [error, setError] = useState("");
  const [pending, start] = useTransition();
  function search(page = 1) {
    start(async () => {
      try {
        setError("");
        setResult(await searchShipmentStock(origin, query, page));
      } catch {
        setError("Choose an origin and try searching again.");
      }
    });
  }
  const field = (
    name: string,
    label: string,
    options: { type?: string; required?: boolean; placeholder?: string } = {},
  ) => (
    <Field key={name} name={name} label={label}>
      <input
        aria-label={label}
        name={name}
        defaultValue={initial.fields[name] || ""}
        maxLength={500}
        {...options}
      />
    </Field>
  );
  return (
    <>
      {!initial.locked && (
        <section className="panel form-section form-stack">
          <h2>Select stock in Japan</h2>
          <label className="field">
            <span>Origin storage location</span>
            <select
              aria-label="Origin storage location"
              value={origin}
              onChange={(event) => {
                setOrigin(event.target.value);
                setRows([]);
                setResult(undefined);
              }}
            >
              <option value="">Choose Japan location</option>
              {locations
                .filter(
                  (row) =>
                    row.effectiveActive &&
                    row.effectiveCountry === "JP" &&
                    !row.inTransit,
                )
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.path}
                  </option>
                ))}
            </select>
            <small>
              Only stock held directly at this location is selected. Changing
              origin clears selected items.
            </small>
          </label>
          <div className="form-actions">
            <input
              aria-label="Search origin inventory"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  search();
                }
              }}
              maxLength={200}
              placeholder="Name, Japanese name, SKU or JAN"
            />
            <button
              type="button"
              className="button"
              disabled={!origin || pending}
              onClick={() => search()}
            >
              {pending ? "Searching…" : "Search inventory"}
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
          {result && result.origin === origin && (
            <>
              <p>
                {result.total} stocked items · Page {result.page} of{" "}
                {result.pageCount}
              </p>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Merchandise</th>
                      <th>Available here</th>
                      <th>Select</th>
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
                          <small>{item.internalSku}</small>
                        </td>
                        <td>{item.available}</td>
                        <td>
                          <button
                            type="button"
                            className="button small"
                            disabled={
                              rows.length >= 200 ||
                              rows.some(
                                (row) => row.merchandiseItemId === item.id,
                              )
                            }
                            onClick={() =>
                              setRows((current) => [
                                ...current,
                                {
                                  merchandiseItemId: item.id,
                                  name: item.name,
                                  quantity: "1",
                                },
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
                  className="button small"
                  type="button"
                  disabled={pending || result.page <= 1}
                  onClick={() => search(result.page - 1)}
                >
                  Previous
                </button>
                <button
                  className="button small"
                  type="button"
                  disabled={pending || result.page >= result.pageCount}
                  onClick={() => search(result.page + 1)}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </section>
      )}
      <ActionForm
        action={saveShipment}
        submitLabel={
          initial.version ? "Save shipment" : "Create draft shipment"
        }
        cancelHref={
          initial.version
            ? `/admin/shipments/${initial.id}`
            : "/admin/shipments"
        }
        className="panel form-section form-stack"
      >
        <input type="hidden" name="id" value={initial.id} />
        <input type="hidden" name="version" value={initial.version || ""} />
        <input type="hidden" name="originLocationId" value={origin} />
        <input type="hidden" name="items" value={JSON.stringify(rows)} />
        <div className="field-grid">
          {(
            [
              ["transitParentId", "Transit group"],
              ["destinationLocationId", "Planned France destination"],
            ] as const
          ).map(([name, label]) => (
            <Field key={name} name={name} label={label}>
              {initial.locked ? (
                <>
                  <input name={name} type="hidden" value={initial[name]} />
                  <span>
                    {locations.find((row) => row.id === initial[name])?.path}
                  </span>
                </>
              ) : (
                <select
                  aria-label={label}
                  name={name}
                  required
                  defaultValue={initial[name]}
                >
                  <option value="">Choose location</option>
                  {locations
                    .filter(
                      (row) =>
                        row.effectiveActive &&
                        (name === "transitParentId"
                          ? row.inTransit
                          : row.effectiveCountry === "FR" && !row.inTransit),
                    )
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.path}
                      </option>
                    ))}
                </select>
              )}
            </Field>
          ))}
        </div>
        <h2>Contents ({rows.length})</h2>
        <p className="muted">
          Drafts do not reserve or move inventory. Availability is checked again
          when shipping. Each shipment is dispatched and delivered in full.
        </p>
        {!rows.length && (
          <p className="alert">Select at least one stocked item above.</p>
        )}
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Merchandise</th>
                <th>Quantity</th>
                {!initial.locked && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.merchandiseItemId}>
                  <td>{row.name}</td>
                  <td>
                    {initial.locked ? (
                      row.quantity
                    ) : (
                      <input
                        aria-label={`Quantity line ${index + 1}`}
                        type="number"
                        min={1}
                        max={2147483647}
                        required
                        value={row.quantity}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((item) =>
                              item.merchandiseItemId === row.merchandiseItemId
                                ? { ...item, quantity: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    )}
                  </td>
                  {!initial.locked && (
                    <td>
                      <button
                        type="button"
                        className="button small"
                        onClick={() =>
                          setRows((current) =>
                            current.filter(
                              (item) =>
                                item.merchandiseItemId !==
                                row.merchandiseItemId,
                            ),
                          )
                        }
                      >
                        Remove {row.name}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h2>Carrier and packages</h2>
        <div className="field-grid">
          {field("carrier", "Carrier")}
          {field("carrierService", "Carrier service")}
          {field("trackingNumber", "Tracking number")}
          <Field name="packageCount" label="Package count">
            <input
              aria-label="Package count"
              name="packageCount"
              type="number"
              min={1}
              max={10000}
              required
              defaultValue={initial.fields.packageCount || "1"}
            />
          </Field>
          {field("totalWeight", "Total weight", {
            placeholder: "Optional, up to 3 decimal places",
          })}
          <Field name="weightUnit" label="Weight unit">
            <select
              aria-label="Weight unit"
              name="weightUnit"
              defaultValue={initial.fields.weightUnit || "KG"}
            >
              <option value="G">g</option>
              <option value="KG">kg</option>
              <option value="LB">lb</option>
            </select>
          </Field>
        </div>
        {(
          [
            [shippingAmounts, "shippingCurrency", "Shipping charges"],
            [importAmounts, "importCurrency", "Customs and import charges"],
          ] as const
        ).map(([amounts, currency, title]) => (
          <section key={currency}>
            <h2>{title}</h2>
            <p className="muted">
              Blank means not recorded. Enter 0 only when the cost is known to
              be zero. Amounts use the currency below.
            </p>
            <div className="field-grid">
              <Field name={currency} label={`${title} currency`}>
                <input
                  aria-label={`${title} currency`}
                  name={currency}
                  maxLength={3}
                  pattern="[A-Za-z]{3}"
                  defaultValue={initial.fields[currency] || ""}
                  placeholder={currency === "shippingCurrency" ? "JPY" : "EUR"}
                />
              </Field>
              {amounts.map((name) => field(name, costLabels[name]))}
            </div>
          </section>
        ))}
        <Field name="notes" label="Shipment notes" full>
          <textarea
            name="notes"
            maxLength={20000}
            defaultValue={initial.fields.notes || ""}
          />
        </Field>
        <p className="muted">
          Shipping and import charges remain shipment-level costs. They are not
          automatically allocated to merchandise unit costs. Tracking is
          recorded manually.
        </p>
      </ActionForm>
    </>
  );
}
