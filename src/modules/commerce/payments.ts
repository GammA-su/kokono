import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { DomainError } from "../shared/errors";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import { fulfillableLocationIds } from "../publication/queries";
import { lockInventoryItems } from "../inventory/reservations";
import { addressSchema, guestHash, hash } from "./policy";
import {
  databaseNow,
  expireLockedOrder,
  lockOrder,
  releaseOrder,
  transactionOptions,
} from "./service";
import { orderInclude } from "./projections";
import type { PaymentProvider, VerifiedPaymentEvent } from "./stripe";
import type { CustomerMail } from "../customers/service";
import { notifyOrder, type NotifiableOrder } from "./notifications";

export function createPaymentService(
  database: PrismaClient,
  provider: PaymentProvider,
  notify?: CustomerMail,
) {
  async function applyEvent(event: VerifiedPaymentEvent) {
    z.object({
      eventId: z.string().min(1).max(200),
      attemptId: z.uuid(),
      type: z.enum(["PAID", "FAILED", "REFUNDED", "REFUND_FAILED"]),
      amount: z.number().int().nonnegative(),
      currency: z.string().length(3),
      live: z.literal(false),
    })
      .passthrough()
      .parse(event);
    const attempt = await database.paymentAttempt.findUnique({
      where: { id: event.attemptId },
    });
    if (!attempt)
      throw new DomainError(
        "ATTEMPT_NOT_FOUND",
        "Payment attempt not found; retry reconciliation.",
      );
    // The transaction yields the order that just became PAID, or null when this event did not
    // confirm a payment. Returning it (rather than assigning an outer variable) keeps the
    // notification decision explicit and outside the transaction.
    const confirmed = await database.$transaction(async (tx): Promise<NotifiableOrder | null> => {
      const order = await lockOrder(tx, attempt.orderId);
      const current = await tx.paymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      const fingerprint = hash(event),
        existing = await tx.paymentEvent.findUnique({
          where: {
            provider_eventId: { provider: "STRIPE", eventId: event.eventId },
          },
        });
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new DomainError(
            "EVENT_CONFLICT",
            "Payment event identity was reused with different contents.",
          );
        return null;
      }
      // Serialize the event and its effects under the order lock; no browser can invoke this primitive.
      await tx.paymentEvent.create({
        data: {
          provider: "STRIPE",
          eventId: event.eventId,
          attemptId: attempt.id,
          type: event.type,
          amount: event.amount,
          currency: event.currency,
          fingerprint,
        },
      });
      const identityMismatch =
        event.currency !== order.currency ||
        (current.providerSessionId &&
          event.sessionId &&
          event.sessionId !== current.providerSessionId) ||
        (current.paymentIntentId &&
          event.paymentIntentId &&
          event.paymentIntentId !== current.paymentIntentId);
      if (identityMismatch || event.amount !== order.totalAmount) {
        // Retain the confirmed refund amount even when an external partial refund needs review.
        // charge.refunded/reconciliation supply the cumulative amount; older events cannot reduce it.
        const refunded =
          !identityMismatch &&
          event.type === "REFUNDED" &&
          event.amount < order.totalAmount
            ? Math.max(order.refundedAmount, event.amount)
            : order.refundedAmount;
        if (
          order.paymentStatus === "REFUNDED" &&
          refunded === order.totalAmount &&
          !identityMismatch
        )
          return null;
        await tx.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: "REVIEW",
            refundedAmount: refunded,
            reviewReason:
              "Provider amount, currency or identity mismatch; partial payment/refund is unsupported.",
          },
        });
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: "REVIEW" },
        });
        return null;
      }
      if (event.paymentIntentId)
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { paymentIntentId: event.paymentIntentId },
        });
      if (event.type === "REFUNDED") {
        await releaseOrder(tx, order.id);
        await tx.fulfillmentRequest.updateMany({
          where: { orderId: order.id, status: "READY" },
          data: { status: "CANCELLED" },
        });
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: "REFUNDED",
            paymentStatus: "REFUNDED",
            refundedAmount: event.amount,
            reviewReason: null,
          },
        });
        await tx.orderEvent.create({
          data: { orderId: order.id, type: "REFUNDED" },
        });
        return null;
      }
      if (event.type === "REFUND_FAILED") {
        await tx.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: "REVIEW",
            reviewReason: "Refund failed; reconcile with Stripe.",
          },
        });
        return null;
      }
      if (event.type === "FAILED") {
        if (order.paymentStatus !== "UNPAID") return null;
        await releaseOrder(tx, order.id);
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: "CANCELLED",
            paymentStatus: "FAILED",
            cancelledAt: new Date(),
          },
        });
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: "FAILED" },
        });
        await tx.orderEvent.create({
          data: { orderId: order.id, type: "PAYMENT_FAILED" },
        });
        return null;
      }
      if (
        order.paidAt ||
        ["PAID", "REFUNDED", "REFUND_PENDING"].includes(order.paymentStatus)
      )
        return null;
      await lockInventoryItems(
        tx,
        order.items.map((item) => item.merchandiseItemId),
      );
      const now = await databaseNow(tx),
        eligible = await fulfillableLocationIds(tx, "FRANCE"),
        allocations = await tx.inventoryReservation.findMany({
          where: { orderItem: { orderId: order.id } },
        });
      const full =
        order.status === "PENDING" &&
        order.expiresAt > now &&
        order.items.every(
          (item) =>
            allocations
              .filter(
                (a) =>
                  a.orderItemId === item.id &&
                  a.status === "HELD" &&
                  a.expiresAt! > now &&
                  eligible.includes(a.storageLocationId),
              )
              .reduce((n, a) => n + a.quantity, 0) === item.quantity,
        );
      if (!full) {
        await releaseOrder(tx, order.id);
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: "CANCELLED",
            paymentStatus: "REVIEW",
            reviewReason:
              "Payment arrived after cancellation/expiry or allocation eligibility changed. Refund or manually reconcile; do not dispatch.",
            cancelledAt: order.cancelledAt ?? now,
          },
        });
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: "REVIEW" },
        });
        await tx.orderEvent.create({
          data: { orderId: order.id, type: "LATE_PAYMENT_REVIEW" },
        });
        return null;
      }
      await tx.inventoryReservation.updateMany({
        where: { orderItem: { orderId: order.id }, status: "HELD" },
        data: { status: "CONFIRMED", expiresAt: null },
      });
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: "SUCCEEDED" },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "PAID",
          paymentStatus: "PAID",
          paidAt: now,
          reviewReason: null,
        },
      });
      await tx.fulfillmentRequest.create({
        data: {
          origin: "ORDER",
          originReference: order.id,
          orderId: order.id,
          address: addressSchema.parse(order.shippingAddress),
        },
      });
      await tx.orderEvent.create({
        data: { orderId: order.id, type: "PAYMENT_CONFIRMED" },
      });
      return order;
    }, transactionOptions);
    // Sent only after the payment transaction has committed. A provider call inside the
    // transaction would hold inventory locks for the duration of an external request, and a
    // mail failure must never roll back a payment that Stripe has already taken. A replayed
    // webhook cannot reach here twice because the paidAt/paymentStatus guard above returns
    // early, and the provider idempotency key collapses any residual duplicate.
    const paid = confirmed;
    if (paid !== null) await notifyOrder(notify, "ORDER_CONFIRMED", paid);
  }
  async function ensureSession(orderId: string, owner?: string) {
    const prepared = await database.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (owner && order.guestHash !== owner)
        throw new DomainError("NOT_FOUND", "Order not found.");
      const expired = await expireLockedOrder(tx, order);
      if (
        expired ||
        order.status !== "PENDING" ||
        order.paymentStatus !== "UNPAID"
      )
        return null;
      let attempt = await tx.paymentAttempt.findUnique({ where: { orderId } });
      if (!attempt)
        attempt = await tx.paymentAttempt.create({
          data: {
            orderId,
            amount: order.totalAmount,
            currency: order.currency,
          },
        });
      return { order, attempt };
    }, transactionOptions);
    if (!prepared)
      throw new DomainError(
        "ORDER_NOT_PAYABLE",
        "This order is no longer awaiting payment.",
      );
    if (prepared.attempt.checkoutUrl)
      return { url: prepared.attempt.checkoutUrl };
    if (prepared.order.expiresAt.getTime() - Date.now() < 31 * 60000)
      throw new DomainError(
        "PAYMENT_WINDOW_EXPIRED",
        "Cancel this checkout and request a fresh quote before starting payment.",
      );
    // Durable attempt first; network call outside the transaction, with a stable Stripe idempotency key.
    const session = await provider.create(prepared.attempt, prepared.order);
    const target = new URL(session.url);
    if (
      target.protocol !== "https:" ||
      target.hostname !== "checkout.stripe.com"
    )
      throw new DomainError(
        "PROVIDER_URL_INVALID",
        "Invalid payment destination.",
      );
    const payable = await database.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      const current = await tx.paymentAttempt.findUniqueOrThrow({
        where: { id: prepared.attempt.id },
      });
      if (
        current.providerSessionId &&
        current.providerSessionId !== session.sessionId
      )
        throw new DomainError(
          "SESSION_CONFLICT",
          "Payment session identity changed.",
        );
      await tx.paymentAttempt.update({
        where: { id: current.id },
        data: {
          providerSessionId: session.sessionId,
          checkoutUrl: session.url,
          ...(current.status === "CREATED" ? { status: "OPEN" } : {}),
        },
      });
      return (
        order.status === "PENDING" &&
        order.paymentStatus === "UNPAID" &&
        order.expiresAt > (await databaseNow(tx))
      );
    }, transactionOptions);
    if (!payable) {
      await provider.expire({
        ...prepared.attempt,
        providerSessionId: session.sessionId,
      });
      throw new DomainError(
        "ORDER_NOT_PAYABLE",
        "The order changed while payment was starting. Refresh its status.",
      );
    }
    return { url: session.url };
  }
  async function refundOrder(orderId: string, authorize: Authorize) {
    z.uuid().parse(orderId);
    const actor = await authorize();
    const attempt = await database.$transaction(async (tx) => {
      await assertInternalAccount(tx, actor.id);
      const order = await lockOrder(tx, orderId),
        payment = await tx.paymentAttempt.findUnique({ where: { orderId } });
      if (
        !payment?.paymentIntentId ||
        !["PAID", "REVIEW", "REFUND_PENDING", "REFUNDED"].includes(
          order.paymentStatus,
        )
      )
        throw new DomainError(
          "REFUND_UNAVAILABLE",
          "No verified payment is available for a full refund.",
        );
      if (order.paymentStatus === "REFUNDED") return null;
      if (order.refundedAmount > 0)
        throw new DomainError(
          "PARTIAL_REFUND_UNSUPPORTED",
          "A partial refund was recorded externally. Reconcile the remaining amount with Stripe; a second full refund is not allowed.",
        );
      await releaseOrder(tx, orderId);
      await tx.fulfillmentRequest.updateMany({
        where: { orderId, status: "READY" },
        data: { status: "CANCELLED" },
      });
      await tx.order.update({
        where: { id: orderId },
        data: {
          paymentStatus: "REFUND_PENDING",
          ...(["PENDING", "PAID", "PREPARING"].includes(order.status)
            ? { status: "CANCELLED", cancelledAt: new Date() }
            : {}),
        },
      });
      await tx.orderEvent.create({
        data: { orderId, type: "FULL_REFUND_REQUESTED", actorUserId: actor.id },
      });
      return tx.paymentAttempt.update({
        where: { id: payment.id },
        data: { refundRequestedAt: payment.refundRequestedAt ?? new Date() },
      });
    }, transactionOptions);
    if (!attempt) return;
    const result = await provider.refund(attempt);
    await database.paymentAttempt.update({
      where: { id: attempt.id },
      data: { refundId: result.id },
    });
    if (result.event) await applyEvent(result.event);
  }
  return {
    start: (token: string, id: string) =>
      ensureSession(z.uuid().parse(id), guestHash(token)),
    webhook: async (body: string, signature: string) => {
      const event = await provider.verify(body, signature);
      if (event) await applyEvent(event);
    },
    // Trusted normalization adapter entry point; only signed webhook/reconciliation services call it.
    applyVerifiedEvent: applyEvent,
    refund: refundOrder,
    reconcile: async (limit = 100) => {
      const attempts = await database.paymentAttempt.findMany({
        where: {
          OR: [
            {
              status: { in: ["CREATED", "OPEN", "REVIEW", "SUCCEEDED"] },
              order: { paymentStatus: { not: "REFUNDED" } },
            },
            { order: { paymentStatus: "REFUND_PENDING" } },
          ],
        },
        orderBy: { updatedAt: "asc" },
        take: limit,
      });
      let reconciled = 0,
        failed = 0;
      for (const attempt of attempts)
        try {
          const order = await database.order.findUniqueOrThrow({
            where: { id: attempt.orderId },
            include: orderInclude,
          });
          if (
            !attempt.providerSessionId &&
            order.status === "PENDING" &&
            order.expiresAt.getTime() - Date.now() > 31 * 60000
          )
            await ensureSession(order.id);
          else if (attempt.refundRequestedAt && !attempt.refundId) {
            // A lost response may outlive Stripe's idempotency cache. Observe existing refunds before retrying.
            const observed = await provider.reconcile(attempt);
            if (observed) await applyEvent(observed);
            if (
              !observed ||
              !["REFUNDED", "REFUND_FAILED"].includes(observed.type)
            ) {
              const result = await provider.refund(attempt);
              await database.paymentAttempt.update({
                where: { id: attempt.id },
                data: { refundId: result.id },
              });
              if (result.event) await applyEvent(result.event);
            }
          } else {
            const event = await provider.reconcile(attempt);
            if (event) await applyEvent(event);
          }
          if (order.status === "CANCELLED") await provider.expire(attempt);
          await database.paymentAttempt.update({
            where: { id: attempt.id },
            data: { lastReconciledAt: new Date() },
          });
          reconciled++;
        } catch {
          failed++;
        }
      return { reconciled, failed };
    },
  };
}
