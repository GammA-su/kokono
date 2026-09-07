import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { currencyCode, entityId, moneyAmount, optionalText, slug } from "../shared/validation";
import { DomainError } from "../shared/errors";

const listingSchema = z.object({
  merchandiseItemId: entityId, publicTitle: optionalText, slug, publicDescription: optionalText,
  sellingPriceAmount: moneyAmount, sellingPriceCurrency: currencyCode, featured: z.boolean().default(false),
}).strict();

export function createPublicationService(database: PrismaClient, authorize: Authorize) {
  return {
    saveListing: (input: unknown) => withInternalTransaction(database, authorize, (tx) => {
      const data = listingSchema.parse(input);
      return tx.saleListing.upsert({ where: { merchandiseItemId: data.merchandiseItemId }, create: data, update: data });
    }),
    setPublished: (input: unknown) => withInternalTransaction(database, authorize, async (tx) => {
      const { merchandiseItemId, published } = z.object({ merchandiseItemId: entityId, published: z.boolean() }).strict().parse(input);
      if (published) {
        const item = await tx.merchandiseItem.findFirst({ where: {
          id: merchandiseItemId, archivedAt: null, lineup: { archivedAt: null, franchise: { archivedAt: null } },
        }, select: { id: true } });
        if (!item) throw new DomainError("ITEM_UNAVAILABLE", "Archived or missing merchandise cannot be published.");
      }
      // Zero stock is valid. publishedAt records the latest publication and survives unpublishing.
      return tx.saleListing.update({
        where: { merchandiseItemId }, data: { published, ...(published ? { publishedAt: new Date() } : {}) },
      });
    }),
  };
}
