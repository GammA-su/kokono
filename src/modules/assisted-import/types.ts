import { z } from "zod";
import { SourceType, TaxInclusion } from "../../generated/prisma/enums";
const text = z.string().max(2048);
export const candidateSchema = z
  .object({
    key: z.uuid(),
    name: text,
    japaneseName: text,
    characterNames: z.array(text).max(50),
    characterIds: z.array(z.uuid()).max(50),
    categoryTerm: text,
    categoryId: z.string().max(100),
    officialMsrpAmount: text,
    officialMsrpCurrency: text,
    officialMsrpTaxInclusion: z.enum(TaxInclusion),
    janCode: text,
    releaseDate: text,
    releaseDatePrecision: z.enum(["", "YEAR", "MONTH", "DAY"]),
    manufacturer: text,
    images: z
      .array(z.object({ url: text, sourceUrl: text, provider: text }).strict())
      .max(8),
    sources: z
      .array(
        z
          .object({ provider: text, sourceType: z.enum(SourceType), url: text })
          .strict(),
      )
      .min(1)
      .max(10),
    warnings: z.array(z.string().max(4000)).max(30),
    confidence: z.enum(["structured", "low"]),
  })
  .strict();
export type Candidate = z.infer<typeof candidateSchema>;
export type SourcePage = {
  html: string;
  url: string;
  provider: string;
  sourceType: z.infer<typeof candidateSchema>["sources"][number]["sourceType"];
};
export type SourceAdapter = {
  id: string;
  label: string;
  supports: (url: URL) => boolean;
  extract: (page: SourcePage) => Candidate[];
};
