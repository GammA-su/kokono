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
    /**
     * Updates one franchise. The slug is deliberately not editable here: it appears in admin
     * URLs and prior references, and renaming a franchise is far more common than wanting to
     * break those.
     */
    updateFranchise: (
      input: unknown,
      identity: { id: string; updatedAt: string },
    ) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const data = franchiseSchema.omit({ slug: true }).parse(input);
        await tx.$queryRaw`SELECT id FROM franchises WHERE id = ${identity.id}::uuid FOR UPDATE`;
        const current = await tx.franchise.findUnique({
          where: { id: identity.id },
        });
        if (!current)
          throw new DomainError(
            "FRANCHISE_NOT_FOUND",
            "This franchise no longer exists.",
          );
        if (current.updatedAt.toISOString() !== identity.updatedAt)
          throw new DomainError(
            "EDIT_CONFLICT",
            "This franchise changed in another session. Reload before saving to avoid overwriting those changes.",
          );
        return tx.franchise.update({ where: { id: current.id }, data });
      }),

    /**
     * Removes one franchise, archiving instead of deleting when lineups or characters still
     * reference it. Archiving a franchise also hides its merchandise from the storefront, which
     * is why the confirmation names that consequence.
     */
    removeFranchise: (input: unknown, confirmedName: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const id = entityId.parse(input);
        await tx.$queryRaw`SELECT id FROM franchises WHERE id = ${id}::uuid FOR UPDATE`;
        const current = await tx.franchise.findUnique({
          where: { id },
          include: { _count: { select: { lineups: true, characters: true } } },
        });
        if (!current)
          throw new DomainError(
            "FRANCHISE_NOT_FOUND",
            "This franchise no longer exists.",
          );
        if (confirmedName !== current.name)
          throw new DomainError(
            "CONFIRM_NAME",
            "Enter the franchise name exactly to confirm.",
          );
        if (current._count.lineups > 0 || current._count.characters > 0) {
          if (current.archivedAt) return "already-archived" as const;
          await tx.franchise.update({
            where: { id: current.id },
            data: { archivedAt: new Date() },
          });
          return "archived" as const;
        }
        await tx.franchise.delete({ where: { id: current.id } });
        return "deleted" as const;
      }),

    restoreFranchise: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) =>
        tx.franchise.update({
          where: { id: entityId.parse(input) },
          data: { archivedAt: null },
        }),
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

    /**
     * Approves or withdraws one image for public use.
     *
     * Withdrawing approval is refused when it would leave a published listing with no approved
     * image, because storefront visibility requires one: the product would silently vanish from
     * the shop with nothing in the admin explaining why.
     */
    setImageApproval: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const data = z
          .object({ imageId: entityId, approved: z.boolean() })
          .strict()
          .parse(input);
        const image = await tx.itemImage.findUnique({
          where: { id: data.imageId },
          include: { listingImages: { select: { listingId: true } } },
        });
        if (!image)
          throw new DomainError("IMAGE_NOT_FOUND", "This image no longer exists.");
        if (!data.approved && image.approvedForPublicUse)
          for (const { listingId } of image.listingImages) {
            const listing = await tx.saleListing.findUnique({
              where: { id: listingId },
              include: { images: { select: { itemImageId: true } } },
            });
            if (!listing?.published) continue;
            const others = await tx.itemImage.count({
              where: {
                approvedForPublicUse: true,
                id: {
                  in: listing.images.map((row) => row.itemImageId),
                  not: image.id,
                },
              },
            });
            if (!others)
              throw new DomainError(
                "LAST_PUBLIC_IMAGE",
                "This is the only approved image on a published product. Approve another image or unpublish the product first.",
              );
          }
        return tx.itemImage.update({
          where: { id: image.id },
          data: { approvedForPublicUse: data.approved },
        });
      }),

    /**
     * Deletes one image. An image selected by a sale listing is refused rather than cascaded:
     * removing it would change what the storefront shows without the operator revisiting the
     * listing. The stored file is reported back so the caller can unlink it after committing.
     */
    removeImage: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const id = entityId.parse(input);
        const image = await tx.itemImage.findUnique({
          where: { id },
          include: { listingImages: { select: { listingId: true } } },
        });
        if (!image)
          throw new DomainError("IMAGE_NOT_FOUND", "This image no longer exists.");
        if (image.listingImages.length)
          throw new DomainError(
            "IMAGE_IN_USE",
            "This image is selected by a store listing. Remove it from the listing before deleting it.",
          );
        await tx.itemImage.delete({ where: { id: image.id } });
        return { storageKey: image.storageKey };
      }),
    archiveItem: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) => {
        const id = entityId.parse(input);
        // No deletion, stock adjustment, watch change, or automatic publication toggle.
        return tx.merchandiseItem.update({
          where: { id },
          data: { archivedAt: new Date() },
        });
      }),

    /**
     * Creates or updates one catalog item.
     *
     * With `identity` this is an edit, and the caller's `updatedAt` must still match the stored
     * row: two operators editing the same item would otherwise silently overwrite each other.
     * Character links are replaced wholesale because the form submits the complete set; sources,
     * images, stock and publication are edited through their own screens and are untouched here.
     */
    saveItem: (input: unknown, identity?: { id: string; updatedAt: string }) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const { characterIds, ...data } = itemSchema.parse(input);
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
        )
          throw new DomainError(
            "LINEUP_UNAVAILABLE",
            "Choose an active lineup in an active franchise.",
          );
        const links = [...new Set(characterIds)].map((characterId) => ({
          characterId,
        }));
        if (!identity)
          return tx.merchandiseItem.create({
            data: { ...data, characters: { create: links } },
          });
        await tx.$queryRaw`SELECT id FROM merchandise_items WHERE id = ${identity.id}::uuid FOR UPDATE`;
        const current = await tx.merchandiseItem.findUnique({
          where: { id: identity.id },
        });
        if (!current)
          throw new DomainError(
            "ITEM_NOT_FOUND",
            "This merchandise item no longer exists.",
          );
        if (current.updatedAt.toISOString() !== identity.updatedAt)
          throw new DomainError(
            "EDIT_CONFLICT",
            "This item changed in another session. Reload before saving to avoid overwriting those changes.",
          );
        await tx.itemCharacter.deleteMany({
          where: { merchandiseItemId: current.id },
        });
        return tx.merchandiseItem.update({
          where: { id: current.id },
          data: { ...data, characters: { create: links } },
        });
      }),

    /**
     * Removes one catalog item, archiving instead of deleting whenever anything depends on it.
     *
     * An item that has ever been stocked, sold, shipped, purchased, listed or awarded is part of
     * recorded history: deleting it would orphan a ledger entry or an order line, so it is
     * archived and stays queryable. Only an item with no such history is genuinely removable,
     * and then its own sources, images and watch go with it. Typing the name is required because
     * this is the one catalog action that can destroy data.
     */
    removeItem: (input: unknown, confirmedName: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const id = entityId.parse(input);
        await tx.$queryRaw`SELECT id FROM merchandise_items WHERE id = ${id}::uuid FOR UPDATE`;
        const current = await tx.merchandiseItem.findUnique({
          where: { id },
          include: {
            _count: {
              select: {
                inventoryMovements: true,
                inventoryBalances: true,
                orderItems: true,
                reservations: true,
                gachaRewards: true,
                gachaPrizes: true,
                purchaseItems: true,
                shipmentItems: true,
                marketplaceListings: true,
                images: true,
              },
            },
            saleListing: { select: { id: true } },
          },
        });
        if (!current)
          throw new DomainError(
            "ITEM_NOT_FOUND",
            "This merchandise item no longer exists.",
          );
        if (confirmedName !== current.name)
          throw new DomainError(
            "CONFIRM_NAME",
            "Enter the item name exactly to confirm.",
          );
        const counts = current._count;
        const history =
          counts.inventoryMovements +
          counts.inventoryBalances +
          counts.orderItems +
          counts.reservations +
          counts.gachaRewards +
          counts.gachaPrizes +
          counts.purchaseItems +
          counts.shipmentItems +
          counts.marketplaceListings +
          (current.saleListing ? 1 : 0);
        if (history > 0) {
          if (current.archivedAt) return "already-archived" as const;
          await tx.merchandiseItem.update({
            where: { id: current.id },
            data: { archivedAt: new Date() },
          });
          return "archived" as const;
        }
        // Owned records only. Managed image files are removed after the transaction commits,
        // so a rolled-back delete can never leave the catalog pointing at a missing file.
        const images = await tx.itemImage.findMany({
          where: { merchandiseItemId: current.id },
          select: { storageKey: true },
        });
        await tx.itemCharacter.deleteMany({
          where: { merchandiseItemId: current.id },
        });
        await tx.itemSource.deleteMany({
          where: { merchandiseItemId: current.id },
        });
        await tx.itemImage.deleteMany({
          where: { merchandiseItemId: current.id },
        });
        await tx.purchaseWatch.deleteMany({
          where: { merchandiseItemId: current.id },
        });
        await tx.merchandiseItem.delete({ where: { id: current.id } });
        return {
          outcome: "deleted" as const,
          storageKeys: images.map((image) => image.storageKey),
        };
      }),

    restoreItem: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const id = entityId.parse(input);
        const current = await tx.merchandiseItem.findUnique({
          where: { id },
          select: { id: true, lineup: { select: { archivedAt: true } } },
        });
        if (!current)
          throw new DomainError(
            "ITEM_NOT_FOUND",
            "This merchandise item no longer exists.",
          );
        // Restoring into an archived lineup would produce an item that cannot be edited again.
        if (current.lineup.archivedAt)
          throw new DomainError(
            "LINEUP_UNAVAILABLE",
            "Restore the lineup before restoring this item.",
          );
        return tx.merchandiseItem.update({
          where: { id: current.id },
          data: { archivedAt: null },
        });
      }),
  };
}
