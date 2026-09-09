import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { OrderStatus, OrderPaymentStatus } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { locationPaths } from "../locations/queries";
import { orderInclude } from "./projections";
export function createOrderQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    list: (raw: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const input = z
          .object({
            q: z.string().trim().max(100).catch(""),
            status: z.enum(OrderStatus).optional().catch(undefined),
            payment: z.enum(OrderPaymentStatus).optional().catch(undefined),
            page: z.coerce.number().int().min(1).max(100000).catch(1),
          })
          .parse(raw);
        const where: Prisma.OrderWhereInput = {
          ...(input.q
            ? { number: { contains: input.q, mode: "insensitive" } }
            : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.payment ? { paymentStatus: input.payment } : {}),
        };
        const total = await tx.order.count({ where }),
          size = 30,
          pageCount = Math.max(1, Math.ceil(total / size)),
          page = Math.min(input.page, pageCount);
        const items = await tx.order.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          skip: (page - 1) * size,
          take: size,
          select: {
            id: true,
            number: true,
            status: true,
            paymentStatus: true,
            currency: true,
            totalAmount: true,
            createdAt: true,
            expiresAt: true,
            _count: { select: { items: true } },
          },
        });
        return { items, total, size, pageCount, filters: { ...input, page } };
      }),
    detail: (raw: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const id = z.uuid().parse(raw),
          order = await tx.order.findUnique({
            where: { id },
            include: {
              ...orderInclude,
              items: {
                orderBy: { id: "asc" },
                include: {
                  reservations: true,
                  merchandiseItem: {
                    select: { name: true, internalSku: true },
                  },
                },
              },
              paymentAttempt: {
                include: {
                  events: { orderBy: { createdAt: "desc" }, take: 100 },
                },
              },
              events: {
                orderBy: { createdAt: "desc" },
                take: 100,
                include: { actorUser: { select: { name: true } } },
              },
            },
          });
        if (!order) return null;
        const locations = await locationPaths(tx);
        return { order, locations };
      }),
  };
}
