import type { Prisma } from "../../generated/prisma/client";
import { addressSchema, contactSchema, type QuoteSnapshot } from "./policy";
export const orderInclude = {
  items: { orderBy: { id: "asc" } },
  fulfillment: { include: { shipment: true } },
} satisfies Prisma.OrderInclude;
export type OrderWithItems = Prisma.OrderGetPayload<{
  include: typeof orderInclude;
}>;
export function quoteDto(id: string, expiresAt: Date, snapshot: QuoteSnapshot) {
  return {
    id,
    expiresAt: expiresAt.toISOString(),
    currency: snapshot.currency,
    lines: snapshot.lines.map(
      ({
        listingId,
        title,
        quantity,
        unitPriceAmount,
        taxRateBps,
        taxAmount,
        totalAmount,
      }) => ({
        listingId,
        title,
        quantity,
        unitPriceAmount,
        taxRateBps,
        taxAmount,
        totalAmount,
      }),
    ),
    subtotalAmount: snapshot.subtotalAmount,
    shippingAmount: snapshot.shippingAmount,
    shippingTaxAmount: snapshot.shippingTaxAmount,
    shippingTaxRateBps: snapshot.shippingTaxRateBps,
    taxAmount: snapshot.taxAmount,
    totalAmount: snapshot.totalAmount,
    deliveryMethod: snapshot.policy.deliveryMethod,
    taxInclusion: "INCLUDED" as const,
  };
}
/** A credential-checked customer projection; never serialize a Prisma order wholesale. */
export function orderDto(order: OrderWithItems) {
  const shipment = order.fulfillment?.shipment;
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    paymentStatus: order.paymentStatus,
    currency: order.currency,
    contact: contactSchema.parse(order.contact),
    shippingAddress: addressSchema.parse(order.shippingAddress),
    billingAddress: addressSchema.parse(order.billingAddress),
    subtotalAmount: order.subtotalAmount,
    shippingAmount: order.shippingAmount,
    shippingTaxAmount: order.shippingTaxAmount,
    taxAmount: order.taxAmount,
    totalAmount: order.totalAmount,
    refundedAmount: order.refundedAmount,
    createdAt: order.createdAt.toISOString(),
    expiresAt:
      order.status === "PENDING" ? order.expiresAt.toISOString() : null,
    items: order.items.map((item) => ({
      listingId: item.saleListingId,
      title: item.title,
      quantity: item.quantity,
      unitPriceAmount: item.unitPriceAmount,
      currency: item.currency,
      taxRateBps: item.taxRateBps,
      taxAmount: item.taxAmount,
      totalAmount: item.totalAmount,
    })),
    shipment: shipment
      ? {
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          shippedAt: shipment.shippedAt.toISOString(),
          deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
        }
      : null,
  };
}
