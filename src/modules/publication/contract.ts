import { z } from "zod";
import { storefrontCurrency } from "./validation";
export const storefrontFilters = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    size: z.coerce.number().int().min(1).max(100).default(24),
    q: z.string().trim().max(200).default(""),
    franchise: z.uuid().optional(),
    lineup: z.uuid().optional(),
    character: z.uuid().optional(),
    category: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(200)
      .optional(),
    currency: storefrontCurrency.optional(),
    minPrice: z.coerce.number().int().nonnegative().max(2147483647).optional(),
    maxPrice: z.coerce.number().int().nonnegative().max(2147483647).optional(),
    availability: z.enum(["IN_STOCK", "OUT_OF_STOCK"]).optional(),
    sort: z
      .enum(["newest", "release", "alphabetical", "price-asc", "price-desc"])
      .default("newest"),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      (data.minPrice !== undefined ||
        data.maxPrice !== undefined ||
        data.sort.startsWith("price")) &&
      !data.currency
    )
      ctx.addIssue({
        code: "custom",
        message: "Price filtering and sorting require one currency.",
      });
    if (
      data.minPrice !== undefined &&
      data.maxPrice !== undefined &&
      data.minPrice > data.maxPrice
    )
      ctx.addIssue({ code: "custom", message: "Invalid price range." });
  });
export const resolveListingsInput = z
  .object({ listingIds: z.array(z.uuid()).min(1).max(100) })
  .strict();
export type StorefrontFilters = z.infer<typeof storefrontFilters>;
export type PublicRelease = {
  value: string;
  precision: "YEAR" | "MONTH" | "DAY";
} | null;
export type PublicListingDto = {
  listingId: string;
  slug: string;
  title: string;
  description: string | null;
  subtitle: string | null;
  price: { amount: number; currency: string };
  featured: boolean;
  franchise: {
    id: string;
    slug: string;
    name: string;
    japaneseName: string | null;
  };
  lineup: {
    id: string;
    slug: string;
    name: string;
    japaneseName: string | null;
  };
  characters: { id: string; name: string; japaneseName: string | null }[];
  category: { id: string; slug: string; name: string };
  merchandiseCategory: { name: string; slug: string };
  images: { id: string; url: string; alt: string }[];
  release: PublicRelease;
  availability: {
    status: "IN_STOCK" | "OUT_OF_STOCK";
    availableQuantity: number;
  };
  seo: { title: string | null; description: string | null };
};
