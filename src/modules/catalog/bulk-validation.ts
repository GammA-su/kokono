import { z } from "zod";
import {
  SourceType,
  TaxInclusion,
  WatchPriority,
} from "../../generated/prisma/enums";
import { currencyCode, databaseInteger, entityId } from "../shared/validation";
import { imageReferenceSchema, partialDateSchema } from "../lineups/validation";
import type { RowIssue } from "./bulk-fields";

// Required references are checked as identifiers but reported in the operator's language.
const requiredReference = (message: string) =>
  z
    .string()
    .trim()
    .refine((value) => entityId.safeParse(value).success, message);
const optionalLine = z
  .string()
  .trim()
  .max(500)
  .transform((value) => value || null)
  .nullable()
  .default(null);
const optionalNote = z
  .string()
  .trim()
  .max(20_000)
  .transform((value) => value || null)
  .nullable()
  .default(null);

// Money never passes through a floating-point parse: only whole minor units are accepted.
function wholeAmount(label: string, minimum = 0) {
  return z
    .union([z.string(), z.number(), z.null()])
    .default(null)
    .transform((value, ctx) => {
      const text = typeof value === "number" ? String(value) : (value ?? "");
      const trimmed = text.trim();
      if (!trimmed) return null;
      if (!/^\d{1,10}$/.test(trimmed)) {
        ctx.addIssue({
          code: "custom",
          message: `${label} must be a whole number of currency minor units, without separators or decimals.`,
        });
        return z.NEVER;
      }
      const parsed = databaseInteger.safeParse(Number(trimmed));
      if (!parsed.success || parsed.data < minimum) {
        ctx.addIssue({
          code: "custom",
          message: `${label} is outside the supported range.`,
        });
        return z.NEVER;
      }
      return parsed.data;
    });
}

const rowSourceSchema = z
  .object({
    provider: z.string().trim().max(200).default(""),
    sourceType: z.enum(SourceType).default("OTHER"),
    url: z.string().trim().max(2048).default(""),
  })
  .strict()
  .prefault({})
  .transform((value, ctx) => {
    if (!value.url && !value.provider) return null;
    if (!z.url({ protocol: /^https?$/ }).safeParse(value.url).success) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Use a complete HTTP(S) source URL.",
      });
      return z.NEVER;
    }
    if (!value.provider) {
      ctx.addIssue({
        code: "custom",
        path: ["provider"],
        message: "Name the source provider, or clear the source URL.",
      });
      return z.NEVER;
    }
    return {
      provider: value.provider,
      sourceType: value.sourceType,
      url: value.url,
    };
  });

const rowWatchSchema = z
  .object({
    enabled: z.boolean().default(false),
    targetQuantity: z
      .union([z.string(), z.number(), z.null()])
      .default(null)
      .transform((value, ctx) => {
        const trimmed = (
          typeof value === "number" ? String(value) : (value ?? "")
        ).trim();
        if (!trimmed) return null;
        if (
          !/^\d{1,10}$/.test(trimmed) ||
          Number(trimmed) < 1 ||
          !databaseInteger.safeParse(Number(trimmed)).success
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Target quantity must be a whole number of one or more.",
          });
          return z.NEVER;
        }
        return Number(trimmed);
      }),
    maxUnitPriceAmount: wholeAmount("Maximum unit price"),
    maxUnitPriceCurrency: currencyCode.default("JPY"),
    priority: z.enum(WatchPriority).default("NORMAL"),
    conditionPreference: optionalNote,
    marketplaceSearchQuery: optionalNote,
    notes: optionalNote,
  })
  .strict()
  .prefault({});

export const bulkRowSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Enter the English or display name.")
      .max(500),
    japaneseName: optionalLine,
    categoryId: requiredReference("Select a category for this item."),
    characterIds: z
      .array(requiredReference("Select an existing character."))
      .max(50)
      .default([]),
    internalSku: z
      .string()
      .trim()
      .max(200)
      .transform((value) => value || null)
      .nullable()
      .default(null),
    janCode: z
      .string()
      .trim()
      .max(13)
      .transform((value) => value || null)
      .nullable()
      .default(null)
      .refine(
        (value) => value === null || /^\d{8}(?:\d{5})?$/.test(value),
        "JAN code must be 8 or 13 digits.",
      ),
    manufacturer: optionalLine,
    releaseDate: partialDateSchema,
    officialMsrpAmount: wholeAmount("Official MSRP"),
    officialMsrpCurrency: currencyCode.default("JPY"),
    officialMsrpTaxInclusion: z.enum(TaxInclusion).default("UNKNOWN"),
    privateNotes: optionalNote,
    image: imageReferenceSchema,
    source: rowSourceSchema,
    watch: rowWatchSchema,
  })
  .strict()
  .transform((row) => ({
    ...row,
    characterIds: [...new Set(row.characterIds)],
    // The catalog stores no MSRP currency or tax status without an amount.
    officialMsrpCurrency:
      row.officialMsrpAmount === null ? null : row.officialMsrpCurrency,
    officialMsrpTaxInclusion:
      row.officialMsrpAmount === null
        ? "UNKNOWN"
        : row.officialMsrpTaxInclusion,
  }));
export type BulkRow = z.output<typeof bulkRowSchema>;

export const bulkBatchSchema = z
  .object({
    lineupId: entityId,
    // Weak duplicate signals are reported for review; saving again confirms them.
    acknowledgeDuplicates: z.boolean().default(false),
    rows: z.array(z.unknown()).min(1).max(100),
  })
  .strict();

export type { RowIssue } from "./bulk-fields";

/** Maps one row's validation failure to per-field issues that name the row number. */
export function rowIssues(rowNumber: number, error: z.ZodError): RowIssue[] {
  return error.issues.map((issue) => ({
    row: rowNumber,
    field: issue.path.filter((part) => typeof part === "string").join("."),
    message: issue.message,
  }));
}
