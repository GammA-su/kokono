"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import {
  previewCatalogCsv,
  importCatalogCsv,
} from "@/modules/catalog-csv/actions";
import type { CsvPreview, CsvSummary } from "@/modules/catalog-csv/service";

type Decision = {
  row: number;
  decision: "skip" | "create" | "update";
  targetId?: string;
};
export function CsvImport({ lineupId }: { lineupId: string }) {
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [summary, setSummary] = useState<CsvSummary | null>(null);
  const [error, setError] = useState("");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [pending, start] = useTransition();
  const reset = () => {
    setPreview(null);
    setSummary(null);
    setError("");
    setDecisions([]);
  };
  return (
    <div className="form-stack" aria-busy={pending}>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {!preview && (
        <form
          className="panel form-section"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setError("");
            start(async () => {
              try {
                const result = await previewCatalogCsv(form);
                if (result.error) setError(result.error);
                else if (result.preview) {
                  setPreview(result.preview);
                  setDecisions(
                    result.preview.rows.map((row) => ({
                      row: row.row,
                      decision:
                        row.errors.length ||
                        row.createBlocked.length ||
                        row.candidates.length ||
                        row.warnings.length
                          ? "skip"
                          : "create",
                    })),
                  );
                }
              } catch {
                setError(
                  "The preview request failed. Your catalog was not changed; try again.",
                );
              }
            });
          }}
        >
          <fieldset disabled={pending} className="form-fieldset">
            <input type="hidden" name="lineupId" value={lineupId} />
            <h2 className="section-title">
              1. Upload and choose update policy
            </h2>
            <label className="field">
              <span>CSV file</span>
              <input name="file" type="file" accept=".csv,text/csv" required />
              <small>
                UTF-8, comma separated, up to 250 merchandise rows and 2 MiB.
                Stock columns are rejected.
              </small>
            </label>
            <p>
              New items use the represented catalog and sourcing data. Existing
              items receive only nonblank values from supported columns. Blank
              cells preserve existing values.
            </p>
            <div className="csv-policy">
              <label>
                <input type="checkbox" name="updateWatch" /> Allow represented
                PurchaseWatch fields to update existing watches
              </label>
              <label>
                <input type="checkbox" name="updatePrivateNotes" /> Allow
                private_notes to replace existing private notes
              </label>
            </div>
            <p className="table-note">
              Inventory, movement history, SaleListing, aliases and descriptions
              are never imported. Existing sources and images are preserved; new
              URLs/references are added without changing existing metadata or
              public image approval.
            </p>
            <div className="form-actions">
              <a className="button" href="/api/admin/catalog/csv?template=1">
                Download CSV template
              </a>
              <button type="submit" className="button primary">
                {pending ? "Preparing preview…" : "Parse and preview"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {preview && !summary && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setError("");
            start(async () => {
              try {
                const result = await importCatalogCsv({
                  token: preview.token,
                  decisions,
                  confirmed: form.get("confirmed") === "on",
                });
                if (result.error) setError(result.error);
                else if (result.summary) setSummary(result.summary);
              } catch {
                setError(
                  "The import response was interrupted. Retrying this review will not create the same rows twice; existing-item updates may require a fresh preview.",
                );
              }
            });
          }}
        >
          <fieldset className="form-fieldset" disabled={pending}>
            <div className="page-heading">
              <div>
                <h2>2. Review {preview.rows.length} merchandise rows</h2>
                <p className="muted">
                  Nothing has been imported yet. Resolve duplicates, review
                  field values, then confirm. This review expires after 30
                  minutes.
                </p>
              </div>
              <button type="button" className="button" onClick={reset}>
                Choose another file / policy
              </button>
            </div>
            <p className="alert">
              Update policy: blank cells preserve values; private notes{" "}
              {preview.policy.updatePrivateNotes
                ? "may be replaced"
                : "are protected"}
              ; existing watch fields{" "}
              {preview.policy.updateWatch ? "may be updated" : "are protected"}.
              Sources and images are additive. Missing categories/characters
              must be created before import.
            </p>
            <section className="panel">
              <div className="table-scroll">
                <table className="data-table read-table csv-preview">
                  <thead>
                    <tr>
                      <th>CSV record</th>
                      <th>Merchandise / values</th>
                      <th>Validation / possible duplicates</th>
                      <th>Decision</th>
                      <th>Update target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, index) => {
                      const choice = decisions[index];
                      const available = row.candidates.filter(
                        (candidate) => candidate.canUpdate,
                      );
                      return (
                        <tr key={row.row}>
                          <td>{row.row}</td>
                          <td>
                            <strong>{row.name}</strong>
                            <span className="japanese code-cell">
                              {row.values.internal_sku ||
                                "Generate SKU on creation"}
                            </span>
                            <details>
                              <summary>Review all CSV values</summary>
                              <dl className="csv-values">
                                {Object.entries(row.values).map(
                                  ([key, value]) => (
                                    <div key={key}>
                                      <dt>{key}</dt>
                                      <dd>
                                        {value || (
                                          <span className="muted">
                                            Blank — preserve on update
                                          </span>
                                        )}
                                      </dd>
                                    </div>
                                  ),
                                )}
                              </dl>
                            </details>
                          </td>
                          <td>
                            {row.errors.map((message, i) => (
                              <p className="field-error" key={`error-${i}`}>
                                {message}
                              </p>
                            ))}
                            {row.warnings.map((message, i) => (
                              <p key={`warning-${i}`}>{message}</p>
                            ))}
                            {row.candidates.map((candidate) => (
                              <p key={candidate.id}>
                                <Link
                                  className="source-link"
                                  href={`/admin/merchandise/catalog/${candidate.id}`}
                                  target="_blank"
                                >
                                  {candidate.name}
                                </Link>
                                <span className="japanese">
                                  {candidate.internalSku} ·{" "}
                                  {candidate.signals.join(", ")}
                                  {!candidate.canUpdate
                                    ? " · update unavailable (other lineup, archived, or conflicting SKU)"
                                    : ""}
                                </span>
                              </p>
                            ))}
                            {row.createBlocked.map((message, i) => (
                              <p className="field-error" key={`blocked-${i}`}>
                                {message}
                              </p>
                            ))}
                            {!row.errors.length &&
                              !row.candidates.length &&
                              !row.warnings.length && (
                                <span className="badge catalog-live">
                                  Validated
                                </span>
                              )}
                          </td>
                          <td>
                            <select
                              aria-label={`Decision for record ${row.row}`}
                              value={choice.decision}
                              onChange={(event) => {
                                const decision = event.target
                                  .value as Decision["decision"];
                                setDecisions((current) =>
                                  current.map((entry, i) =>
                                    i === index
                                      ? {
                                          row: row.row,
                                          decision,
                                          ...(decision === "update"
                                            ? { targetId: available[0]?.id }
                                            : {}),
                                        }
                                      : entry,
                                  ),
                                );
                              }}
                            >
                              <option value="skip">Skip</option>
                              <option
                                value="update"
                                disabled={
                                  !!row.errors.length || !available.length
                                }
                              >
                                Update existing
                              </option>
                              <option
                                value="create"
                                disabled={
                                  !!row.errors.length ||
                                  !!row.createBlocked.length
                                }
                              >
                                {row.candidates.length || row.warnings.length
                                  ? "Create anyway"
                                  : "Create new"}
                              </option>
                            </select>
                          </td>
                          <td>
                            {choice.decision === "update" ? (
                              <select
                                aria-label={`Update target for record ${row.row}`}
                                value={choice.targetId ?? ""}
                                required
                                onChange={(event) =>
                                  setDecisions((current) =>
                                    current.map((entry, i) =>
                                      i === index
                                        ? {
                                            ...entry,
                                            targetId: event.target.value,
                                          }
                                        : entry,
                                    ),
                                  )
                                }
                              >
                                {available.map((candidate) => (
                                  <option
                                    key={candidate.id}
                                    value={candidate.id}
                                  >
                                    {candidate.internalSku} · {candidate.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="muted">
                                {choice.decision === "create"
                                  ? "New catalog record"
                                  : "No changes"}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
            <div className="panel form-section csv-confirm">
              <p>
                {decisions.filter((row) => row.decision === "create").length} to
                create ·{" "}
                {decisions.filter((row) => row.decision === "update").length} to
                update ·{" "}
                {decisions.filter((row) => row.decision === "skip").length} to
                skip
              </p>
              <label>
                <input name="confirmed" type="checkbox" required /> I reviewed
                the rows, duplicate decisions and update policy.
              </label>
              <div className="form-actions">
                <button className="button primary" type="submit">
                  {pending ? "Importing…" : "Confirm and import"}
                </button>
              </div>
            </div>
          </fieldset>
        </form>
      )}
      {summary && (
        <section className="panel form-section">
          <h2 className="section-title">Import summary</h2>
          <p role="status">
            {summary.created} created · {summary.updated} updated ·{" "}
            {summary.skipped} skipped · {summary.failed} failed
          </p>
          <div className="table-scroll">
            <table className="data-table read-table">
              <thead>
                <tr>
                  <th>CSV record</th>
                  <th>Item</th>
                  <th>Result</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {summary.results.map((row) => (
                  <tr key={row.row}>
                    <td>{row.row}</td>
                    <td>
                      {row.itemId ? (
                        <Link
                          className="source-link"
                          href={`/admin/merchandise/catalog/${row.itemId}`}
                        >
                          {row.name}
                        </Link>
                      ) : (
                        row.name
                      )}
                    </td>
                    <td>{row.status}</td>
                    <td>{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button className="button" type="button" onClick={reset}>
              Import another file
            </button>
            <Link
              className="button primary"
              href={`/admin/merchandise/lineups/${lineupId}`}
            >
              Back to lineup
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
