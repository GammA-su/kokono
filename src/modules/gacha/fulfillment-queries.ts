import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { GachaRewardStatus } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { locationPaths } from "../locations/queries";
const include = {
  customer: { select: { id: true, email: true, displayName: true } },
  merchandiseItem: {
    select: {
      id: true,
      name: true,
      japaneseName: true,
      internalSku: true,
      images: {
        orderBy: { displayOrder: "asc" as const },
        take: 1,
        select: { storageKey: true },
      },
    },
  },
  pull: {
    select: { id: true, bannerId: true, banner: { select: { name: true } } },
  },
  fulfillment: { include: { shipment: true } },
  reservation: true,
} as const;
export function createRewardFulfillmentQueries(
  db: PrismaClient,
  authorize: Authorize,
) {
  return {
    list: (raw: unknown) =>
      withInternalTransaction(
        db,
        authorize,
        async (tx) => {
          const input = z
            .object({
              q: z.string().trim().max(100).catch(""),
              status: z.enum(GachaRewardStatus).catch("AWARDED"),
              page: z.coerce.number().int().min(1).catch(1),
            })
            .parse(raw);
          const where = {
            status: input.status,
            ...(input.q
              ? {
                  OR: [
                    {
                      customer: {
                        email: {
                          contains: input.q,
                          mode: "insensitive" as const,
                        },
                      },
                    },
                    {
                      merchandiseItem: {
                        name: {
                          contains: input.q,
                          mode: "insensitive" as const,
                        },
                      },
                    },
                    {
                      merchandiseItem: {
                        internalSku: {
                          contains: input.q,
                          mode: "insensitive" as const,
                        },
                      },
                    },
                  ],
                }
              : {}),
          };
          const groups = await tx.gachaReward.groupBy({
            by: ["status"],
            _count: true,
          });
          const total = await tx.gachaReward.count({ where }),
            size = 30,
            pageCount = Math.max(1, Math.ceil(total / size)),
            page = Math.min(input.page, pageCount);
          const items = await tx.gachaReward.findMany({
            where,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            skip: (page - 1) * size,
            take: size,
            include,
          });
          return {
            items,
            counts: Object.fromEntries(groups.map((g) => [g.status, g._count])),
            total,
            size,
            pageCount,
            filters: { ...input, page },
          };
        },
        { isolationLevel: "RepeatableRead" },
      ),
    detail: (id: string) =>
      withInternalTransaction(db, authorize, async (tx) => {
        const reward = await tx.gachaReward.findUnique({
          where: { id: z.uuid().parse(id) },
          include,
        });
        if (!reward) return null;
        const locations = await locationPaths(tx);
        const events = await tx.gachaEvent.findMany({
          where: { pullId: reward.pullId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            type: true,
            note: true,
            createdAt: true,
            actorUser: { select: { name: true } },
            customerId: true,
          },
        });
        return { reward, locations, events };
      }),
  };
}
