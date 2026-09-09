import { z } from "zod";
import {
  entityId,
  moneyAmount,
  optionalText,
  slug,
} from "../shared/validation";

// Explicit initial storefront policy, separate from acquisition/MSRP currencies.
export const storefrontCurrencies = ["EUR", "JPY", "USD", "GBP"] as const;
export const storefrontCurrency = z.enum(storefrontCurrencies);
const text = optionalText.transform((value) => (value === "" ? null : value));
export const listingSchema = z
  .object({
    merchandiseItemId: entityId,
    publicTitle: z.string().trim().max(500).nullable().optional(),
    slug,
    publicDescription: text,
    publicSubtitle: z.string().trim().max(500).nullable().optional(),
    seoTitle: z.string().trim().max(200).nullable().optional(),
    seoDescription: z.string().trim().max(500).nullable().optional(),
    sellingPriceAmount: moneyAmount,
    sellingPriceCurrency: storefrontCurrency,
    sellingPriceTaxInclusion: z
      .enum(["UNKNOWN", "INCLUDED", "EXCLUDED"])
      .optional(),
    featured: z.boolean().optional(),
    publicCategoryId: entityId.nullable().optional(),
    imageIds: z
      .array(entityId)
      .max(20)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select each image once.",
      )
      .optional(),
  })
  .strict();
export const reviewedListingSchema = z
  .object({
    listing: listingSchema,
    expectedListingUpdatedAt: z.string().nullable(),
    expectedItemUpdatedAt: z.string(),
    published: z.boolean().default(true),
  })
  .strict();
