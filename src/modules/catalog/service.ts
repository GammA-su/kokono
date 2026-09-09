import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  ImageRole,
  LineupStatus,
  SourceType,
  TaxInclusion,
  WatchPriority,
} from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import {
  currencyCode,
  entityId,
  moneyAmount,
  name,
  optionalText,
  slug,
} from "../shared/validation";
import { parsePartialDate } from "./partial-date";
import { sourcesSchema } from "../lineups/validation";
import { DomainError } from "../shared/errors";

const names = { name, japaneseName: optionalText };
const aliases = z.array(name).max(100).default([]);
const dateText = z.string().nullable().default(null);
const franchiseSchema = z
  .object({
    ...names,
    slug,
    aliases,
    description: optionalText,
    imageStorageKey: optionalText,
  })
  .strict();
const characterSchema = z
  .object({
    ...names,
    franchiseId: entityId,
    aliases,
    imageStorageKey: optionalText,
  })
  .strict();
const categorySchema = z
  .object({ name, slug, parentId: entityId.nullable().optional() })
  .strict();
const lineupSchema = z
  .object({
    ...names,
    franchiseId: entityId,
    slug,
    description: optionalText,
    manufacturer: optionalText,
    announcedDate: dateText,
    releaseDate: dateText,
    status: z.enum(LineupStatus).default("UNKNOWN"),
    mainImageStorageKey: optionalText,
    notes: optionalText,
  })
  .strict();
const itemSchema = z
  .object({
    ...names,
    lineupId: entityId,
    categoryId: entityId,
    internalSku: name,
    janCode: z
      .string()
      .regex(/^\d{8}(?:\d{5})?$/)
      .nullable()
      .optional(),
    slug,
    aliases,
    description: optionalText,
    manufacturer: optionalText,
    privateNotes: optionalText,
    officialMsrpAmount: moneyAmount.nullable().default(null),
    officialMsrpCurrency: currencyCode.nullable().default(null),
    officialMsrpTaxInclusion: z.enum(TaxInclusion).default("UNKNOWN"),
    characterIds: z.array(entityId).default([]),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      (data.officialMsrpAmount === null) !==
      (data.officialMsrpCurrency === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "MSRP amount and currency must be supplied together.",
      });
    }
    if (
      data.officialMsrpAmount === null &&
      data.officialMsrpTaxInclusion !== "UNKNOWN"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Tax inclusion requires an MSRP.",
      });
    }
  });
const watchSchema = z
  .object({
    merchandiseItemId: entityId,
    enabled: z.boolean().default(true),
    targetQuantity: z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .nullable()
      .default(null),
    maxUnitPriceAmount: moneyAmount.nullable().default(null),
    maxUnitPriceCurrency: currencyCode.default("JPY"),
    priority: z.enum(WatchPriority).default("NORMAL"),
    conditionPreference: optionalText,
    marketplaceSearchQuery: optionalText,
    notes: optionalText,
  })
  .strict();
const sourceSchema = z
  .object({
    merchandiseItemId: entityId,
    provider: name,
    sourceType: z.enum(SourceType).default("OTHER"),
    url: z.url({ protocol: /^https?$/ }),
    notes: optionalText,
  })
  .strict();
const imageSchema = z
  .object({
    merchandiseItemId: entityId,
    storageKey: name,
    originalUrl: z
      .url({ protocol: /^https?$/ })
      .nullable()
      .optional(),
    sourceUrl: z
      .url({ protocol: /^https?$/ })
      .nullable()
      .optional(),
    sourceProvider: optionalText,
    imageRole: z.enum(ImageRole).default("PRODUCT"),
    caption: optionalText,
    displayOrder: z.number().int().nonnegative().max(2_147_483_647).default(0),
    approvedForPublicUse: z.boolean().default(false),
  })
  .strict();

export function createCatalogService(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    setCategory: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const data = z
          .object({ merchandiseItemId: entityId, categoryId: entityId })
          .strict()
          .parse(input);
        if (!(await tx.category.findUnique({ where: { id: data.categoryId } })))
          throw new DomainError(
            "CATEGORY_NOT_FOUND",
            "Choose an existing category.",
          );
        return tx.merchandiseItem.update({
          where: { id: data.merchandiseItemId },
          data: { categoryId: data.categoryId },
        });
      }),
    disablePurchaseWatch: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) =>
        tx.purchaseWatch.updateMany({
          where: { merchandiseItemId: entityId.parse(input), enabled: true },
          data: { enabled: false },
        }),
      ),
    markPurchaseWatchChecked: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) =>
        tx.purchaseWatch.update({
          where: { merchandiseItemId: entityId.parse(input) },
          data: { lastCheckedAt: new Date() },
        }),
      ),
    createFranchise: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) =>
        tx.franchise.create({ data: franchiseSchema.parse(input) }),
      ),
    createCharacter: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) =>
        tx.character.create({ data: characterSchema.parse(input) }),
      ),
    createCategory: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) =>
        tx.category.create({ data: categorySchema.parse(input) }),
      ),
    createLineup: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) => {
        const { announcedDate, releaseDate, ...data } =
          lineupSchema.parse(input);
        const announced = announcedDate
          ? parsePartialDate(announcedDate)
          : null;
        const release = releaseDate ? parsePartialDate(releaseDate) : null;
        return tx.lineup.create({
          data: {
            ...data,
            announcedDate: announced?.date,
            announcedDatePrecision: announced?.precision,
            releaseDate: release?.date,
            releaseDatePrecision: release?.precision,
          },
        });
      }),
    createItem: (input: unknown, sourcesInput: unknown = []) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const { characterIds, ...data } = itemSchema.parse(input);
        const sources = sourcesSchema.parse(sourcesInput);
        await tx.$queryRaw`SELECT id FROM lineups WHERE id = ${data.lineupId}::uuid FOR SHARE`;
        if (
          !(await tx.lineup.findFirst({
            where: {
              id: data.lineupId,
              archivedAt: null,
              franchise: { archivedAt: null },
            },
            select: { id: true },
          }))
        ) {
          throw new DomainError(
            "LINEUP_UNAVAILABLE",
            "Choose an active lineup in an active franchise.",
          );
        }
        return tx.merchandiseItem.create({
          data: {
            ...data,
            characters: {
              create: [...new Set(characterIds)].map((characterId) => ({
                characterId,
              })),
            },
            sources: {
              create: sources.map(({ checkedDate, ...source }) => ({
                ...source,
                checkedAt: checkedDate,
              })),
            },
          },
        });
      }),
    savePurchaseWatch: (input: unknown, expectedVersion?: string | null) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const data = watchSchema.parse(input);
        await tx.$queryRaw`SELECT id FROM merchandise_items WHERE id = ${data.merchandiseItemId}::uuid FOR UPDATE`;
        if (expectedVersion !== undefined) {
          const current = await tx.$queryRaw<
            { updatedAt: Date }[]
          >`SELECT updated_at AS "updatedAt" FROM purchase_watches WHERE merchandise_item_id = ${data.merchandiseItemId}::uuid FOR UPDATE`;
          if ((current[0]?.updatedAt.toISOString() ?? null) !== expectedVersion)
            throw new DomainError(
              "EDIT_CONFLICT",
              "This watch changed after the form was opened. Reload before saving to avoid overwriting newer sourcing data.",
            );
        }
        return tx.purchaseWatch.upsert({
          where: { merchandiseItemId: data.merchandiseItemId },
          create: data,
          // Shared bulk defaults must not erase unmentioned sourcing notes/search text.
          update: Object.fromEntries(
            Object.entries(data).filter(([key]) =>
              Object.hasOwn(input as object, key),
            ),
          ),
        });
      }),
    addSource: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) =>
        tx.itemSource.create({ data: sourceSchema.parse(input) }),
      ),
    addImage: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) =>
        tx.itemImage.create({ data: imageSchema.parse(input) }),
      ),
    archiveItem: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) => {
        const id = entityId.parse(input);
        // No deletion, stock adjustment, watch change, or automatic publication toggle.
        return tx.merchandiseItem.update({
          where: { id },
          data: { archivedAt: new Date() },
        });
      }),
  };
}
