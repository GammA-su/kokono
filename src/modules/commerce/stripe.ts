import Stripe from "stripe";
import { z } from "zod";
import { DomainError } from "../shared/errors";
import type { OrderWithItems } from "./projections";
import type { PaymentAttempt } from "../../generated/prisma/client";
import { contactSchema, policySchema } from "./policy";
export type VerifiedPaymentEvent = {
  eventId: string;
  attemptId: string;
  type: "PAID" | "FAILED" | "REFUNDED" | "REFUND_FAILED";
  amount: number;
  currency: string;
  paymentIntentId: string | null;
  sessionId?: string;
  live: boolean;
};
export interface PaymentProvider {
  create(
    attempt: PaymentAttempt,
    order: OrderWithItems,
  ): Promise<{ sessionId: string; url: string }>;
  verify(body: string, signature: string): Promise<VerifiedPaymentEvent | null>;
  reconcile(attempt: PaymentAttempt): Promise<VerifiedPaymentEvent | null>;
  expire(attempt: PaymentAttempt): Promise<void>;
  refund(
    attempt: PaymentAttempt,
  ): Promise<{ id: string; event: VerifiedPaymentEvent | null }>;
}
export function paymentConfiguration() {
  const enabled = process.env.COMMERCE_TEST_CHECKOUT_ENABLED === "true";
  const configured =
    !!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") &&
    !!process.env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_") &&
    (process.env.COMMERCE_GATEWAY_SECRET?.length ?? 0) >= 32 &&
    !!process.env.STOREFRONT_BASE_URL;
  return {
    mode: "TEST" as const,
    enabled: enabled && configured,
    message:
      enabled && configured
        ? "Stripe test mode: use test payment details only."
        : "Test checkout is not configured. Payments and order creation are disabled.",
  };
}
/** Live keys are deliberately refused in this phase. No fake provider is wired into HTTP. */
export function stripeProvider(client?: Stripe): PaymentProvider {
  if (!paymentConfiguration().enabled)
    throw new DomainError(
      "CHECKOUT_DISABLED",
      "Stripe test checkout is not configured.",
    );
  const stripe =
    client ??
    new Stripe(process.env.STRIPE_SECRET_KEY!, {
      maxNetworkRetries: 2,
      timeout: 10000,
    });
  const origin = new URL(process.env.STOREFRONT_BASE_URL!).origin;
  async function refundedSnapshot(
    paymentIntentId: string,
    attemptId: string,
    eventId: string,
    live: boolean,
  ): Promise<VerifiedPaymentEvent | null> {
    const refunds = await stripe.refunds.list({
      payment_intent: paymentIntentId,
      limit: 100,
    });
    if (refunds.has_more)
      throw new DomainError(
        "REFUND_REVIEW_REQUIRED",
        "Refund history exceeds the automatic reconciliation limit.",
      );
    const amount = refunds.data
      .filter((refund) => refund.status === "succeeded")
      .reduce((sum, refund) => sum + refund.amount, 0);
    if (!amount) return null;
    // A charge-level notification is a signal to reconcile confirmed refunds, not proof that a pending refund succeeded.
    return {
      eventId: `${eventId}:confirmed:${amount}`,
      attemptId,
      type: "REFUNDED",
      amount,
      currency: refunds.data[0].currency.toUpperCase(),
      paymentIntentId,
      live,
    };
  }
  async function sessionEvent(
    session: Stripe.Checkout.Session,
    eventId: string,
  ): Promise<VerifiedPaymentEvent | null> {
    if (session.mode !== "payment") return null;
    const attemptId = session.metadata?.attemptId;
    if (!attemptId || !z.uuid().safeParse(attemptId).success) return null;
    const type =
      session.payment_status === "paid"
        ? "PAID"
        : session.status === "expired"
          ? "FAILED"
          : null;
    if (!type) return null;
    return {
      eventId,
      attemptId,
      type,
      amount: session.amount_total ?? -1,
      currency: (session.currency ?? "").toUpperCase(),
      paymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent?.id ?? null),
      sessionId: session.id,
      live: session.livemode,
    };
  }
  async function refundEvent(
    refund: Stripe.Refund,
    eventId: string,
  ): Promise<VerifiedPaymentEvent | null> {
    const pi =
      typeof refund.payment_intent === "string"
        ? refund.payment_intent
        : refund.payment_intent?.id;
    const intent = pi ? await stripe.paymentIntents.retrieve(pi) : null;
    const attemptId = refund.metadata?.attemptId ?? intent?.metadata.attemptId;
    if (
      !attemptId ||
      !z.uuid().safeParse(attemptId).success ||
      !["succeeded", "failed", "canceled"].includes(refund.status ?? "")
    )
      return null;
    return {
      eventId,
      attemptId,
      type: refund.status === "succeeded" ? "REFUNDED" : "REFUND_FAILED",
      amount: refund.amount,
      currency: refund.currency.toUpperCase(),
      paymentIntentId: pi ?? null,
      live: intent?.livemode ?? true,
    };
  }
  return {
    create: async (attempt, order) => {
      const items: Stripe.Checkout.SessionCreateParams.LineItem[] =
        order.items.map((item) => ({
          quantity: item.quantity,
          price_data: {
            currency: order.currency.toLowerCase(),
            unit_amount: item.unitPriceAmount,
            tax_behavior: "inclusive",
            product_data: { name: `${item.title} (TTC)` },
          },
        }));
      if (order.shippingAmount)
        items.push({
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: order.shippingAmount,
            tax_behavior: "inclusive",
            product_data: {
              name: `${policySchema.parse(order.policySnapshot).deliveryMethod} (TTC)`,
            },
          },
        });
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          payment_method_types: ["card"],
          line_items: items,
          customer_email: contactSchema.parse(order.contact).email,
          client_reference_id: order.id,
          metadata: { orderId: order.id, attemptId: attempt.id },
          payment_intent_data: {
            metadata: { orderId: order.id, attemptId: attempt.id },
          },
          expires_at: Math.floor(order.expiresAt.getTime() / 1000),
          success_url: `${origin}/orders/${order.id}?payment=return`,
          cancel_url: `${origin}/orders/${order.id}?payment=cancelled`,
          automatic_tax: { enabled: false },
          allow_promotion_codes: false,
        },
        { idempotencyKey: `checkout-attempt:${attempt.id}` },
      );
      if (
        session.livemode ||
        !session.url ||
        session.amount_total !== order.totalAmount ||
        session.currency !== "eur"
      )
        throw new DomainError(
          "PROVIDER_MISMATCH",
          "The payment session did not match the order.",
        );
      return { sessionId: session.id, url: session.url };
    },
    verify: async (body, signature) => {
      const event = stripe.webhooks.constructEvent(
        body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!,
        300,
      );
      if (event.livemode)
        throw new DomainError(
          "LIVE_PAYMENT_REFUSED",
          "Live payment events are disabled.",
        );
      if (
        [
          "checkout.session.completed",
          "checkout.session.expired",
          "checkout.session.async_payment_succeeded",
        ].includes(event.type)
      )
        return sessionEvent(
          event.data.object as Stripe.Checkout.Session,
          event.id,
        );
      if (event.type === "checkout.session.async_payment_failed") {
        const session = event.data.object as Stripe.Checkout.Session;
        return sessionEvent({ ...session, status: "expired" }, event.id);
      }
      if (
        ["refund.created", "refund.updated", "refund.failed"].includes(
          event.type,
        )
      ) {
        const current = await stripe.refunds.retrieve(
          (event.data.object as Stripe.Refund).id,
        );
        // Refund notifications can arrive out of order; normalize the provider's current resource.
        return refundEvent(current, `${event.id}:${current.status}`);
      }
      if (event.type === "charge.refunded") {
        const charge = event.data.object as Stripe.Charge,
          pi =
            typeof charge.payment_intent === "string"
              ? charge.payment_intent
              : charge.payment_intent?.id;
        if (!pi) return null;
        const intent = await stripe.paymentIntents.retrieve(pi),
          attemptId = intent.metadata.attemptId;
        if (!z.uuid().safeParse(attemptId).success) return null;
        return refundedSnapshot(pi, attemptId, event.id, charge.livemode);
      }
      return null;
    },
    reconcile: async (attempt) => {
      if (attempt.refundId) {
        const refund = await stripe.refunds.retrieve(attempt.refundId);
        return refundEvent(
          refund,
          `reconcile:refund:${attempt.refundId}:${refund.status}`,
        );
      }
      if (!attempt.providerSessionId) return null;
      const session = await stripe.checkout.sessions.retrieve(
        attempt.providerSessionId,
      );
      if (session.payment_status === "paid" && attempt.paymentIntentId) {
        const refunded = await refundedSnapshot(
          attempt.paymentIntentId,
          attempt.id,
          `reconcile:${session.id}:refund`,
          session.livemode,
        );
        if (refunded) return refunded;
      }
      return sessionEvent(
        session,
        `reconcile:${session.id}:${session.status}:${session.payment_status}`,
      );
    },
    expire: async (attempt) => {
      if (attempt.providerSessionId) {
        const session = await stripe.checkout.sessions.retrieve(
          attempt.providerSessionId,
        );
        if (session.status === "open")
          await stripe.checkout.sessions.expire(
            session.id,
            {},
            { idempotencyKey: `expire:${attempt.id}` },
          );
      }
    },
    refund: async (attempt) => {
      if (!attempt.paymentIntentId)
        throw new DomainError(
          "PAYMENT_UNRESOLVED",
          "The verified payment reference is missing.",
        );
      const refund = await stripe.refunds.create(
        {
          payment_intent: attempt.paymentIntentId,
          amount: attempt.amount,
          metadata: { attemptId: attempt.id },
        },
        { idempotencyKey: `refund:${attempt.id}` },
      );
      return {
        id: refund.id,
        event: await refundEvent(
          refund,
          `refund-response:${refund.id}:${refund.status}`,
        ),
      };
    },
  };
}
