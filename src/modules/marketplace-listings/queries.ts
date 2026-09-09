import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { MarketplaceListingStatus } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";

const filtersSchema = z.object({
  item: z.uuid().optional().catch(undefined),
  status: z.enum(MarketplaceListingStatus).optional().catch(undefined),
  q: z.string().trim().max(200).catch(""),
  page: z.coerce.number().int().min(1).max(1000000).catch(1),
});
const include = {
  purchaseItem: {
    select: { purchaseId: true, purchase: { select: { status: true } } },
  },
} satisfies Prisma.MarketplaceListingInclude;
export function createMarketplaceListingQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    list: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const filters = filtersSchema.parse(input),
          size = 24;
        const where: Prisma.MarketplaceListingWhereInput = {
          merchandiseItemId: filters.item,
          status: filters.status,
          ...(filters.q
            ? {
                OR: ["marketplace", "sellerName", "externalListingId"].map(
                  (field) => ({
                    [field]: { contains: filters.q, mode: "insensitive" },
                  }),
                ),
              }
            : {}),
        };
        const total = await tx.marketplaceListing.count({ where }),
          pageCount = Math.max(1, Math.ceil(total / size));
        filters.page = Math.min(filters.page, pageCount);
        const items = await tx.marketplaceListing.findMany({
          where,
          include,
          orderBy: [{ discoveredAt: "desc" }, { id: "desc" }],
          take: size,
          skip: (filters.page - 1) * size,
        });
        return { items, filters, size, pageCount, total };
      }),
    detail: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const id = z.uuid().safeParse(input);
        if (!id.success) return null;
        return tx.marketplaceListing.findUnique({
          where: { id: id.data },
          include: { ...include, createdBy: { select: { name: true } } },
        });
      }),
  };
}
