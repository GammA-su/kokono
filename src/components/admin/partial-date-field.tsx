"use client";

import { useId, useState } from "react";
import { FieldErrors } from "./action-form";

export function PartialDateField({
  name,
  label,
  initial = "",
}: {
  name: string;
  label: string;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  const [precision, setPrecision] = useState(
    initial.length === 4
      ? "year"
      : initial.length === 7
        ? "month"
        : initial
          ? "day"
          : "unknown",
  );
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="date-control">
        <select
          aria-label={`${label} precision`}
          value={precision}
          onChange={(e) => {
            const next = e.target.value;
            const length = next === "year" ? 4 : next === "month" ? 7 : 10;
            setValue(
              next === "unknown" || value.length < length
                ? ""
                : value.slice(0, length),
            );
            setPrecision(next);
          }}
        >
          <option value="unknown">Unknown</option>
          <option value="year">Year</option>
          <option value="month">Month</option>
          <option value="day">Exact date</option>
        </select>
        {precision === "unknown" ? (
          <>
            <input type="hidden" name={name} value="" />
            <input id={id} disabled placeholder="Not yet known" />
          </>
        ) : (
          <input
            id={id}
            name={name}
            required
            type={
              precision === "year"
                ? "number"
                : precision === "month"
                  ? "month"
                  : "date"
            }
            min={
              precision === "year"
                ? "1"
                : precision === "month"
                  ? "0001-01"
                  : "0001-01-01"
            }
            max={
              precision === "year"
                ? "9999"
                : precision === "month"
                  ? "9999-12"
                  : "9999-12-31"
            }
            placeholder="2026"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </div>
      <small>Choose only the precision your source provides.</small>
      <FieldErrors name={name} />
    </div>
  );
}
