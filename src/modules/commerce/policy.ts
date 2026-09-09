import { z } from "zod";
import { createHash } from "node:crypto";
import { DomainError } from "../shared/errors";

export const policySchema = z
  .object({
    version: z.string().min(1).max(100).default("fr-mainland-ttc-v1"),
    currency: z.literal("EUR").default("EUR"),
    zone: z.literal("FR_MAINLAND").default("FR_MAINLAND"),
    supportedCountries: z.array(z.literal("FR")).length(1).default(["FR"]),
    deliveryMethod: z
      .string()
      .min(1)
      .max(100)
      .default("Standard delivery — France"),
    shippingAmount: z.number().int().min(0).max(1000000).default(590),
    freeShippingThreshold: z.number().int().min(0).max(10000000).default(8000),
    defaultVatRateBps: z.number().int().min(0).max(10000).default(2000),
    shippingVatRateBps: z.number().int().min(0).max(10000).default(2000),
    categoryVatRates: z
      .record(z.uuid(), z.number().int().min(0).max(10000))
      .default({}),
    reservationMinutes: z.number().int().min(35).max(1440).default(60),
  })
  .strict();
export type CheckoutPolicy = z.infer<typeof policySchema>;
export function checkoutPolicy(): CheckoutPolicy {
  return policySchema.parse(
    process.env.COMMERCE_POLICY_JSON
      ? JSON.parse(process.env.COMMERCE_POLICY_JSON)
      : {},
  );
}
export function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function guestHash(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new DomainError("UNAUTHORIZED", "Guest access is required.");
  return hash(token);
}
export const addressSchema = z
  .object({
    name: z.string().trim().min(2).max(150),
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).default(""),
    city: z.string().trim().min(2).max(100),
    postalCode: z
      .string()
      .trim()
      .regex(
        /^(0[1-9]|1[0-9]|2[1-9]|[3-8][0-9]|9[0-5])[0-9]{3}$/,
        "Enter a mainland France postcode; Corsica and overseas destinations are not supported.",
      ),
    country: z.literal("FR"),
  })
  .strict();
export const contactSchema = z
  .object({
    email: z.email().max(254),
    phone: z.string().trim().max(30).default(""),
  })
  .strict();
export const quoteInput = z
  .object({
    lines: z
      .array(
        z
          .object({
            listingId: z.uuid(),
            quantity: z.number().int().min(1).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    contact: contactSchema,
    shippingAddress: addressSchema,
    billingAddress: addressSchema.optional(),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.lines.map((line) => line.listingId)).size ===
      input.lines.length,
    "Merge duplicate cart lines before checkout.",
  );
export type QuoteInput = z.infer<typeof quoteInput>;
export interface QuotedLine {
  listingId: string;
  merchandiseItemId: string;
  title: string;
  quantity: number;
  unitPriceAmount: number;
  currency: string;
  taxRateBps: number;
  taxAmount: number;
  totalAmount: number;
}
export interface QuoteSnapshot {
  lines: QuotedLine[];
  currency: string;
  subtotalAmount: number;
  shippingAmount: number;
  shippingTaxAmount: number;
  shippingTaxRateBps: number;
  taxAmount: number;
  totalAmount: number;
  policy: CheckoutPolicy;
}
/** Half-up to cents per line: net = gross / (1 + VAT); VAT is the remainder. */
export function includedVat(gross: number, rateBps: number) {
  const denominator = BigInt(10000 + rateBps);
  const net = (BigInt(gross) * 10000n + denominator / 2n) / denominator;
  return gross - Number(net);
}
export function quoteTotals(
  lines: QuotedLine[],
  policy: CheckoutPolicy,
): QuoteSnapshot {
  const subtotalAmount = lines.reduce((n, line) => n + line.totalAmount, 0);
  const shippingAmount =
    subtotalAmount >= policy.freeShippingThreshold ? 0 : policy.shippingAmount;
  const shippingTaxAmount = includedVat(
    shippingAmount,
    policy.shippingVatRateBps,
  );
  const totalAmount = subtotalAmount + shippingAmount;
  if (
    !Number.isSafeInteger(totalAmount) ||
    totalAmount > 2147483647 ||
    totalAmount < 50
  )
    throw new DomainError(
      "ORDER_TOTAL_INVALID",
      "Order total must be between EUR 0.50 and the supported order limit.",
    );
  return {
    lines,
    currency: policy.currency,
    subtotalAmount,
    shippingAmount,
    shippingTaxAmount,
    shippingTaxRateBps: policy.shippingVatRateBps,
    taxAmount: lines.reduce((n, line) => n + line.taxAmount, shippingTaxAmount),
    totalAmount,
    policy,
  };
}
