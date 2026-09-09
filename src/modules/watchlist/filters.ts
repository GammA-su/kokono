import { z } from "zod";

export const sourcingSortLabels = {
  priority: "Highest priority",
  gap: "Largest quantity gap",
  "release-desc": "Newest release",
  "watch-added": "Recently added to watchlist",
  checked: "Least recently checked",
  msrp: "MSRP (currency, low to high)",
  "max-price": "Maximum target price (currency, low to high)",
} as const;
export const sourcingFilterSchema = z.object({
  sort: z
    .enum([
      "priority",
      "gap",
      "release-desc",
      "watch-added",
      "checked",
      "msrp",
      "max-price",
    ])
    .catch("priority"),
  below: z.enum(["any", "yes"]).catch("any"),
  country: z.enum(["JP", "FR"]).optional().catch(undefined),
  checked: z.enum(["any", "never", "7", "30", "90"]).catch("any"),
});
export function quantityNeeded(
  target: number | null,
  totalOwned: number,
): number | null {
  return target === null ? null : Math.max(target - totalOwned, 0);
}
