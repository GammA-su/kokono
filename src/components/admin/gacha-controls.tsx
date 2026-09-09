"use client";
import { useActionState, useState } from "react";
import { gachaOperation, simulateGacha } from "@/app/admin/gacha/actions";
import type { simulate } from "@/modules/gacha/odds";
export function GachaAction({
  bannerId,
  configurationId,
  action,
  label,
  pullId,
  operationKey,
}: {
  bannerId: string;
  configurationId: string;
  action: string;
  label: string;
  pullId?: string;
  operationKey?: string;
}) {
  const [state, submit, pending] = useActionState(gachaOperation, {});
  return (
    <form action={submit} className="form-section">
      <h3>{label}</h3>
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
      <input type="hidden" name="bannerId" value={bannerId} />
      <input type="hidden" name="configurationId" value={configurationId} />
      <input type="hidden" name="action" value={action} />
      {pullId && <input type="hidden" name="pullId" value={pullId} />}
      <input type="hidden" name="operationKey" value={operationKey ?? ""} />
      {action === "GRANT" && (
        <label className="field">
          <span>Customer reference (separate from the operator)</span>
          <input name="customerReference" required maxLength={200} />
        </label>
      )}
      {action === "CUSTOMER_AUTHORIZE" && (
        <>
          <label className="field">
            <span>Customer account ID (from Customers)</span>
            <input name="customerId" required />
          </label>
          <label className="field">
            <span>Number of no-charge pulls</span>
            <input
              name="maxPulls"
              type="number"
              min={1}
              max={100}
              defaultValue={1}
              required
            />
          </label>
          <label className="field">
            <span>Expires at (UTC, within 30 days)</span>
            <input name="expiresAt" type="datetime-local" required />
          </label>
        </>
      )}
      <label className="field">
        <span>
          {action === "CONSUME"
            ? "Physical handover / dispatch reference and note"
            : "Reason / reference"}
        </span>
        <input name="reason" required maxLength={2000} />
      </label>
      <label className="checkbox-label">
        <input name="confirm" type="checkbox" required />{" "}
        {action === "CONSUME"
          ? "I confirm the physical unit has left storage."
          : action === "GRANT"
            ? "Grant one no-charge draw using these exact odds."
            : "I confirm this operation."}
      </label>
      <div className="form-actions">
        <button className="button" disabled={pending}>
          {pending ? "Processing…" : label}
        </button>
      </div>
    </form>
  );
}
export function GachaSimulator({
  configurationId,
  names,
}: {
  configurationId: string;
  names: Record<string, string>;
}) {
  const [result, setResult] = useState<ReturnType<typeof simulate> | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="panel form-section">
      <h2>Simulation</h2>
      <p>
        Independent draws with replacement. Real pool depletion is not
        simulated. Inventory and real pull records remain unchanged.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const count = Number(new FormData(event.currentTarget).get("count"));
          setBusy(true);
          setError("");
          try {
            setResult(await simulateGacha(configurationId, count));
          } catch {
            setError("Simulation failed. Check your session and the count.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>Number of simulated draws</span>
          <input
            type="number"
            name="count"
            min={1}
            max={100000}
            defaultValue={100000}
            required
          />
        </label>
        <button className="button" disabled={busy}>
          {busy ? "Simulating…" : "Run simulation"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Prize</th>
                <th>Configured probability</th>
                <th>Observed count</th>
                <th>Observed percentage</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((row) => (
                <tr key={row.prizeId}>
                  <td>{names[row.prizeId]}</td>
                  <td>
                    {row.configured.numerator}/{row.configured.denominator} (
                    {row.configured.percentage}%
                    {!row.configured.percentageExact ? " rounded" : ""})
                  </td>
                  <td>
                    {row.observed} / {result.count}
                  </td>
                  <td>
                    {row.observedProbability.percentage}%
                    {!row.observedProbability.percentageExact
                      ? " (rounded)"
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
