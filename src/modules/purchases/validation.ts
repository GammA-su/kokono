import { z } from "zod";
import { PurchaseStatus } from "../../generated/prisma/enums";
import { DomainError } from "../shared/errors";
import {
  currencyCode,
  moneyAmount,
  name,
  optionalText,
} from "../shared/validation";

export const purchaseStatuses = Object.values(PurchaseStatus);
export const purchaseStatusLabels: Record<PurchaseStatus, string> = {
  DRAFT: "Draft",
  ORDERED: "Ordered",
  PAID: "Paid",
  RECEIVED_JAPAN: "Received in Japan",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
  OTHER: "Other",
};
export const transitions: Record<PurchaseStatus, PurchaseStatus[]> = {
  DRAFT: ["ORDERED", "PAID", "CANCELLED", "OTHER"],
  ORDERED: ["PAID", "CANCELLED", "OTHER"],
  PAID: ["CANCELLED", "REFUNDED", "OTHER"],
  RECEIVED_JAPAN: ["REFUNDED", "OTHER"],
  OTHER: ["ORDERED", "PAID", "CANCELLED", "REFUNDED"],
  CANCELLED: [],
  REFUNDED: [],
};
const nullableText = optionalText.transform((value) => value || null);
export const purchaseInput = z.object({
  id: z.uuid(),
  supplier: name,
  marketplace: nullableText,
  externalReference: nullableText,
  purchaseDate: z.iso.date(),
  currency: currencyCode,
  domesticShippingAmount: moneyAmount.default(0),
  feesAmount: moneyAmount.default(0),
  taxesAmount: moneyAmount.default(0),
  status: z.enum(["DRAFT", "ORDERED", "PAID", "OTHER"]).default("DRAFT"),
  notes: nullableText,
  items: z
    .array(
      z.object({
        merchandiseItemId: z.uuid(),
        quantity: z.number().int().positive().max(1_000_000),
        unitPriceAmount: moneyAmount,
        condition: nullableText,
        sellerListingUrl: z
          .url({ protocol: /^https?$/ })
          .max(4000)
          .nullable()
          .optional()
          .transform((value) => value || null),
        notes: nullableText,
      }),
    )
    .min(1)
    .max(200),
});
export function purchaseTotals(input: {
  items: { quantity: number; unitPriceAmount: number }[];
  domesticShippingAmount: number;
  feesAmount: number;
  taxesAmount: number;
}) {
  const subtotal = input.items.reduce(
    (sum, item) => sum + BigInt(item.quantity) * BigInt(item.unitPriceAmount),
    0n,
  );
  const total =
    subtotal +
    BigInt(input.domesticShippingAmount) +
    BigInt(input.feesAmount) +
    BigInt(input.taxesAmount);
  if (total > 2_147_483_647n)
    throw new DomainError(
      "AMOUNT_TOO_LARGE",
      "Purchase total exceeds the supported amount.",
    );
  return { subtotalAmount: Number(subtotal), totalAmount: Number(total) };
}
export const receiptInput = z.object({
  purchaseId: z.uuid(),
  itemIds: z.array(z.uuid()).min(1).max(200),
  destinationLocationId: z.uuid(),
  notes: nullableText,
});
