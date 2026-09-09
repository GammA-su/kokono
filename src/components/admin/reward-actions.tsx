"use client";
import { useActionState } from "react";
import { changeReward } from "@/app/admin/gacha/rewards/actions";
function Action({
  id,
  action,
  label,
}: {
  id: string;
  action: string;
  label: string;
}) {
  const [state, submit, pending] = useActionState(changeReward, {});
  return (
    <form action={submit} className="form-section">
      <h3>{label}</h3>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value={action} />
      {action === "SHIPPED" && (
        <div className="field-grid">
          <label className="field">
            <span>Actual carrier</span>
            <input name="carrier" required maxLength={100} />
          </label>
          <label className="field">
            <span>Tracking number</span>
            <input name="trackingNumber" required maxLength={200} />
          </label>
        </div>
      )}
      <label className="field">
        <span>Reason / dispatch note</span>
        <input name="reason" required maxLength={2000} />
      </label>
      <label className="checkbox-label">
        <input name="confirm" type="checkbox" required />
        {action === "SHIPPED"
          ? "The physical prize is dispatched to the recorded address."
          : action === "CANCELLED"
            ? "Cancel this award and release its reserved unit. It will not reroll."
            : "I confirm this operation."}
      </label>
      <button className="button" disabled={pending}>
        {pending ? "Saving…" : label}
      </button>
    </form>
  );
}
export function RewardActions({ id, status }: { id: string; status: string }) {
  return (
    <>
      {status === "CLAIMED" && (
        <Action id={id} action="PREPARING" label="Prepare for packing" />
      )}
      {status === "PREPARING" && (
        <Action id={id} action="SHIPPED" label="Record dispatch" />
      )}
      {status === "SHIPPED" && (
        <Action id={id} action="DELIVERED" label="Mark delivered" />
      )}
      {["AWARDED", "CLAIMED", "PREPARING"].includes(status) && (
        <details>
          <summary>Cancel reward</summary>
          <Action id={id} action="CANCELLED" label="Cancel reward" />
        </details>
      )}
    </>
  );
}
