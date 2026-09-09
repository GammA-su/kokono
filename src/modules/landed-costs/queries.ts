import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import type { CostPreview } from "./validation";
import { assignedRanges } from "./service";
export type LandedEstimate = {
  itemId: string;
  calculationId: string;
  shipmentId: string;
  currency: string;
  totalAmount: string;
  quantity: number;
  createdAt: string;
};
export function createLandedCostQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    inputs: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const parsed = z.uuid().safeParse(input);
        if (!parsed.success) return null;
        const id = parsed.data,
          settings = await tx.landedCostSettings.findUnique({
            where: { id: "global" },
          });
        const shipment = await tx.shipment.findUnique({
          where: { id },
          include: {
            items: {
              orderBy: { id: "asc" },
              include: { merchandiseItem: { select: { name: true } } },
            },
          },
        });
        if (!shipment) return null;
        const batches = await tx.purchaseItem.findMany({
          where: {
            merchandiseItemId: {
              in: shipment.items.map((item) => item.merchandiseItemId),
            },
            receivedMovementId: { not: null },
            purchase: { status: { notIn: ["DRAFT", "CANCELLED", "REFUNDED"] } },
          },
          orderBy: [
            { purchase: { purchaseDate: "desc" } },
            { position: "asc" },
            { id: "asc" },
          ],
          select: {
            id: true,
            merchandiseItemId: true,
            quantity: true,
            position: true,
            unitPriceAmount: true,
            purchase: {
              select: {
                id: true,
                supplier: true,
                externalReference: true,
                currency: true,
                purchaseDate: true,
              },
            },
          },
        });
        const history = await tx.landedCostCalculation.findMany({
          where: { shipmentId: id },
          orderBy: { revision: "desc" },
          select: {
            id: true,
            revision: true,
            method: true,
            currency: true,
            totalAmount: true,
            createdAt: true,
          },
        });
        const usedRanges = await assignedRanges(
          tx,
          id,
          batches.map((batch) => batch.id),
        );
        const previous = history[0]
          ? await tx.landedCostCalculation.findUnique({
              where: { id: history[0].id },
              select: { snapshot: true },
            })
          : null;
        return {
          usedRanges,
          previous: previous?.snapshot as unknown as CostPreview | null,
          shipment: {
            ...shipment,
            totalWeight: shipment.totalWeight?.toString() ?? null,
          },
          settings,
          batches,
          history: history.map((row) => ({
            ...row,
            totalAmount: row.totalAmount.toString(),
          })),
        };
      }),
    detail: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const id = z.uuid().safeParse(input);
        if (!id.success) return null;
        const calculation = await tx.landedCostCalculation.findUnique({
          where: { id: id.data },
          select: {
            id: true,
            shipmentId: true,
            revision: true,
            createdAt: true,
            createdBy: { select: { name: true } },
            snapshot: true,
          },
        });
        return calculation
          ? {
              ...calculation,
              snapshot: calculation.snapshot as unknown as CostPreview,
            }
          : null;
      }),
    estimates: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const ids = z.array(z.uuid()).max(1000).parse(input);
        if (!ids.length) return [] as LandedEstimate[];
        const rows = await tx.$queryRaw<
          (Omit<LandedEstimate, "createdAt"> & { createdAt: Date })[]
        >`
        WITH latest AS (SELECT DISTINCT ON (shipment_id) id,shipment_id,currency,created_at FROM landed_cost_calculations ORDER BY shipment_id,revision DESC),
        batches AS (SELECT s.merchandise_item_id,l.calculation_id,c.shipment_id,c.currency,c.created_at,
          SUM(l.total_amount)::text AS total,SUM(l.quantity)::int AS quantity
          FROM landed_cost_lines l JOIN latest c ON c.id=l.calculation_id JOIN shipment_items s ON s.id=l.shipment_item_id
          WHERE s.merchandise_item_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
          GROUP BY s.merchandise_item_id,l.calculation_id,c.shipment_id,c.currency,c.created_at)
        SELECT DISTINCT ON (merchandise_item_id) merchandise_item_id::text AS "itemId",calculation_id::text AS "calculationId",shipment_id::text AS "shipmentId",currency,total AS "totalAmount",quantity,created_at AS "createdAt"
        FROM batches ORDER BY merchandise_item_id,created_at DESC,calculation_id DESC`;
        return rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
  };
}
