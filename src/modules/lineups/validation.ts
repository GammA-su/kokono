import { z } from "zod";
import { LineupStatus, SourceType } from "../../generated/prisma/enums";
import { entityId, name } from "../shared/validation";
import { parsePartialDate } from "../catalog/partial-date";

const nullableText = z
  .string()
  .trim()
  .max(20_000)
  .transform((value) => value || null)
  .nullable()
  .default(null);
export const imageReferenceSchema = z
  .string()
  .max(2048)
  .refine(
    (value) =>
      !value ||
      /^admin-media\/[a-f0-9-]+\.(png|jpg|webp)$/.test(value) ||
      (/^https?:\/\//.test(value) &&
        z.url({ protocol: /^https?$/ }).safeParse(value).success),
    "Use an HTTP(S) image URL or an uploaded image.",
  )
  .nullable()
  .default(null);
export const partialDateSchema = z
  .string()
  .trim()
  .nullable()
  .default(null)
  .transform((value, ctx) => {
    if (!value) return null;
    try {
      return parsePartialDate(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Use a valid year, year-month, or full date (YYYY-MM-DD).",
      });
      return z.NEVER;
    }
  });
export const sourceSchema = z
  .object({
    provider: name.max(200),
    sourceType: z.enum(SourceType).default("OTHER"),
    url: z.url({ protocol: /^https?$/ }).max(2048),
    checkedDate: z
      .string()
      .default("")
      .transform((value, ctx) => {
        if (!value) return null;
        try {
          const result = parsePartialDate(value);
          if (result.precision === "DAY") return result.date;
        } catch {
          /* Report field error below. */
        }
        ctx.addIssue({
          code: "custom",
          message: "Checked date must be a complete calendar date.",
        });
        return z.NEVER;
      }),
    notes: nullableText,
  })
  .strict();
export const sourcesSchema = z
  .array(sourceSchema)
  .max(50)
  .superRefine((sources, ctx) => {
    const urls = new Set<string>();
    for (const [index, source] of sources.entries()) {
      if (urls.has(source.url))
        ctx.addIssue({
          code: "custom",
          path: [index, "url"],
          message: "This source URL is already included.",
        });
      urls.add(source.url);
    }
  });
export const lineupInputSchema = z
  .object({
    franchiseId: entityId,
    name,
    japaneseName: nullableText,
    description: nullableText,
    manufacturer: z
      .string()
      .trim()
      .max(500)
      .transform((value) => value || null)
      .nullable()
      .default(null),
    announcedDate: partialDateSchema,
    releaseDate: partialDateSchema,
    status: z.enum(LineupStatus),
    mainImageStorageKey: imageReferenceSchema,
    sources: sourcesSchema.default([]),
  })
  .strict();
export type SourceFormValue = {
  provider: string;
  sourceType: string;
  url: string;
  checkedDate?: string;
  notes?: string | null;
};

export function sourcesFromForm(form: FormData) {
  const raw = form.get("sources");
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      "Source links could not be read. Refresh the form and try again.",
    );
  }
}
export function lineupFromForm(form: FormData) {
  return {
    franchiseId: form.get("franchiseId"),
    name: form.get("name"),
    japaneseName: form.get("japaneseName"),
    description: form.get("description"),
    manufacturer: form.get("manufacturer"),
    announcedDate: form.get("announcedDate"),
    releaseDate: form.get("releaseDate"),
    status: form.get("status"),
    mainImageStorageKey:
      form.get("removeImage") === "on"
        ? null
        : String(form.get("imageUrl") || form.get("currentImage") || "") ||
          null,
    sources: sourcesFromForm(form),
  };
}
