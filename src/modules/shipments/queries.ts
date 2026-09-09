import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { ShipmentStatus } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
const filtersSchema = z.object({
  q: z.string().trim().max(200).catch(""),
  status: z.enum(ShipmentStatus).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(1000000).catch(1),
});
export function createShipmentQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    list: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const filters = filtersSchema.parse(input),
          size = 24;
        const matched = /^(?:JP-)?(\d+)$/i.exec(filters.q),
          number = matched ? Number(matched[1]) : null;
        const where: Prisma.ShipmentWhereInput = {
          status: filters.status,
          ...(filters.q
            ? {
                OR: [
                  ...(["carrier", "trackingNumber"] as const).map((field) => ({
                    [field]: {
                      contains: filters.q,
                      mode: "insensitive" as const,
                    },
                  })),
                  ...(number !== null && number <= 2147483647
                    ? [{ number }]
                    : []),
                ],
              }
            : {}),
        };
        const total = await tx.shipment.count({ where }),
          pageCount = Math.max(1, Math.ceil(total / size));
        filters.page = Math.min(filters.page, pageCount);
        const items = await tx.shipment.findMany({
          where,
          orderBy: { number: "desc" },
          skip: (filters.page - 1) * size,
          take: size,
          include: {
            originLocation: { select: { code: true } },
            destinationLocation: { select: { code: true } },
            _count: { select: { items: true } },
          },
        });
        return { items, filters, size, total, pageCount };
      }),
    detail: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const id = z.uuid().safeParse(input);
        if (!id.success) return null;
        const shipment = await tx.shipment.findUnique({
          where: { id: id.data },
          include: {
            createdBy: { select: { name: true } },
            items: {
              orderBy: { merchandiseItem: { name: "asc" } },
              include: {
                merchandiseItem: {
                  select: { name: true, japaneseName: true, internalSku: true },
                },
                dispatchMovement: {
                  include: { actorUser: { select: { name: true } } },
                },
                deliveryMovement: {
                  include: { actorUser: { select: { name: true } } },
                },
              },
            },
          },
        });
        return shipment
          ? {
              ...shipment,
              totalWeight: shipment.totalWeight?.toString() ?? null,
            }
          : null;
      }),
  };
}
