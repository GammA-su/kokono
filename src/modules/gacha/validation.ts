import { z } from "zod";
export const gachaPolicy = () => ({
  drawsEnabled: process.env.GACHA_DRAWS_ENABLED !== "false",
  paidDrawsEnabled: false as const,
  mode: "ADMIN_GRANTED" as const,
});
export const bannerInput = z
  .object({
    id: z.uuid().optional(),
    expectedConfigurationId: z.uuid().nullable().default(null),
    name: z.string().trim().min(1).max(200),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(180),
    description: z.string().trim().max(10000).default(""),
    startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
    endsAt: z.iso.datetime({ offset: true }).nullable().default(null),
    active: z.boolean().default(false),
    paidEnabled: z.literal(false).default(false),
    pullPriceAmount: z
      .number()
      .int()
      .min(0)
      .max(2147483647)
      .nullable()
      .default(null),
    currency: z.enum(["EUR", "JPY", "USD", "GBP"]).default("EUR"),
    terms: z.string().trim().min(1).max(20000),
    termsVersion: z.string().trim().min(1).max(100),
    prizes: z
      .array(
        z
          .object({
            merchandiseItemId: z.uuid(),
            tier: z.string().trim().min(1).max(100),
            weight: z.number().int().min(1).max(1000000),
            allocation: z.number().int().min(1).max(2000),
            displayName: z.string().trim().min(1).max(200),
            description: z.string().trim().max(2000).default(""),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.startsAt &&
      input.endsAt &&
      new Date(input.startsAt) >= new Date(input.endsAt)
    )
      ctx.addIssue({ code: "custom", message: "End must be after start." });
    if (
      new Set(input.prizes.map((p) => p.merchandiseItemId)).size !==
      input.prizes.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Each merchandise item may appear once per pool.",
      });
    if (input.prizes.reduce((n, p) => n + p.allocation, 0) > 2000)
      ctx.addIssue({
        code: "custom",
        message: "Reserve at most 2,000 physical units per configuration.",
      });
  });
export const grantInput = z
  .object({
    bannerId: z.uuid(),
    configurationId: z.uuid(),
    operationKey: z.uuid(),
    customerReference: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(2000),
    mode: z.literal("ADMIN_GRANTED").default("ADMIN_GRANTED"),
  })
  .strict();
