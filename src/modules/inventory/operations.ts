import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import { assertInternalAccount } from "../auth/authorization";
import { DomainError } from "../shared/errors";
import { inventoryOperationSchema } from "./validation";

/** Trusted server/CLI primitive, not a request handler. Null actor is reserved for system seeds/imports. */
export async function applyInventoryOperation(database: PrismaClient, input: unknown, actorUserId: string | null) {
  const operation = inventoryOperationSchema.parse(input);
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify({ ...operation, actorUserId }))
    .digest("hex");

  return database.$transaction(async (tx) => {
    if (actorUserId !== null) await assertInternalAccount(tx, actorUserId);
    // Serialize retries first, including simultaneous uses of a key for different items.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-operation:${operation.operationKey}`}, 0))::text`;
    const existing = await tx.inventoryMovement.findUnique({ where: { operationKey: operation.operationKey } });
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new DomainError("OPERATION_KEY_CONFLICT", "This operation key was already used for a different request.");
      }
      return { movement: existing, replayed: true };
    }

    // Lock the canonical item: this also covers locations with no balance row yet.
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM merchandise_items WHERE id = ${operation.merchandiseItemId}::uuid FOR UPDATE
    `;
    if (!rows.length) throw new DomainError("ITEM_NOT_FOUND", "Merchandise item does not exist.");

    // Archived merchandise can still be reconciled/transferred; archiving never hides owned stock.
    const locationIds = [operation.sourceLocationId, operation.destinationLocationId].filter((id): id is string => id !== null);
    const locations = await tx.storageLocation.findMany({ where: { id: { in: locationIds } }, select: { id: true } });
    if (locations.length !== locationIds.length) throw new DomainError("LOCATION_NOT_FOUND", "A storage location does not exist.");

    // Inactive locations may be emptied, but not receive new stock. Check all destination ancestors.
    if (operation.destinationLocationId) {
      const ancestors = await tx.$queryRaw<{ active: boolean }[]>`
        WITH RECURSIVE path AS (
          SELECT id, parent_id, active FROM storage_locations WHERE id = ${operation.destinationLocationId}::uuid
          UNION ALL
          SELECT parent.id, parent.parent_id, parent.active FROM storage_locations parent JOIN path ON parent.id = path.parent_id
        ) SELECT active FROM path
      `;
      if (ancestors.some((location) => !location.active)) {
        throw new DomainError("INACTIVE_LOCATION", "The destination or an ancestor is inactive.");
      }
    }

    const quantity = Math.abs(operation.quantityDelta);
    if (operation.sourceLocationId) {
      const removed = await tx.inventoryBalance.updateMany({
        where: {
          merchandiseItemId: operation.merchandiseItemId,
          storageLocationId: operation.sourceLocationId,
          quantity: { gte: quantity },
        },
        data: { quantity: { decrement: quantity } },
      });
      if (removed.count !== 1) throw new DomainError("INSUFFICIENT_STOCK", "There is not enough stock at the source location.");
    }
    if (operation.destinationLocationId) {
      const identity = { merchandiseItemId: operation.merchandiseItemId, storageLocationId: operation.destinationLocationId };
      await tx.inventoryBalance.upsert({
        where: { merchandiseItemId_storageLocationId: identity },
        create: { ...identity, quantity },
        update: { quantity: { increment: quantity } },
      });
    }
    const movement = await tx.inventoryMovement.create({ data: { ...operation, requestFingerprint, actorUserId } });
    return { movement, replayed: false };
  }, { maxWait: 10_000, timeout: 20_000 });
}

/** Ownership includes in-transit and inactive locations; hierarchy nodes are not rolled-up balances. */
export async function getOwnedQuantity(database: PrismaClient, merchandiseItemId: string) {
  const total = await database.inventoryBalance.aggregate({ where: { merchandiseItemId }, _sum: { quantity: true } });
  return total._sum.quantity ?? 0;
}

/** Diagnostic only: never repairs history or balances automatically. */
export async function reconcileInventory(database: PrismaClient, merchandiseItemId: string) {
  return database.$queryRaw<{ storageLocationId: string; balance: bigint; ledger: bigint }[]>`
    WITH deltas AS (
      SELECT source_location_id AS location_id, -abs(quantity_delta)::bigint AS delta
      FROM inventory_movements WHERE merchandise_item_id = ${merchandiseItemId}::uuid AND source_location_id IS NOT NULL
      UNION ALL
      SELECT destination_location_id, abs(quantity_delta)::bigint
      FROM inventory_movements WHERE merchandise_item_id = ${merchandiseItemId}::uuid AND destination_location_id IS NOT NULL
    ), ledger AS (SELECT location_id, sum(delta)::bigint AS quantity FROM deltas GROUP BY location_id),
    balances AS (SELECT storage_location_id, quantity FROM inventory_balances WHERE merchandise_item_id = ${merchandiseItemId}::uuid)
    SELECT coalesce(b.storage_location_id, l.location_id)::text AS "storageLocationId",
      coalesce(b.quantity, 0)::bigint AS balance, coalesce(l.quantity, 0)::bigint AS ledger
    FROM balances b FULL JOIN ledger l ON l.location_id = b.storage_location_id
    WHERE coalesce(b.quantity, 0) <> coalesce(l.quantity, 0)
  `;
}
