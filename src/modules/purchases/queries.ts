import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { PurchaseStatus } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";

const filtersSchema = z.object({
  q: z.string().trim().max(200).catch(""),
  status: z.enum(PurchaseStatus).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(1000000).catch(1),
});
export function createPurchaseQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    list: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const filters = filtersSchema.parse(input),
          size = 24;
        const where: Prisma.PurchaseWhereInput = {
          status: filters.status,
          ...(filters.q
            ? {
                OR: ["supplier", "marketplace", "externalReference"].map(
                  (field) => ({
                    [field]: { contains: filters.q, mode: "insensitive" },
                  }),
                ),
              }
            : {}),
        };
        const total = await tx.purchase.count({ where }),
          pageCount = Math.max(1, Math.ceil(total / size));
        filters.page = Math.min(filters.page, pageCount);
        const items = await tx.purchase.findMany({
          where,
          orderBy: [{ purchaseDate: "desc" }, { id: "desc" }],
          skip: (filters.page - 1) * size,
          take: size,
          include: {
            _count: { select: { items: true } },
            items: { select: { quantity: true, receivedMovementId: true } },
          },
        });
        return { items, filters, total, pageCount, size };
      }),
    detail: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const parsed = z.uuid().safeParse(input);
        if (!parsed.success) return null;
        return tx.purchase.findUnique({
          where: { id: parsed.data },
          include: {
            createdBy: { select: { name: true } },
            items: {
              orderBy: { position: "asc" },
              include: {
                marketplaceListing: { select: { id: true } },
                merchandiseItem: {
                  select: { name: true, japaneseName: true, internalSku: true },
                },
                receivedMovement: {
                  include: {
                    destinationLocation: { select: { code: true, name: true } },
                    actorUser: { select: { name: true } },
                  },
                },
              },
            },
          },
        });
      }),
  };
}
