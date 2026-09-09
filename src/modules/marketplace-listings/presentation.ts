import { formatMoney } from "../shared/money";

/** Compare offer item price only. Shipping, fees and FX are never inferred. */
export function compareCandidatePrice(
  amount: number,
  currency: string,
  benchmark: number | null,
  benchmarkCurrency: string | null,
) {
  if (benchmark === null || benchmarkCurrency === null)
    return { kind: "unknown" as const, difference: null };
  if (currency !== benchmarkCurrency)
    return { kind: "different_currency" as const, difference: null };
  return { kind: "comparable" as const, difference: benchmark - amount };
}
export function priceComparisonLabel(
  amount: number,
  currency: string,
  benchmark: number | null,
  benchmarkCurrency: string | null,
  label: string,
) {
  const comparison = compareCandidatePrice(
    amount,
    currency,
    benchmark,
    benchmarkCurrency,
  );
  if (comparison.kind === "unknown") return `${label} not recorded`;
  if (comparison.kind === "different_currency")
    return `${label}: ${formatMoney(benchmark!, benchmarkCurrency!)} · Different currency; no comparison`;
  const difference = comparison.difference;
  return `${label}: ${formatMoney(benchmark!, currency)} · ${difference === 0 ? "At " + label.toLowerCase() : `${formatMoney(Math.abs(difference), currency)} ${difference > 0 ? "below" : "above"} ${label.toLowerCase()}`}`;
}
