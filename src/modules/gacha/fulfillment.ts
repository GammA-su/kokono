import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { addressSchema, hash } from "../commerce/policy";
import { requireCustomer, customerRateLimit } from "../customers/service";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import { DomainError } from "../shared/errors";
import { lockBanner, finalizeAwardInTransaction } from "./service";
import { recordDispatch, recordDelivery } from "../fulfillment/shipping";

const options = { timeout: 30000, maxWait: 10000 };
const include = {
  fulfillment: { include: { shipment: true } },
  reservation: true,
  pull: true,
} as const;
async function lockReward(tx: Prisma.TransactionClient, id: string) {
  const lookup = await tx.gachaReward.findUnique({
    where: { id },
    select: { pull: { select: { bannerId: true } } },
  });
  if (!lookup) throw new DomainError("NOT_FOUND", "Reward not found.");
  await lockBanner(tx, lookup.pull.bannerId);
  await tx.$queryRaw`SELECT id FROM gacha_rewards WHERE id=${id}::uuid FOR UPDATE`;
  return tx.gachaReward.findUniqueOrThrow({ where: { id }, include });
}
export async function claimGachaReward(
  db: PrismaClient,
  token: string,
  raw: unknown,
) {
  const input = z
    .object({
      rewardId: z.uuid(),
      operationKey: z.uuid(),
      address: addressSchema,
    })
    .strict()
    .parse(raw);
  const customer = await requireCustomer(db, token, "GACHA");
  await customerRateLimit(db, `gacha-claim:${customer.id}`, 20, 60);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM customers WHERE id=${customer.id}::uuid FOR UPDATE`;
    await requireCustomer(tx, token, "GACHA");
    const owned = await tx.gachaReward.findFirst({
      where: { id: input.rewardId, customerId: customer.id },
      select: { id: true },
    });
    if (!owned) throw new DomainError("NOT_FOUND", "Reward not found.");
    const reward = await lockReward(tx, owned.id);
    const fingerprint = hash({ rewardId: reward.id, address: input.address });
    if (reward.claimKey) {
      if (
        reward.claimKey !== input.operationKey ||
        reward.claimFingerprint !== fingerprint
      )
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "This reward already has a delivery claim. Its address has not been changed.",
        );
      return { id: reward.id, status: reward.status };
    }
    const prior = await tx.gachaReward.findUnique({
      where: {
        customerId_claimKey: {
          customerId: customer.id,
          claimKey: input.operationKey,
        },
      },
      select: { id: true },
    });
    if (prior)
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This operation key belongs to another reward claim.",
      );
    if (
      reward.status !== "AWARDED" ||
      reward.pull.status !== "RESERVED" ||
      reward.reservation.status !== "CONFIRMED"
    )
      throw new DomainError(
        "INVALID_TRANSITION",
        "Only an awarded, reserved reward may be claimed.",
      );
    const request = await tx.fulfillmentRequest.create({
      data: {
        origin: "GACHA",
        originReference: reward.id,
        address: input.address,
      },
    });
    await tx.gachaReward.update({
      where: { id: reward.id },
      data: {
        status: "CLAIMED",
        fulfillmentId: request.id,
        claimKey: input.operationKey,
        claimFingerprint: fingerprint,
        claimedAt: new Date(),
      },
    });
    await tx.gachaEvent.create({
      data: {
        bannerId: reward.pull.bannerId,
        pullId: reward.pullId,
        customerId: customer.id,
        type: "REWARD_CLAIMED",
        note: `Reward ${reward.id}; delivery request ${request.id}.`,
      },
    });
    return { id: reward.id, status: "CLAIMED" as const };
  }, options);
}
export function createRewardFulfillmentService(
  db: PrismaClient,
  authorize: Authorize,
) {
  return {
    transition: async (raw: unknown) => {
      const input = z
        .object({
          id: z.uuid(),
          action: z.enum(["PREPARING", "SHIPPED", "DELIVERED", "CANCELLED"]),
          carrier: z.string().trim().max(100).default(""),
          trackingNumber: z.string().trim().max(200).default(""),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict()
        .parse(raw);
      const actor = await authorize();
      return db.$transaction(async (tx) => {
        await assertInternalAccount(tx, actor.id);
        const reward = await lockReward(tx, input.id),
          request = reward.fulfillment;
        if (
          reward.status === input.action ||
          (input.action === "SHIPPED" && reward.status === "DELIVERED")
        ) {
          if (
            input.action === "SHIPPED" &&
            (request?.shipment?.carrier !== input.carrier ||
              request?.shipment?.trackingNumber !== input.trackingNumber)
          )
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "Tracking differs from the recorded dispatch.",
            );
          return { id: reward.id, status: reward.status };
        }
        if (input.action === "CANCELLED") {
          if (!["AWARDED", "CLAIMED", "PREPARING"].includes(reward.status))
            throw new DomainError(
              "INVALID_TRANSITION",
              "A dispatched reward cannot be cancelled or silently restocked.",
            );
          await finalizeAwardInTransaction(
            tx,
            { pullId: reward.pullId, action: "CANCEL", reason: input.reason },
            actor.id,
            "CANCELLED",
          );
          if (request)
            await tx.fulfillmentRequest.update({
              where: { id: request.id },
              data: { status: "CANCELLED" },
            });
        } else {
          if (!request)
            throw new DomainError(
              "CLAIM_REQUIRED",
              "The customer must claim this reward and supply a delivery address first.",
            );
          if (
            (input.action === "PREPARING" && reward.status !== "CLAIMED") ||
            (input.action === "SHIPPED" && reward.status !== "PREPARING") ||
            (input.action === "DELIVERED" && reward.status !== "SHIPPED")
          )
            throw new DomainError(
              "INVALID_TRANSITION",
              "This reward cannot move to the requested state.",
            );
          if (input.action === "SHIPPED") {
            // Domain consumption rechecks the original reservation's actual location eligibility.
            await finalizeAwardInTransaction(
              tx,
              {
                pullId: reward.pullId,
                action: "CONSUME",
                reason: input.reason,
              },
              actor.id,
              "SHIPPED",
            );
            await recordDispatch(
              tx,
              request.id,
              input.carrier,
              input.trackingNumber,
            );
          } else {
            if (input.action === "DELIVERED")
              await recordDelivery(tx, request.id);
            await tx.gachaReward.update({
              where: { id: reward.id },
              data: { status: input.action },
            });
          }
        }
        await tx.gachaEvent.create({
          data: {
            bannerId: reward.pull.bannerId,
            pullId: reward.pullId,
            actorUserId: actor.id,
            type: `REWARD_${input.action}`,
            note: `Reward ${reward.id}; ${input.reason}`,
          },
        });
        return { id: reward.id, status: input.action };
      }, options);
    },
  };
}
