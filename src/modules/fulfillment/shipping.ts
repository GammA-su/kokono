import type { Prisma } from "../../generated/prisma/client";
import { DomainError } from "../shared/errors";

/** Shared customer dispatch record. Inventory consumption belongs to the calling domain transaction. */
export async function recordDispatch(
  tx: Prisma.TransactionClient,
  requestId: string,
  carrier: string,
  trackingNumber: string,
) {
  if (!carrier || !trackingNumber)
    throw new DomainError(
      "TRACKING_REQUIRED",
      "Enter the actual carrier and tracking reference.",
    );
  const request = await tx.fulfillmentRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { shipment: true },
  });
  if (request.shipment) {
    if (
      request.shipment.carrier !== carrier ||
      request.shipment.trackingNumber !== trackingNumber
    )
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "Tracking differs from the recorded dispatch.",
      );
    return request.shipment;
  }
  if (request.status !== "READY")
    throw new DomainError(
      "INVALID_TRANSITION",
      "This delivery request is not ready to ship.",
    );
  const shipment = await tx.fulfillmentShipment.create({
    data: { requestId, carrier, trackingNumber },
  });
  await tx.fulfillmentRequest.update({
    where: { id: requestId },
    data: { status: "SHIPPED" },
  });
  return shipment;
}
export async function recordDelivery(
  tx: Prisma.TransactionClient,
  requestId: string,
) {
  const request = await tx.fulfillmentRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { shipment: true },
  });
  if (request.status === "DELIVERED") return;
  if (request.status !== "SHIPPED" || !request.shipment)
    throw new DomainError(
      "INVALID_TRANSITION",
      "Only a dispatched shipment can be delivered.",
    );
  await tx.fulfillmentShipment.update({
    where: { requestId },
    data: { deliveredAt: new Date() },
  });
  await tx.fulfillmentRequest.update({
    where: { id: requestId },
    data: { status: "DELIVERED" },
  });
}
