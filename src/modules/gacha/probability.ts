export type WeightedPrize = { id: string; weight: number };
export function totalWeight(prizes: WeightedPrize[]) {
  if (
    !prizes.length ||
    prizes.some((p) => !Number.isSafeInteger(p.weight) || p.weight <= 0)
  )
    throw new Error("Prize weights must be positive integers.");
  const total = prizes.reduce((sum, p) => sum + p.weight, 0);
  if (total > 100000000)
    throw new Error("Total weight exceeds the supported exact range.");
  return total;
}
/** Pure interval lookup for audit replay. Production entropy never comes from callers. */
export function prizeForTicket(prizes: WeightedPrize[], ticket: number) {
  const total = totalWeight(prizes);
  if (!Number.isInteger(ticket) || ticket < 0 || ticket >= total)
    throw new Error("Random ticket is outside the configured range.");
  let start = 0;
  for (const prize of prizes) {
    const end = start + prize.weight;
    if (ticket < end) return { prize, start, end };
    start = end;
  }
  throw new Error("Invalid prize configuration.");
}
function gcd(a: bigint, b: bigint): bigint {
  while (b) {
    const r = a % b;
    a = b;
    b = r;
  }
  return a;
}
/** Exact rational is authoritative. Non-terminating percentages are explicitly marked rounded. */
export function probability(weight: number, total: number) {
  const divisor = gcd(BigInt(weight), BigInt(total)),
    numerator = BigInt(weight) / divisor,
    denominator = BigInt(total) / divisor;
  const scaled = BigInt(weight) * 100000000n,
    rounded = (scaled + BigInt(total) / 2n) / BigInt(total);
  const digits = rounded.toString().padStart(7, "0");
  const percentage = `${digits.slice(0, -6)}.${digits.slice(-6)}`.replace(
    /\.?0+$/,
    "",
  );
  return {
    weight,
    totalWeight: total,
    numerator: numerator.toString(),
    denominator: denominator.toString(),
    percentage,
    percentageExact: scaled % BigInt(total) === 0n,
  };
}
