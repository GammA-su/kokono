"use client";
import { useActionState } from "react";
import { changeOrder } from "@/app/admin/orders/actions";
export function OrderActions({
  id,
  status,
  paymentStatus,
}: {
  id: string;
  status: string;
  paymentStatus: string;
}) {
  const [state, action, pending] = useActionState(changeOrder, {});
  const options = [];
  if (status === "PAID" && paymentStatus === "PAID")
    options.push(["PREPARING", "Start preparation"]);
  if (["PAID", "PREPARING"].includes(status) && paymentStatus === "PAID")
    options.push(["SHIPPED", "Dispatch all items"]);
  if (status === "SHIPPED" && paymentStatus === "PAID")
    options.push(["DELIVERED", "Mark delivered"]);
  if (["PENDING", "PAID", "PREPARING"].includes(status))
    options.push(["CANCELLED", "Cancel and release allocations"]);
  if (["PAID", "REVIEW", "REFUND_PENDING"].includes(paymentStatus))
    options.push(["REFUND", "Request full Stripe test refund"]);
  if (!options.length)
    return <p className="muted">No further order action is available.</p>;
  return (
    <form action={action} className="panel form-section">
      <h2>Order operations</h2>
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
      <input type="hidden" name="id" value={id} />
      <div className="field-grid">
        <label className="field">
          <span>Operation</span>
          <select name="action">
            {options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Actual carrier (required for dispatch)</span>
          <input name="carrier" maxLength={100} />
        </label>
        <label className="field">
          <span>Tracking reference (required for dispatch)</span>
          <input name="trackingNumber" maxLength={200} />
        </label>
      </div>
      <p>
        Dispatch consumes every reserved item and records SALE movements.
        Partial dispatch and partial refunds are unsupported. Cancellation of a
        paid order releases stock but requires the separate refund action.
        Refunds never restock dispatched merchandise.
      </p>
      <label className="checkbox-label">
        <input type="checkbox" name="confirm" required /> I confirm this
        full-order action.
      </label>
      <div className="form-actions">
        <button className="button primary" disabled={pending}>
          {pending ? "Processing…" : "Apply operation"}
        </button>
      </div>
    </form>
  );
}
