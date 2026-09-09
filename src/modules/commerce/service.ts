import { recordDispatch, recordDelivery } from "../fulfillment/shipping";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { DomainError } from "../shared/errors";
import {
  fulfillableLocationIds,
  resolvePublicListingsInTransaction,
} from "../publication/queries";
import { lockInventoryItems, reservedAt } from "../inventory/reservations";
import { applyInventoryOperationInTransaction } from "../inventory/operations";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import type { CustomerMail } from "../customers/service";
import { notifyOrder } from "./notifications";
import {
  checkoutPolicy,
  guestHash,
  hash,
  includedVat,
  quoteInput,
  quoteTotals,
  type CheckoutPolicy,
  type QuoteInput,
  type QuoteSnapshot,
} from "./policy";
import { orderDto, orderInclude, quoteDto } from "./projections";
import { requireCustomer } from "../customers/service";
export const transactionOptions = { maxWait: 10000, timeout: 20000 };
export async function databaseNow(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  return row.now;
}
export async function lockOrder(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM orders WHERE id=${id}::uuid FOR UPDATE`;
  const order = await tx.order.findUnique({
    where: { id },
    include: orderInclude,
  });
  if (!order) throw new DomainError("NOT_FOUND", "Order not found.");
  return order;
}
export async function releaseOrder(tx: Prisma.TransactionClient, id: string) {
  const items = await tx.orderItem.findMany({
    where: { orderId: id },
    select: { merchandiseItemId: true },
  });
  await lockInventoryItems(
    tx,
    items.map((item) => item.merchandiseItemId),
  );
  return tx.inventoryReservation.updateMany({
    where: {
      orderItem: { orderId: id },
      status: { in: ["HELD", "CONFIRMED"] },
    },
    data: { status: "RELEASED" },
  });
}
export async function expireLockedOrder(
  tx: Prisma.TransactionClient,
  order: Awaited<ReturnType<typeof lockOrder>>,
) {
  if (order.status !== "PENDING" || order.expiresAt > (await databaseNow(tx)))
    return false;
  await releaseOrder(tx, order.id);
  await tx.order.update({
    where: { id: order.id },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  await tx.orderEvent.create({
    data: { orderId: order.id, type: "RESERVATION_EXPIRED" },
  });
  return true;
}
async function snapshot(
  tx: Prisma.TransactionClient,
  input: QuoteInput,
  policy: CheckoutPolicy,
  lock: boolean,
) {
  const ids = input.lines.map((line) => line.listingId);
  const selection = {
    id: true,
    merchandiseItemId: true,
    sellingPriceTaxInclusion: true,
    merchandiseItem: { select: { categoryId: true } },
  } as const;
  let listings = await tx.saleListing.findMany({
    where: { id: { in: ids } },
    select: selection,
  });
  if (lock) {
    await lockInventoryItems(
      tx,
      listings.map((row) => row.merchandiseItemId),
    );
    await tx.$queryRaw`SELECT id FROM sale_listings WHERE id IN (${Prisma.join(ids.sort().map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE`;
    listings = await tx.saleListing.findMany({
      where: { id: { in: ids } },
      select: selection,
    });
  }
  const result = await resolvePublicListingsInTransaction(tx, ids);
  if (result.unavailableListingIds.length)
    throw new DomainError(
      "LISTING_UNAVAILABLE",
      "One or more cart items are no longer available. Refresh your cart.",
    );
  const lines = input.lines.map((line) => {
    const p = result.items.find((p) => p.listingId === line.listingId)!,
      listing = listings.find((row) => row.id === line.listingId)!;
    if (p.price.currency !== policy.currency)
      throw new DomainError(
        "CURRENCY_UNSUPPORTED",
        "Checkout supports EUR only. Remove items priced in other currencies; no conversion is performed.",
      );
    if (listing.sellingPriceTaxInclusion !== "INCLUDED")
      throw new DomainError(
        "TAX_UNCONFIRMED",
        `${p.title} is awaiting confirmation of its TTC price. It cannot be checked out yet.`,
      );
    if (p.availability.availableQuantity < line.quantity)
      throw new DomainError(
        "INSUFFICIENT_STOCK",
        `${p.title}: only ${p.availability.availableQuantity} available. Reduce the requested quantity.`,
      );
    const totalAmount = p.price.amount * line.quantity;
    const taxRateBps =
      policy.categoryVatRates[listing.merchandiseItem.categoryId] ??
      policy.defaultVatRateBps;
    return {
      listingId: p.listingId,
      merchandiseItemId: listing.merchandiseItemId,
      title: p.title,
      quantity: line.quantity,
      unitPriceAmount: p.price.amount,
      currency: p.price.currency,
      taxRateBps,
      taxAmount: includedVat(totalAmount, taxRateBps),
      totalAmount,
    };
  });
  return quoteTotals(
    lines.sort((a, b) => a.listingId.localeCompare(b.listingId)),
    policy,
  );
}
async function saveQuote(
  tx: Prisma.TransactionClient,
  owner: string,
  input: QuoteInput,
  value: QuoteSnapshot,
) {
  const expiresAt = new Date(
    (await databaseNow(tx)).getTime() + 10 * 60 * 1000,
  );
  return tx.checkoutQuote.create({
    data: {
      guestHash: owner,
      request: input as Prisma.InputJsonValue,
      snapshot: value as unknown as Prisma.InputJsonValue,
      fingerprint: hash(value),
      expiresAt,
    },
  });
}
export function createCommerceService(
  database: PrismaClient,
  policy: () => CheckoutPolicy = checkoutPolicy,
) {
  return {
    quote: async (token: string, raw: unknown) => {
      const owner = guestHash(token),
        input = quoteInput.parse(raw);
      return database.$transaction(
        async (tx) => {
          // Durable per-guest throttle bounds both quote PII and reservation abuse.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`checkout-guest:${owner}`},0))::text`;
          const count = await tx.checkoutQuote.count({
            where: {
              guestHash: owner,
              createdAt: { gt: new Date(Date.now() - 3600000) },
            },
          });
          if (count >= 60)
            throw new DomainError(
              "RATE_LIMITED",
              "Too many quote requests. Please try again later.",
            );
          const value = await snapshot(tx, input, policy(), false),
            saved = await saveQuote(tx, owner, input, value);
          return quoteDto(saved.id, saved.expiresAt, value);
        },
        { ...transactionOptions, isolationLevel: "RepeatableRead" },
      );
    },
    checkout: async (token: string, raw: unknown, customerSession?: string) => {
      const owner = guestHash(token),
        input = z
          .object({
            quoteId: z.uuid(),
            operationKey: z.uuid(),
            accepted: z.literal(true),
          })
          .strict()
          .parse(raw);
      const key = hash([owner, input.operationKey]);
      return database.$transaction(async (tx) => {
        const customer = customerSession
          ? await requireCustomer(tx, customerSession, "CHECKOUT")
          : null;
        if (customer && customer.commerceKey !== token)
          throw new DomainError(
            "FORBIDDEN",
            "Checkout identity does not match the account.",
          );
        if (customer) {
          await tx.$queryRaw`SELECT id FROM customers WHERE id=${customer.id}::uuid FOR SHARE`;
          await requireCustomer(tx, customerSession!, "CHECKOUT");
        }
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`checkout-guest:${owner}`},0))::text`;
        const existing = await tx.order.findFirst({
          where: { OR: [{ checkoutKey: key }, { quoteId: input.quoteId }] },
          include: orderInclude,
        });
        if (existing) {
          if (
            existing.guestHash !== owner ||
            existing.quoteId !== input.quoteId
          )
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "This checkout identity belongs to a different request.",
            );
          return { kind: "order" as const, order: orderDto(existing) };
        }
        const quote = await tx.checkoutQuote.findUnique({
          where: { id: input.quoteId },
        });
        if (!quote || quote.guestHash !== owner)
          throw new DomainError("NOT_FOUND", "Quote not found.");
        if (quote.expiresAt <= (await databaseNow(tx)))
          throw new DomainError(
            "QUOTE_EXPIRED",
            "Request and accept a fresh quote before checkout.",
          );
        if (
          (await tx.order.count({
            where: {
              guestHash: owner,
              status: "PENDING",
              expiresAt: { gt: new Date() },
            },
          })) >= 3
        )
          throw new DomainError(
            "RATE_LIMITED",
            "Cancel or finish an existing checkout before starting another.",
          );
        const request = quoteInput.parse(quote.request),
          value = await snapshot(tx, request, policy(), true);
        if (hash(value) !== quote.fingerprint) {
          const next = await saveQuote(tx, owner, request, value);
          return {
            kind: "quote_changed" as const,
            quote: quoteDto(next.id, next.expiresAt, value),
          };
        }
        const now = await databaseNow(tx),
          expiresAt = new Date(
            now.getTime() + value.policy.reservationMinutes * 60000,
          );
        const id = randomUUID();
        const order = await tx.order.create({
          data: {
            id,
            number: `K-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${id.replaceAll("-", "").slice(0, 12).toUpperCase()}`,
            guestHash: owner,
            checkoutKey: key,
            customerId: customer?.id ?? null,
            quoteId: quote.id,
            currency: value.currency,
            contact: request.contact,
            shippingAddress: request.shippingAddress,
            billingAddress: request.billingAddress ?? request.shippingAddress,
            policySnapshot: value.policy as Prisma.InputJsonValue,
            subtotalAmount: value.subtotalAmount,
            shippingAmount: value.shippingAmount,
            shippingTaxAmount: value.shippingTaxAmount,
            shippingTaxRateBps: value.shippingTaxRateBps,
            taxAmount: value.taxAmount,
            totalAmount: value.totalAmount,
            expiresAt,
            items: {
              create: value.lines.map((line) => ({
                saleListingId: line.listingId,
                merchandiseItemId: line.merchandiseItemId,
                title: line.title,
                quantity: line.quantity,
                unitPriceAmount: line.unitPriceAmount,
                currency: line.currency,
                taxRateBps: line.taxRateBps,
                taxAmount: line.taxAmount,
                totalAmount: line.totalAmount,
              })),
            },
          },
          include: orderInclude,
        });
        const eligible = await fulfillableLocationIds(tx, "FRANCE");
        for (const item of [...order.items].sort((a, b) =>
          a.merchandiseItemId.localeCompare(b.merchandiseItemId),
        )) {
          const balances = await tx.inventoryBalance.findMany({
            where: {
              merchandiseItemId: item.merchandiseItemId,
              storageLocationId: { in: eligible },
              quantity: { gt: 0 },
            },
            orderBy: { storageLocationId: "asc" },
          });
          let needed = item.quantity;
          for (const balance of balances) {
            const available =
                balance.quantity -
                (await reservedAt(
                  tx,
                  item.merchandiseItemId,
                  balance.storageLocationId,
                )),
              quantity = Math.min(needed, available);
            if (quantity <= 0) continue;
            await tx.inventoryReservation.create({
              data: {
                orderItemId: item.id,
                merchandiseItemId: item.merchandiseItemId,
                storageLocationId: balance.storageLocationId,
                quantity,
                expiresAt,
              },
            });
            needed -= quantity;
            if (!needed) break;
          }
          if (needed)
            throw new DomainError(
              "INSUFFICIENT_STOCK",
              `${item.title}: stock changed. Nothing from this checkout was reserved.`,
            );
        }
        await tx.orderEvent.create({
          data: { orderId: order.id, type: "CHECKOUT_RESERVED" },
        });
        return { kind: "order" as const, order: orderDto(order) };
      }, transactionOptions);
    },
    get: async (token: string, id: string) => {
      const owner = guestHash(token);
      z.uuid().parse(id);
      return database.$transaction(async (tx) => {
        const order = await lockOrder(tx, id);
        if (order.guestHash !== owner)
          throw new DomainError("NOT_FOUND", "Order not found.");
        await expireLockedOrder(tx, order);
        return orderDto(
          await tx.order.findUniqueOrThrow({
            where: { id },
            include: orderInclude,
          }),
        );
      }, transactionOptions);
    },
    cancel: async (token: string, id: string) => {
      const owner = guestHash(token);
      z.uuid().parse(id);
      return database.$transaction(async (tx) => {
        const order = await lockOrder(tx, id);
        if (order.guestHash !== owner)
          throw new DomainError("NOT_FOUND", "Order not found.");
        if (order.status === "CANCELLED") return orderDto(order);
        if (order.status !== "PENDING" || order.paymentStatus !== "UNPAID")
          throw new DomainError(
            "CONTACT_STORE",
            "Only an unpaid checkout can be cancelled here. Contact the store about a paid order.",
          );
        await releaseOrder(tx, id);
        const updated = await tx.order.update({
          where: { id },
          data: { status: "CANCELLED", cancelledAt: new Date() },
          include: orderInclude,
        });
        await tx.orderEvent.create({
          data: { orderId: id, type: "GUEST_CANCELLED" },
        });
        return orderDto(updated);
      }, transactionOptions);
    },
  };
}
export async function expireReservations(database: PrismaClient, limit = 100) {
  const candidates = await database.order.findMany({
    where: { status: "PENDING", expiresAt: { lte: new Date() } },
    orderBy: { expiresAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let expired = 0;
  for (const row of candidates)
    if (
      await database.$transaction(
        async (tx) => expireLockedOrder(tx, await lockOrder(tx, row.id)),
        transactionOptions,
      )
    )
      expired++;
  return expired;
}
export function createOrderAdminService(
  database: PrismaClient,
  authorize: Authorize,
  notify?: CustomerMail,
) {
  return {
    transition: async (raw: unknown) => {
      const input = z
          .object({
            id: z.uuid(),
            action: z.enum(["PREPARING", "SHIPPED", "DELIVERED", "CANCELLED"]),
            carrier: z.string().trim().max(100).default(""),
            trackingNumber: z.string().trim().max(200).default(""),
          })
          .strict()
          .parse(raw),
        actor = await authorize();
      const updated = await database.$transaction(async (tx) => {
        await assertInternalAccount(tx, actor.id);
        const order = await lockOrder(tx, input.id);
        if (order.status === input.action) {
          if (
            input.action === "SHIPPED" &&
            (order.fulfillment?.shipment?.carrier !== input.carrier ||
              order.fulfillment?.shipment?.trackingNumber !==
                input.trackingNumber)
          )
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "Shipment tracking differs from the recorded dispatch.",
            );
          return order;
        }
        if (input.action === "CANCELLED") {
          if (!["PENDING", "PAID", "PREPARING"].includes(order.status))
            throw new DomainError(
              "INVALID_TRANSITION",
              "Dispatched orders cannot be cancelled. Use the refund workflow.",
            );
          await releaseOrder(tx, order.id);
          await tx.fulfillmentRequest.updateMany({
            where: { orderId: order.id },
            data: { status: "CANCELLED" },
          });
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: "CANCELLED",
              cancelledAt: new Date(),
              ...(order.paymentStatus === "PAID"
                ? { paymentStatus: "REFUND_PENDING" }
                : {}),
            },
          });
        } else {
          if (order.paymentStatus !== "PAID")
            throw new DomainError(
              "PAYMENT_REQUIRED",
              "Verified payment is required before fulfillment.",
            );
          if (
            (input.action === "PREPARING" && order.status !== "PAID") ||
            (input.action === "SHIPPED" &&
              !["PAID", "PREPARING"].includes(order.status)) ||
            (input.action === "DELIVERED" && order.status !== "SHIPPED")
          )
            throw new DomainError(
              "INVALID_TRANSITION",
              "This order cannot move to the requested state.",
            );
          if (input.action === "SHIPPED") {
            if (!input.carrier || !input.trackingNumber)
              throw new DomainError(
                "TRACKING_REQUIRED",
                "Enter the actual carrier and tracking reference.",
              );
            await lockInventoryItems(
              tx,
              order.items.map((item) => item.merchandiseItemId),
            );
            const eligible = await fulfillableLocationIds(tx, "FRANCE"),
              allocations = await tx.inventoryReservation.findMany({
                where: { orderItem: { orderId: order.id } },
                orderBy: [
                  { merchandiseItemId: "asc" },
                  { storageLocationId: "asc" },
                ],
              });
            for (const item of order.items)
              if (
                allocations
                  .filter(
                    (a) =>
                      a.orderItemId === item.id &&
                      a.status === "CONFIRMED" &&
                      eligible.includes(a.storageLocationId),
                  )
                  .reduce((n, a) => n + a.quantity, 0) !== item.quantity
              )
                throw new DomainError(
                  "ALLOCATION_INVALID",
                  "A full eligible France allocation is required. Resolve the location issue before dispatch; partial shipment is unsupported.",
                );
            for (const allocation of allocations.filter(
              (a) => a.status === "CONFIRMED",
            )) {
              await tx.inventoryReservation.update({
                where: { id: allocation.id },
                data: { status: "CONSUMED" },
              });
              const { movement } = await applyInventoryOperationInTransaction(
                tx,
                {
                  merchandiseItemId: allocation.merchandiseItemId,
                  sourceLocationId: allocation.storageLocationId,
                  quantityDelta: -allocation.quantity,
                  movementType: "SALE",
                  operationKey: `order-allocation:${allocation.id}:dispatch`,
                  referenceType: "ORDER",
                  referenceId: order.id,
                  notes: `Dispatch ${order.number}`,
                },
                actor.id,
              );
              await tx.inventoryReservation.update({
                where: { id: allocation.id },
                data: { movementId: movement.id },
              });
            }
            if (!order.fulfillment)
              throw new DomainError(
                "FULFILLMENT_MISSING",
                "The delivery request is missing.",
              );
            await recordDispatch(
              tx,
              order.fulfillment.id,
              input.carrier,
              input.trackingNumber,
            );
          }
          if (input.action === "DELIVERED")
            await recordDelivery(tx, order.fulfillment!.id);
          await tx.order.update({
            where: { id: order.id },
            data: { status: input.action },
          });
        }
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: input.action,
            actorUserId: actor.id,
          },
        });
        return tx.order.findUniqueOrThrow({
          where: { id: order.id },
          include: orderInclude,
        });
      }, transactionOptions);
      // After commit only: dispatch has already consumed stock, so mail must not be able to
      // fail or delay it. See notifyOrder for why the error is not propagated.
      if (input.action === "SHIPPED" && notify)
        await notifyOrder(notify, "ORDER_SHIPPED", updated, {
          carrier: input.carrier,
          trackingNumber: input.trackingNumber,
        });
      return updated;
    },
  };
}
