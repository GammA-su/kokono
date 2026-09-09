import { contactSchema } from "./policy";
import type { CustomerMail, CustomerOrderSummary } from "../customers/service";

/** The order fields a transactional message needs. Deliberately not the whole order. */
export type NotifiableOrder = {
  number: string;
  totalAmount: number;
  currency: string;
  contact: unknown;
};

/**
 * Raises one transactional order message.
 *
 * Two rules hold here and are the reason this is a single shared helper:
 *
 * 1. It must be called *after* the surrounding transaction has committed. An external provider
 *    call inside a commerce transaction would hold inventory and order locks for the length of
 *    a network request.
 * 2. It must never throw into the commerce path. A payment that Stripe has already taken, or a
 *    dispatch that has already consumed stock, is a completed fact; failing the caller because
 *    a mail provider was unreachable would roll back or surface an error for work that actually
 *    succeeded. The customer's order state remains correct and visible in their account either
 *    way, and the provider error is deliberately not propagated because its body can echo
 *    addresses and headers.
 */
export async function notifyOrder(
  // Undefined when no mail provider is configured: order state stays correct, nothing is sent.
  notify: CustomerMail | undefined,
  purpose: "ORDER_CONFIRMED" | "ORDER_SHIPPED",
  order: NotifiableOrder,
  shipment?: { carrier?: string | null; trackingNumber?: string | null },
) {
  if (!notify) return;
  const contact = contactSchema.safeParse(order.contact);
  if (!contact.success) return;
  const summary: CustomerOrderSummary = {
    number: order.number,
    totalAmount: order.totalAmount,
    currency: order.currency,
    ...(shipment?.carrier ? { carrier: shipment.carrier } : {}),
    ...(shipment?.trackingNumber
      ? { trackingNumber: shipment.trackingNumber }
      : {}),
  };
  try {
    await notify({ email: contact.data.email, purpose, order: summary });
  } catch {
    // Intentionally swallowed: see rule 2 above.
  }
}
