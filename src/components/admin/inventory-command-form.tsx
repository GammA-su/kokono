"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MovementType } from "@/generated/prisma/enums";
import { recordInventory } from "@/app/admin/inventory/actions";

type Props = {
  itemId: string;
  operationKey: string;
  initialType: MovementType;
  locations: {
    id: string;
    path: string;
    effectiveActive: boolean;
    quantity: number;
  }[];
};
export function InventoryCommandForm(props: Props) {
  const [key, setKey] = useState(props.operationKey);
  return (
    <CommandForm
      key={key}
      {...props}
      operationKey={key}
      onNew={() => setKey(crypto.randomUUID())}
    />
  );
}
function CommandForm({
  itemId,
  operationKey,
  initialType,
  locations,
  onNew,
}: Props & { onNew: () => void }) {
  const router = useRouter();
  const [state, dispatch, pending] = useActionState(recordInventory, {});
  useEffect(() => {
    if (state.success) router.refresh();
  }, [state.success, router]);
  const [type, setType] = useState<MovementType>(initialType);
  const [direction, setDirection] = useState("out");
  const [quantity, setQuantity] = useState("1");
  const transfer = type === "TRANSFER",
    adjustment = type === "ADJUSTMENT";
  const directional = ["GIFT", "GACHA", "RETURN", "OTHER"].includes(type);
  const incoming =
    type === "PURCHASE" ||
    (directional && direction === "in") ||
    (adjustment && Number(quantity) > 0);
  const options = (destination: boolean) => (
    <>
      <option value="">Select location</option>
      {locations
        .filter((row) => !destination || row.effectiveActive)
        .map((row) => (
          <option key={row.id} value={row.id}>
            {row.path} — {row.quantity} units
            {!row.effectiveActive ? " (inactive)" : ""}
          </option>
        ))}
    </>
  );
  return (
    <form
      className="panel form-section"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => dispatch(data));
      }}
    >
      {state.error && (
        <p className="alert error" role="alert">
          {state.error}
        </p>
      )}
      {state.success && (
        <div className="alert" role="status">
          <p>{state.success}</p>
          <Link
            className="source-link"
            href={`/admin/merchandise/catalog/${itemId}/movements`}
          >
            View movement history
          </Link>
          <p className="muted">Movement: {state.movementId}</p>
          <button className="button" type="button" onClick={onNew}>
            Start new operation
          </button>
        </div>
      )}
      <fieldset className="form-fieldset" disabled={pending || !!state.success}>
        <input type="hidden" name="merchandiseItemId" value={itemId} />
        <input type="hidden" name="operationKey" value={operationKey} />
        <div className="form-grid">
          <label className="field">
            <span>Movement</span>
            <select
              aria-label="Movement"
              name="movementType"
              value={type}
              onChange={(e) => {
                setType(e.target.value as MovementType);
                setQuantity("1");
              }}
            >
              {Object.values(MovementType).map((value) => (
                <option value={value} key={value}>
                  {value === "PURCHASE"
                    ? "PURCHASE — Receive stock"
                    : value.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>
              {adjustment
                ? "Signed adjustment (+ adds, − removes)"
                : "Quantity"}
            </span>
            <input
              name="quantity"
              type="number"
              step="1"
              min={adjustment ? -2147483647 : 1}
              max={2147483647}
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
          {directional && (
            <label className="field">
              <span>Direction</span>
              <select
                aria-label="Direction"
                name="direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              >
                <option value="out">Remove owned stock</option>
                <option value="in">Receive owned stock</option>
              </select>
              <small>
                RETURN, GIFT and GACHA can represent incoming acquisitions or
                outgoing units. Choose explicitly.
              </small>
            </label>
          )}
          {transfer ? (
            <>
              <label className="field">
                <span>Source location</span>
                <select
                  aria-label="Source location"
                  name="sourceLocationId"
                  required
                >
                  {options(false)}
                </select>
              </label>
              <label className="field">
                <span>Destination location</span>
                <select
                  aria-label="Destination location"
                  name="destinationLocationId"
                  required
                >
                  {options(true)}
                </select>
              </label>
            </>
          ) : (
            <label className="field">
              <span>
                {incoming ? "Destination location" : "Affected source location"}
              </span>
              <select
                aria-label={
                  incoming ? "Destination location" : "Affected source location"
                }
                key={incoming ? "destination" : "source"}
                name="locationId"
                required
              >
                {options(incoming)}
              </select>
            </label>
          )}
          {incoming && !transfer && (
            <>
              <label className="field">
                <span>Purchase unit cost (optional)</span>
                <input
                  name="unitCost"
                  inputMode="decimal"
                  placeholder="e.g. 1650 JPY or 12.50 EUR"
                />
                <small>
                  Decimal amount in the selected currency, per unit.
                </small>
              </label>
              <label className="field">
                <span>Purchase currency (optional)</span>
                <input
                  name="currency"
                  minLength={3}
                  maxLength={3}
                  placeholder="JPY / EUR"
                  pattern="[A-Za-z]{3}"
                />
                <small>Leave both cost and currency empty if unknown.</small>
              </label>
            </>
          )}
          <label className="field">
            <span>Purchase / source reference (optional)</span>
            <input
              name="reference"
              maxLength={200}
              placeholder="Order, receipt or shipment reference"
            />
          </label>
          {adjustment && (
            <label className="field">
              <span>Reason (required)</span>
              <input
                name="reason"
                required
                maxLength={2000}
                placeholder="Physical count correction"
              />
            </label>
          )}
          <label className="field full">
            <span>Note{adjustment ? " (required)" : " (optional)"}</span>
            <textarea
              name="note"
              required={adjustment}
              rows={3}
              maxLength={17_000}
              placeholder={
                adjustment
                  ? "Explain what was checked and why the correction is needed."
                  : "Additional movement information"
              }
            />
          </label>
        </div>
        <p className="table-note">
          {transfer
            ? "Transfers preserve total ownership. Source stock is checked inside the transaction."
            : "Every change creates an immutable movement attributed to your account."}{" "}
          Inactive locations can be emptied but cannot receive stock.
        </p>
        <details>
          <summary>Operation key</summary>
          <p className="code-cell">{operationKey}</p>
          <p className="muted">
            Retries of this form reuse this key. A successful operation cannot
            change stock twice.
          </p>
        </details>
        <div className="form-actions">
          <Link
            className="button"
            href={`/admin/merchandise/catalog/${itemId}`}
          >
            Back to item
          </Link>
          <button className="button primary" type="submit">
            {pending ? "Recording…" : "Record movement"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
