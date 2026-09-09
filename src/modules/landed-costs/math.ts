import { currencyMinorDigits } from "../shared/money";
import { DomainError } from "../shared/errors";

export function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n)
    throw new DomainError("INVALID_DIVISOR", "A positive divisor is required.");
  return numerator < 0n
    ? -roundRatio(-numerator, denominator)
    : (numerator + denominator / 2n) / denominator;
}
export function decimalRatio(value: string) {
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(value) || !/[1-9]/.test(value))
    throw new DomainError(
      "INVALID_RATE",
      "Enter a positive decimal exchange rate, up to 12 decimal places.",
    );
  const [whole, fraction = ""] = value.split(".");
  return {
    numerator: BigInt(whole + fraction),
    denominator: 10n ** BigInt(fraction.length),
  };
}
/** Rate means target major currency units per one source major unit. No live FX or implicit parity. */
export function convertMinor(
  amount: bigint,
  source: string,
  target: string,
  rate?: string,
) {
  if (source === target || amount === 0n) return amount;
  if (!rate)
    throw new DomainError(
      "MISSING_RATE",
      `Enter the ${source} → ${target} rate used for this calculation.`,
    );
  const ratio = decimalRatio(rate);
  return roundRatio(
    amount * ratio.numerator * 10n ** BigInt(currencyMinorDigits(target)),
    ratio.denominator * 10n ** BigInt(currencyMinorDigits(source)),
  );
}
/** Largest-remainder allocation. Caller supplies stable batch order for deterministic ties. */
export function allocateMinor(total: bigint, weights: bigint[]): bigint[] {
  if (total < 0n || weights.some((weight) => weight < 0n))
    throw new DomainError(
      "INVALID_ALLOCATION",
      "Costs and allocation weights cannot be negative.",
    );
  if (!total) return weights.map(() => 0n);
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (!sum)
    throw new DomainError(
      "MISSING_BASIS",
      "A positive allocation basis is required for recorded shipment costs.",
    );
  const result = weights.map((weight) => (total * weight) / sum);
  let remaining = total - result.reduce((a, b) => a + b, 0n);
  const ranks = weights
    .map((weight, index) => ({ index, remainder: (total * weight) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  for (const row of ranks) {
    if (!remaining) break;
    result[row.index]++;
    remaining--;
  }
  return result;
}
/** Allocate uniform purchase charges over actual unit ranges without expanding units into records. */
export function unitSlice(
  total: bigint,
  units: number,
  offset: number,
  quantity: number,
) {
  if (units <= 0 || offset < 0 || quantity <= 0 || offset + quantity > units)
    throw new DomainError("INVALID_RANGE", "Purchase unit range is invalid.");
  const count = BigInt(units),
    start = BigInt(offset),
    end = BigInt(offset + quantity),
    remainder = total % count;
  const overlap =
    (end < remainder ? end : remainder) -
    (start < remainder ? start : remainder);
  return (total / count) * BigInt(quantity) + overlap;
}

export function weightMilligrams(grams: string) {
  const [whole, fraction = ""] = grams.split(".");
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
}
