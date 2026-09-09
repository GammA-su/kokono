import Link from "next/link";
import type { LandedEstimate } from "@/modules/landed-costs/queries";
import { landedPricing } from "@/modules/landed-costs/presentation";
import { formatMoney, parseMoneyInput } from "@/modules/shared/money";
export function LandedPrice({
  estimate,
  price,
  currency,
  priceText,
  taxBasis = "UNKNOWN",
}: {
  estimate?: LandedEstimate | null;
  price?: number | null;
  currency?: string | null;
  priceText?: string;
  taxBasis?: "UNKNOWN" | "INCLUDED" | "EXCLUDED";
}) {
  let proposed = price;
  if (priceText !== undefined) {
    try {
      proposed = currency ? parseMoneyInput(priceText, currency) : null;
    } catch {
      proposed = null;
    }
  }
  const comparableTax = taxBasis === undefined || taxBasis === "EXCLUDED";
  const value = landedPricing(estimate, proposed, currency, taxBasis);
  if (!estimate || !value)
    return (
      <p className="muted small-copy">
        Landed cost unknown. This does not block publication.
      </p>
    );
  return (
    <div className="small-copy">
      <p>
        Estimated landed unit cost:{" "}
        <strong>
          ≈ {formatMoney(BigInt(value.unitAmount), estimate.currency)}
        </strong>
      </p>
      <p>
        {value.marginAmount !== null
          ? `Estimated unit margin: ${formatMoney(BigInt(value.marginAmount), estimate.currency)}${value.marginPercent !== null ? ` (${value.marginPercent}%)` : ""}`
          : !comparableTax
            ? "Margin unavailable: a comparable net selling price is required; tax basis or VAT conversion is unavailable."
            : "Margin requires a selling price in the same currency."}
      </p>
      {value.marginAmount !== null && proposed === 0 && (
        <p className="muted">
          Percentage margin is unavailable at a zero selling price.
        </p>
      )}
      <Link
        href={`/admin/shipments/${estimate.shipmentId}/costs/${estimate.calculationId}`}
      >
        Latest finalized shipment batch · {estimate.createdAt.slice(0, 10)}
      </Link>
      <p className="muted">
        Batch estimate, not a perpetual inventory valuation. Margin excludes
        selling/payment fees and customer delivery costs.
      </p>
    </div>
  );
}
