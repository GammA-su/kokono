import { z } from "zod";
import { MarketplaceListingStatus } from "../../generated/prisma/enums";
import { currencyCode, moneyAmount, optionalText } from "../shared/validation";

export const candidateStatuses = Object.values(MarketplaceListingStatus);
export const editableStatuses = [
  "AVAILABLE",
  "SOLD",
  "EXPIRED",
  "REJECTED",
  "UNKNOWN",
] as const;
const text = optionalText.transform((value) => value || null);
export const candidateUrl = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password;
  }, "Use a public listing URL without embedded credentials.");
export const candidateInput = z.object({
  id: z.uuid(),
  merchandiseItemId: z.uuid(),
  marketplace: z.string().trim().min(1).max(100),
  externalListingId: z
    .string()
    .trim()
    .max(256)
    .nullable()
    .optional()
    .transform((value) => value || null),
  url: candidateUrl,
  sellerName: text,
  itemPriceAmount: moneyAmount,
  currency: currencyCode,
  domesticShippingAmount: moneyAmount.nullable().default(null),
  condition: text,
  status: z.enum(editableStatuses).default("UNKNOWN"),
  notes: text,
});
export const conversionInput = z.object({
  id: z.uuid(),
  version: z.iso.datetime(),
  supplier: z.string().trim().min(1).max(500),
  externalReference: text,
  purchaseDate: z.iso.date(),
  status: z.enum(["ORDERED", "PAID"]),
  quantity: z.number().int().positive().max(1_000_000),
  unitPriceAmount: moneyAmount,
  domesticShippingAmount: moneyAmount,
  feesAmount: moneyAmount,
  taxesAmount: moneyAmount,
  notes: text,
  confirmed: z.literal(true),
});
