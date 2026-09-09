import type { LandedEstimate } from "./queries";
import { roundRatio } from "./math";
export function landedPricing(
  estimate: LandedEstimate | undefined | null,
  price: number | undefined | null,
  currency: string | undefined | null,
  taxBasis?: "UNKNOWN" | "INCLUDED" | "EXCLUDED",
) {
  if (!estimate) return null;
  const unitAmount = roundRatio(
    BigInt(estimate.totalAmount),
    BigInt(estimate.quantity),
  ).toString();
  if (
    price === undefined ||
    price === null ||
    currency !== estimate.currency ||
    (taxBasis !== undefined && taxBasis !== "EXCLUDED")
  )
    return { unitAmount, marginAmount: null, marginPercent: null };
  const revenue = BigInt(price) * BigInt(estimate.quantity),
    margin = revenue - BigInt(estimate.totalAmount);
  const percent = revenue ? roundRatio(margin * 10000n, revenue) : null;
  const absolute = percent !== null && percent < 0n ? -percent : percent;
  return {
    unitAmount,
    marginAmount: roundRatio(margin, BigInt(estimate.quantity)).toString(),
    marginPercent:
      absolute === null
        ? null
        : `${percent! < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`,
  };
}
