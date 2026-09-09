import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { ShipmentStatus } from "../../generated/prisma/enums";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import { applyInventoryOperationInTransaction } from "../inventory/operations";
import { createLocationInTransaction } from "../locations/service";
import { locationPaths } from "../locations/queries";
import { DomainError } from "../shared/errors";
import {
  deliverInput,
  preparationStatuses,
  shipmentInput,
  shipmentNumber,
  shipInput,
  statusTransitions,
} from "./validation";

async function lockShipment(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM shipments WHERE id=${id}::uuid FOR UPDATE`;
  const shipment = await tx.shipment.findUnique({
    where: { id },
    include: { items: { orderBy: { merchandiseItemId: "asc" } } },
  });
  if (!shipment) throw new DomainError("NOT_FOUND", "Shipment not found.");
  return shipment;
}
async function validateRoute(
  tx: Prisma.TransactionClient,
  input: {
    originLocationId: string;
    destinationLocationId: string;
    transitParentId: string;
  },
) {
  const paths = await locationPaths(tx);
  const origin = paths.find((row) => row.id === input.originLocationId),
    destination = paths.find((row) => row.id === input.destinationLocationId),
    transit = paths.find((row) => row.id === input.transitParentId);
  if (
    !origin?.effectiveActive ||
    origin.effectiveCountry !== "JP" ||
    origin.inTransit
  )
    throw new DomainError(
      "INVALID_ORIGIN",
      "Choose an active physical Japan location as origin.",
    );
  if (
    !destination?.effectiveActive ||
    destination.effectiveCountry !== "FR" ||
    destination.inTransit
  )
    throw new DomainError(
      "INVALID_DESTINATION",
      "Choose an active physical France location as destination.",
    );
  if (!transit?.effectiveActive || !transit.inTransit)
    throw new DomainError(
      "INVALID_TRANSIT",
      "Choose an active in-transit location.",
    );
}
async function validateStock(
  tx: Prisma.TransactionClient,
  originLocationId: string,
  items: { merchandiseItemId: string; quantity: number }[],
) {
  const balances = await tx.inventoryBalance.findMany({
    where: {
      storageLocationId: originLocationId,
      merchandiseItemId: { in: items.map((item) => item.merchandiseItemId) },
    },
  });
  const byItem = new Map(
    balances.map((row) => [row.merchandiseItemId, row.quantity]),
  );
  for (const item of items)
    if ((byItem.get(item.merchandiseItemId) || 0) < item.quantity)
      throw new DomainError(
        "INSUFFICIENT_STOCK",
        `Insufficient origin stock for merchandise ${item.merchandiseItemId}: ${byItem.get(item.merchandiseItemId) || 0} available, ${item.quantity} requested.`,
      );
}
export function createShipmentService(
  database: PrismaClient,
  authorize: Authorize,
) {
  async function run<T>(
    operation: (tx: Prisma.TransactionClient, actorId: string) => Promise<T>,
    createLocation = false,
  ) {
    const actor = await authorize();
    return database.$transaction(
      async (tx) => {
        await assertInternalAccount(tx, actor.id);
        // Location creation requires exclusive hierarchy access. Take it BEFORE shipment/item locks.
        if (createLocation)
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || '.storage_locations:hierarchy',0))::text`;
        else
          await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema() || '.storage_locations:hierarchy',0))::text`;
        return operation(tx, actor.id);
      },
      { maxWait: 10000, timeout: 30000 },
    );
  }
  return {
    create: (input: unknown) =>
      run(async (tx, actorId) => {
        const parsed = shipmentInput.parse(input);
        const fingerprint = createHash("sha256")
          .update(JSON.stringify({ parsed, actorId }))
          .digest("hex");
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shipment:${parsed.id}`},0))::text`;
        const existing = await tx.shipment.findUnique({
          where: { id: parsed.id },
          include: { items: true },
        });
        if (existing) {
          if (existing.creationFingerprint !== fingerprint)
            throw new DomainError(
              "CONFLICT",
              "This creation key was already used for another shipment.",
            );
          return existing;
        }
        await validateRoute(tx, parsed);
        await validateStock(tx, parsed.originLocationId, parsed.items);
        const { items, ...data } = parsed;
        return tx.shipment.create({
          data: {
            ...data,
            creationFingerprint: fingerprint,
            createdByUserId: actorId,
            items: { create: items },
          },
          include: { items: true },
        });
      }),
    update: (input: unknown, version: unknown) =>
      run(async (tx) => {
        const parsed = shipmentInput.parse(input),
          current = await lockShipment(tx, parsed.id);
        if (current.updatedAt.toISOString() !== z.iso.datetime().parse(version))
          throw new DomainError(
            "CONFLICT",
            "Shipment changed. Reload before editing.",
          );
        const { items, ...data } = parsed;
        if (preparationStatuses.includes(current.status)) {
          await validateRoute(tx, parsed);
          await validateStock(tx, parsed.originLocationId, items);
          await tx.shipmentItem.deleteMany({
            where: {
              shipmentId: current.id,
              merchandiseItemId: {
                notIn: items.map((item) => item.merchandiseItemId),
              },
            },
          });
          for (const item of items)
            await tx.shipmentItem.upsert({
              where: {
                shipmentId_merchandiseItemId: {
                  shipmentId: current.id,
                  merchandiseItemId: item.merchandiseItemId,
                },
              },
              create: { shipmentId: current.id, ...item },
              update: { quantity: item.quantity },
            });
        } else {
          if (
            parsed.originLocationId !== current.originLocationId ||
            parsed.destinationLocationId !== current.destinationLocationId ||
            parsed.transitParentId !== current.transitParentId ||
            items.length !== current.items.length ||
            items.some(
              (item) =>
                !current.items.some(
                  (existing) =>
                    existing.merchandiseItemId === item.merchandiseItemId &&
                    existing.quantity === item.quantity,
                ),
            )
          )
            throw new DomainError(
              "LOCKED",
              "Route and contents are locked after dispatch or cancellation. Choose final placement through Deliver shipment.",
            );
        }
        return tx.shipment.update({ where: { id: current.id }, data });
      }),
    setStatus: (idInput: unknown, statusInput: unknown) =>
      run(async (tx) => {
        const current = await lockShipment(tx, z.uuid().parse(idInput)),
          status = z.enum(ShipmentStatus).parse(statusInput);
        if (current.status === status) return current;
        if (!statusTransitions[current.status].includes(status))
          throw new DomainError(
            "INVALID_STATUS",
            "Use the explicit Ship or Deliver action for stock changes. Cancellation is only allowed before dispatch.",
          );
        return tx.shipment.update({
          where: { id: current.id },
          data: { status },
        });
      }),
    ship: (input: unknown) =>
      run(async (tx, actorId) => {
        const parsed = shipInput.parse(input),
          current = await lockShipment(tx, parsed.id);
        if (current.shipmentDate) {
          if (
            current.shipmentDate.toISOString().slice(0, 10) !==
            parsed.shipmentDate
          )
            throw new DomainError(
              "CONFLICT",
              "Shipment was already dispatched on a different date.",
            );
          return { id: current.id, replayed: true };
        }
        if (!preparationStatuses.includes(current.status))
          throw new DomainError(
            "INVALID_STATUS",
            "Only a draft, packing or ready shipment can be dispatched.",
          );
        await validateRoute(tx, current);
        const number = shipmentNumber(current.number);
        const transit = await createLocationInTransaction(tx, {
          code: `SHIPMENT-${current.id}`,
          name: number,
          type: "IN_TRANSIT",
          parentId: current.transitParentId,
          fulfillmentEnabled: false,
          notes: `Dedicated transit stock for ${number}.`,
        });
        await tx.shipment.update({
          where: { id: current.id },
          data: { transitLocationId: transit.id },
        });
        for (const item of current.items) {
          const { movement } = await applyInventoryOperationInTransaction(
            tx,
            {
              merchandiseItemId: item.merchandiseItemId,
              movementType: "TRANSFER",
              quantityDelta: item.quantity,
              sourceLocationId: current.originLocationId,
              destinationLocationId: transit.id,
              operationKey: `shipment-item:${item.id}:ship`,
              referenceType: "SHIPMENT_ITEM",
              referenceId: item.id,
              notes: `${number}: dispatched from Japan.`,
            },
            actorId,
          );
          await tx.shipmentItem.update({
            where: { id: item.id },
            data: { dispatchMovementId: movement.id },
          });
        }
        await tx.shipment.update({
          where: { id: current.id },
          data: {
            status: "SHIPPED",
            shipmentDate: new Date(parsed.shipmentDate),
          },
        });
        return { id: current.id, replayed: false };
      }, true),
    deliver: (input: unknown) =>
      run(async (tx, actorId) => {
        const parsed = deliverInput.parse(input),
          current = await lockShipment(tx, parsed.id);
        if (current.status === "DELIVERED") {
          if (
            current.arrivalDate?.toISOString().slice(0, 10) !==
              parsed.arrivalDate ||
            current.destinationLocationId !== parsed.destinationLocationId
          )
            throw new DomainError(
              "CONFLICT",
              "Shipment was already delivered with different date or placement. Use inventory transfers for subsequent moves.",
            );
          return { id: current.id, replayed: true };
        }
        if (
          !["SHIPPED", "IN_TRANSIT", "CUSTOMS"].includes(current.status) ||
          !current.transitLocationId ||
          !current.shipmentDate
        )
          throw new DomainError(
            "INVALID_STATUS",
            "Dispatch the shipment before recording delivery.",
          );
        if (
          parsed.arrivalDate < current.shipmentDate.toISOString().slice(0, 10)
        )
          throw new DomainError(
            "INVALID_DATE",
            "Arrival cannot precede dispatch.",
          );
        const paths = await locationPaths(tx),
          destination = paths.find(
            (row) => row.id === parsed.destinationLocationId,
          );
        if (
          !destination?.effectiveActive ||
          destination.inTransit ||
          destination.effectiveCountry !== "FR"
        )
          throw new DomainError(
            "INVALID_DESTINATION",
            "Select an active France location, including a final shelf or box.",
          );
        const transit = paths.find(
          (row) => row.id === current.transitLocationId,
        );
        if (!transit?.inTransit)
          throw new DomainError(
            "INVALID_TRANSIT",
            "Shipment transit storage was reconfigured. Restore its in-transit configuration before delivery.",
          );
        // Set final placement inside the transaction so receipt integrity checks can match the movement.
        await tx.shipment.update({
          where: { id: current.id },
          data: { destinationLocationId: parsed.destinationLocationId },
        });
        for (const item of current.items) {
          const { movement } = await applyInventoryOperationInTransaction(
            tx,
            {
              merchandiseItemId: item.merchandiseItemId,
              movementType: "TRANSFER",
              quantityDelta: item.quantity,
              sourceLocationId: current.transitLocationId,
              destinationLocationId: parsed.destinationLocationId,
              operationKey: `shipment-item:${item.id}:deliver`,
              referenceType: "SHIPMENT_ITEM",
              referenceId: item.id,
              notes: `${shipmentNumber(current.number)}: delivered in France.`,
            },
            actorId,
          );
          await tx.shipmentItem.update({
            where: { id: item.id },
            data: { deliveryMovementId: movement.id },
          });
        }
        await tx.shipment.update({
          where: { id: current.id },
          data: {
            status: "DELIVERED",
            arrivalDate: new Date(parsed.arrivalDate),
          },
        });
        return { id: current.id, replayed: false };
      }),
  };
}
