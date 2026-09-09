import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { PurchaseStatus } from "../../generated/prisma/enums";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import { applyInventoryOperationInTransaction } from "../inventory/operations";
import { locationPaths } from "../locations/queries";
import { DomainError } from "../shared/errors";
import {
  purchaseInput,
  purchaseTotals,
  receiptInput,
  transitions,
} from "./validation";

async function lockPurchase(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM purchases WHERE id = ${id}::uuid FOR UPDATE`;
  const purchase = await tx.purchase.findUnique({
    where: { id },
    include: { items: { orderBy: { position: "asc" } } },
  });
  if (!purchase) throw new DomainError("NOT_FOUND", "Purchase not found.");
  return purchase;
}

async function validateItems(
  tx: Prisma.TransactionClient,
  items: { merchandiseItemId: string }[],
) {
  const ids = [...new Set(items.map((item) => item.merchandiseItemId))];
  const count = await tx.merchandiseItem.count({
    where: {
      id: { in: ids },
      archivedAt: null,
      lineup: { archivedAt: null, franchise: { archivedAt: null } },
    },
  });
  if (count !== ids.length)
    throw new DomainError(
      "INVALID_ITEM",
      "Choose existing, unarchived merchandise for every purchase line.",
    );
}

/** Internal composition entry point. Caller must authorize inside this transaction. */
export async function createPurchaseInTransaction(
  tx: Prisma.TransactionClient,
  input: unknown,
  actorId: string,
) {
  const parsed = purchaseInput.parse(input);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ parsed, actorId }))
    .digest("hex");
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`purchase:${parsed.id}`},0))::text`;
  const existing = await tx.purchase.findUnique({
    where: { id: parsed.id },
    include: { items: true },
  });
  if (existing) {
    if (existing.creationFingerprint !== fingerprint)
      throw new DomainError(
        "CONFLICT",
        "This creation key has already been used for another purchase.",
      );
    return existing;
  }
  await validateItems(tx, parsed.items);
  const { items, purchaseDate, ...data } = parsed;
  return tx.purchase.create({
    data: {
      ...data,
      purchaseDate: new Date(purchaseDate),
      subtotalAmount: purchaseTotals(parsed).subtotalAmount,
      creationFingerprint: fingerprint,
      createdByUserId: actorId,
      items: {
        create: items.map((item, position) => ({ ...item, position })),
      },
    },
    include: { items: true },
  });
}

export function createPurchaseService(
  database: PrismaClient,
  authorize: Authorize,
) {
  async function run<T>(
    operation: (tx: Prisma.TransactionClient, actorId: string) => Promise<T>,
  ) {
    const actor = await authorize();
    return database.$transaction(
      async (tx) => {
        await assertInternalAccount(tx, actor.id);
        return operation(tx, actor.id);
      },
      { maxWait: 10000, timeout: 30000 },
    );
  }
  return {
    create: (input: unknown) =>
      run(async (tx, actorId) => {
        return createPurchaseInTransaction(tx, input, actorId);
      }),
    updateDraft: (input: unknown, version: unknown) =>
      run(async (tx) => {
        const parsed = purchaseInput.parse(input);
        const current = await lockPurchase(tx, parsed.id);
        if (
          current.status !== "DRAFT" ||
          current.items.some((item) => item.receivedMovementId)
        )
          throw new DomainError(
            "LOCKED",
            "Only unreceived draft purchases can be edited.",
          );
        if (current.updatedAt.toISOString() !== z.iso.datetime().parse(version))
          throw new DomainError(
            "CONFLICT",
            "This draft changed. Reload before editing.",
          );
        await validateItems(tx, parsed.items);
        const { items, purchaseDate, ...data } = parsed;
        await tx.purchaseItem.deleteMany({ where: { purchaseId: current.id } });
        return tx.purchase.update({
          where: { id: current.id },
          data: {
            ...data,
            purchaseDate: new Date(purchaseDate),
            subtotalAmount: purchaseTotals(parsed).subtotalAmount,
            items: {
              create: items.map((item, position) => ({ ...item, position })),
            },
          },
          include: { items: true },
        });
      }),
    setStatus: (idInput: unknown, statusInput: unknown) =>
      run(async (tx) => {
        const id = z.uuid().parse(idInput),
          status = z.enum(PurchaseStatus).parse(statusInput);
        const current = await lockPurchase(tx, id);
        if (current.status === status) return current;
        if (!transitions[current.status].includes(status))
          throw new DomainError(
            "INVALID_STATUS",
            "This status transition is not allowed.",
          );
        if (
          status === "CANCELLED" &&
          current.items.some((item) => item.receivedMovementId)
        )
          throw new DomainError(
            "ALREADY_RECEIVED",
            "Received purchases cannot be cancelled. Record any stock return separately, and use Refunded if appropriate.",
          );
        return tx.purchase.update({ where: { id }, data: { status } });
      }),
    receive: (input: unknown) =>
      run(async (tx, actorId) => {
        const parsed = receiptInput.parse(input);
        const purchase = await lockPurchase(tx, parsed.purchaseId);
        if (["DRAFT", "CANCELLED", "REFUNDED"].includes(purchase.status))
          throw new DomainError(
            "NOT_RECEIVABLE",
            "Draft, cancelled and refunded purchases cannot receive stock.",
          );
        const selected = [...new Set(parsed.itemIds)].map((id) =>
          purchase.items.find((item) => item.id === id),
        );
        if (selected.some((item) => !item))
          throw new DomainError(
            "INVALID_ITEM",
            "A selected line does not belong to this purchase.",
          );
        // Hold the same hierarchy lock as inventory commands through country resolution and all receipts.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema() || '.storage_locations:hierarchy',0))::text`;
        const location = (await locationPaths(tx)).find(
          (row) => row.id === parsed.destinationLocationId,
        );
        if (!location)
          throw new DomainError(
            "LOCATION_NOT_FOUND",
            "Choose an existing storage location.",
          );
        let received = 0,
          skipped = 0;
        for (const item of selected
          .filter((item) => !!item)
          .sort(
            (a, b) =>
              a.merchandiseItemId.localeCompare(b.merchandiseItemId) ||
              a.id.localeCompare(b.id),
          )) {
          if (item.receivedMovementId) {
            const previous = await tx.inventoryMovement.findUniqueOrThrow({
              where: { id: item.receivedMovementId },
            });
            if (previous.destinationLocationId !== location.id)
              throw new DomainError(
                "RECEIPT_CONFLICT",
                "A selected line was already received elsewhere. Use an inventory transfer to move it.",
              );
            skipped++;
            continue;
          }
          const { movement } = await applyInventoryOperationInTransaction(
            tx,
            {
              merchandiseItemId: item.merchandiseItemId,
              movementType: "PURCHASE",
              quantityDelta: item.quantity,
              destinationLocationId: location.id,
              operationKey: `purchase-item:${item.id}:receive`,
              acquisitionUnitCostAmount: item.unitPriceAmount,
              acquisitionUnitCostCurrency: purchase.currency,
              referenceType: "PURCHASE_ITEM",
              referenceId: item.id,
              notes: parsed.notes,
            },
            actorId,
          );
          await tx.purchaseItem.update({
            where: { id: item.id },
            data: {
              receivedMovementId: movement.id,
              receivedAt: movement.createdAt,
              receivedCountryCode: location.effectiveCountry,
            },
          });
          received++;
        }
        const remaining = await tx.purchaseItem.count({
          where: {
            purchaseId: purchase.id,
            OR: [
              { receivedMovementId: null },
              { receivedCountryCode: null },
              { receivedCountryCode: { not: "JP" } },
            ],
          },
        });
        if (received)
          await tx.purchase.update({
            where: { id: purchase.id },
            data: {
              ...(remaining === 0 ? { status: "RECEIVED_JAPAN" as const } : {}),
              updatedAt: new Date(),
            },
          });
        return { received, skipped };
      }),
  };
}
