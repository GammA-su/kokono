"use client";

import { useState } from "react";
import type { SourceFormValue } from "@/modules/lineups/validation";
import { Icon } from "@/components/ui/icon";
import { SourceErrors } from "./action-form";

export const sourceLabels: Record<string, string> = {
  OFFICIAL_STORE: "Official store",
  MANUFACTURER: "Manufacturer",
  OFFICIAL_ANNOUNCEMENT: "Official announcement",
  RETAILER: "Retailer",
  EVENT: "Event",
  OTHER: "Other",
};
export function SourceEditor({
  initial = [],
}: {
  initial?: SourceFormValue[];
}) {
  const [rows, setRows] = useState(() =>
    initial.map((source, i) => ({ ...source, key: `initial-${i}` })),
  );
  function update(key: string, field: keyof SourceFormValue, value: string) {
    setRows((old) =>
      old.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    );
  }
  return (
    <div className="source-editor">
      <input
        type="hidden"
        name="sources"
        value={JSON.stringify(
          rows.map((row) => ({
            provider: row.provider,
            sourceType: row.sourceType,
            url: row.url,
            checkedDate: row.checkedDate,
            notes: row.notes,
          })),
        )}
      />
      <SourceErrors />
      {rows.map((row, index) => (
        <section className="source-row" key={row.key}>
          <div className="source-row-top">
            <h3>Source {index + 1}</h3>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setRows((old) => old.filter((r) => r.key !== row.key))
              }
              aria-label={`Remove source ${index + 1}`}
            >
              Remove
            </button>
          </div>
          <div className="field-grid">
            <label className="field full">
              Source URL
              <input
                type="url"
                required
                value={row.url}
                onChange={(e) => update(row.key, "url", e.target.value)}
                placeholder="https://…"
                maxLength={2048}
              />
            </label>
            <label className="field">
              Provider
              <input
                required
                value={row.provider}
                onChange={(e) => update(row.key, "provider", e.target.value)}
                placeholder="e.g. KADOKAWA"
                maxLength={200}
              />
            </label>
            <label className="field">
              Source type
              <select
                value={row.sourceType}
                onChange={(e) => update(row.key, "sourceType", e.target.value)}
              >
                {Object.entries(sourceLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Last checked
              <input
                type="date"
                value={row.checkedDate ?? ""}
                onChange={(e) => update(row.key, "checkedDate", e.target.value)}
              />
              <small>Leave blank until you check the source.</small>
            </label>
            <label className="field">
              Notes
              <input
                value={row.notes ?? ""}
                onChange={(e) => update(row.key, "notes", e.target.value)}
                placeholder="Optional verification notes"
              />
            </label>
          </div>
        </section>
      ))}
      {!rows.length && (
        <p className="muted small-copy">
          No sources added. Keep official announcements, stores, and other
          references together.
        </p>
      )}
      <button
        type="button"
        className="button"
        disabled={rows.length >= 50}
        onClick={() =>
          setRows((old) => [
            ...old,
            {
              key: crypto.randomUUID(),
              provider: "",
              sourceType: "OFFICIAL_STORE",
              url: "",
              checkedDate: "",
              notes: "",
            },
          ])
        }
      >
        <Icon name="plus" />
        Add source link
      </button>
    </div>
  );
}
