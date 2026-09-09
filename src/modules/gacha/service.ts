import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import { lockInventoryItems, reservedAt } from "../inventory/reservations";
import { fulfillableLocationIds } from "../publication/queries";
import { applyInventoryOperationInTransaction } from "../inventory/operations";
import { DomainError } from "../shared/errors";
import { bannerInput, grantInput, gachaPolicy } from "./validation";
import { secureSelection, simulate, totalWeight } from "./odds";
const options = { timeout: 30000, maxWait: 10000 };
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const configInclude = {
  prizes: { orderBy: { displayOrder: "asc" } },
} as const;
export async function lockBanner(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM gacha_banners WHERE id=${id}::uuid FOR UPDATE`;
  const banner = await tx.gachaBanner.findUnique({
    where: { id },
    include: { currentConfiguration: { include: configInclude } },
  });
  if (!banner) throw new DomainError("NOT_FOUND", "Gacha banner not found.");
  return banner;
}
/** Same readiness rule for admin, public odds and real selection; no per-prize renormalization. */
export async function poolReadiness(
  tx: Prisma.TransactionClient,
  banner: Awaited<ReturnType<typeof lockBanner>>,
  checkSchedule = true,
) {
  const config = banner.currentConfiguration;
  if (!config)
    return {
      ready: false,
      reason: "NO_CONFIGURATION",
      remaining: new Map<string, number>(),
    };
  const eligible = await fulfillableLocationIds(tx, "FRANCE");
  const units = await tx.inventoryReservation.findMany({
    where: {
      gachaPrize: { configurationId: config.id },
      gachaPullId: null,
      status: "CONFIRMED",
    },
    select: {
      gachaPrizeId: true,
      storageLocationId: true,
      merchandiseItem: {
        select: {
          archivedAt: true,
          lineup: {
            select: {
              archivedAt: true,
              franchise: { select: { archivedAt: true } },
            },
          },
        },
      },
    },
  });
  const remaining = new Map(config.prizes.map((p) => [p.id, 0]));
  let invalid = false;
  for (const unit of units) {
    remaining.set(unit.gachaPrizeId!, remaining.get(unit.gachaPrizeId!)! + 1);
    if (
      !eligible.includes(unit.storageLocationId) ||
      unit.merchandiseItem.archivedAt ||
      unit.merchandiseItem.lineup.archivedAt ||
      unit.merchandiseItem.lineup.franchise.archivedAt
    )
      invalid = true;
  }
  const [{ now }] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  const reason = !gachaPolicy().drawsEnabled
    ? "POLICY_DISABLED"
    : banner.paidEnabled
      ? "PAID_DISABLED"
      : checkSchedule && !banner.active
        ? "PAUSED"
        : checkSchedule && banner.startsAt && banner.startsAt > now
          ? "NOT_STARTED"
          : checkSchedule && banner.endsAt && banner.endsAt <= now
            ? "ENDED"
            : invalid
              ? "LOCATION_OR_ITEM_UNAVAILABLE"
              : config.prizes.some((p) => !remaining.get(p.id))
                ? "POOL_DEPLETED"
                : "READY";
  return { ready: reason === "READY", reason, remaining };
}
/** Shared secure selection + physical claim. Callers authorize execution before entering. */
export async function awardInTransaction(
  tx: Prisma.TransactionClient,
  banner: Awaited<ReturnType<typeof lockBanner>>,
  context: {
    actorUserId: string | null;
    customerReference: string;
    operationKey: string;
    signature: string;
    mode: string;
    reason: string;
    customer?: {
      customerId: string;
      requestKey: string;
      authorizationId: string;
    };
  },
) {
  await lockInventoryItems(
    tx,
    banner.currentConfiguration!.prizes.map((p) => p.merchandiseItemId),
  );
  const readiness = await poolReadiness(tx, banner);
  if (!readiness.ready)
    throw new DomainError(
      "POOL_UNAVAILABLE",
      `No draw performed: ${readiness.reason}.`,
    );
  const result = secureSelection(banner.currentConfiguration!.prizes);
  const reservation = await tx.inventoryReservation.findFirst({
    where: {
      gachaPrizeId: result.prize.id,
      gachaPullId: null,
      status: "CONFIRMED",
    },
    orderBy: { id: "asc" },
  });
  if (!reservation)
    throw new DomainError("INSUFFICIENT_STOCK", "No prize unit is available.");
  const pull = await tx.gachaPull.create({
    data: {
      ...context.customer,
      bannerId: banner.id,
      configurationId: banner.currentConfiguration!.id,
      prizeId: result.prize.id,
      customerReference: context.customerReference,
      operationKey: context.operationKey,
      requestFingerprint: context.signature,
      randomTicket: result.ticket,
      randomAlgorithm: result.algorithm,
      actorUserId: context.actorUserId,
      audit: {
        mode: context.mode,
        authorizationId: context.customer?.authorizationId ?? null,
        reason: context.reason,
        configurationDigest: banner.currentConfiguration!.digest,
        totalWeight: result.total,
        intervalStart: result.start,
        intervalEndExclusive: result.end,
        termsVersion: banner.termsVersion,
      },
    },
  });
  await tx.inventoryReservation.update({
    where: { id: reservation.id },
    data: { gachaPullId: pull.id },
  });
  await tx.gachaEvent.create({
    data: {
      bannerId: banner.id,
      pullId: pull.id,
      type: "AWARDED",
      customerId: context.customer?.customerId,
      note: context.reason,
      actorUserId: context.actorUserId,
    },
  });
  return { pull, reservation };
}
/** Caller holds the banner lock. Shared final consumption/cancellation for internal and customer fulfillment. */
export async function finalizeAwardInTransaction(
  tx: Prisma.TransactionClient,
  input: { pullId: string; action: "CONSUME" | "CANCEL"; reason: string },
  actor: string,
  rewardStatus?: "SHIPPED" | "CANCELLED",
) {
  const pull = await tx.gachaPull.findUniqueOrThrow({
      where: { id: input.pullId },
      include: { reservation: true, reward: true },
    }),
    target = input.action === "CONSUME" ? "CONSUMED" : "CANCELLED";
  if (pull.status === target) return pull;
  if (pull.status !== "RESERVED")
    throw new DomainError(
      "INVALID_TRANSITION",
      "A finalized award cannot be rerolled or silently restocked.",
    );
  if (
    pull.customerId &&
    !rewardStatus &&
    (input.action === "CONSUME" || pull.reward?.fulfillmentId)
  )
    throw new DomainError(
      "USE_REWARD_QUEUE",
      "Use the gacha fulfillment queue for customer rewards.",
    );
  const reservation = pull.reservation;
  if (!reservation)
    throw new DomainError(
      "ALLOCATION_MISSING",
      "The award reservation is missing.",
    );
  await lockInventoryItems(tx, [reservation.merchandiseItemId]);
  if (input.action === "CONSUME") {
    if (
      !(await fulfillableLocationIds(tx, "FRANCE")).includes(
        reservation.storageLocationId,
      )
    )
      throw new DomainError(
        "LOCATION_UNAVAILABLE",
        "Restore location eligibility before physical fulfillment, or cancel the award explicitly.",
      );
    await tx.inventoryReservation.update({
      where: { id: reservation.id },
      data: { status: "CONSUMED" },
    });
    const { movement } = await applyInventoryOperationInTransaction(
      tx,
      {
        merchandiseItemId: reservation.merchandiseItemId,
        sourceLocationId: reservation.storageLocationId,
        quantityDelta: -1,
        movementType: "GACHA",
        operationKey: `gacha-award:${pull.id}:consume`,
        referenceType: "GACHA_PULL",
        referenceId: pull.id,
        notes: input.reason,
      },
      actor,
    );
    await tx.inventoryReservation.update({
      where: { id: reservation.id },
      data: { movementId: movement.id },
    });
  } else
    await tx.inventoryReservation.update({
      where: { id: reservation.id },
      data: { status: "RELEASED" },
    });
  const updated = await tx.gachaPull.update({
    where: { id: pull.id },
    data: { status: target },
  });
  await tx.gachaReward.updateMany({
    where: { pullId: pull.id },
    data: { status: rewardStatus ?? target },
  });
  await tx.gachaEvent.create({
    data: {
      bannerId: pull.bannerId,
      pullId: pull.id,
      type: target,
      note: input.reason,
      actorUserId: actor,
    },
  });
  return updated;
}
export function createGachaService(db: PrismaClient, authorize: Authorize) {
  async function authorized<T>(
    fn: (tx: Prisma.TransactionClient, actor: string) => Promise<T>,
  ) {
    const actor = await authorize();
    return db.$transaction(async (tx) => {
      await assertInternalAccount(tx, actor.id);
      return fn(tx, actor.id);
    }, options);
  }
  return {
    configure: async (raw: unknown) => {
      const input = bannerInput.parse(raw);
      return authorized(async (tx, actor) => {
        const id = input.id ?? randomUUID();
        let existing: Awaited<ReturnType<typeof lockBanner>> | null = null;
        if (input.id) {
          existing = await lockBanner(tx, id);
          if (existing.currentConfigurationId !== input.expectedConfigurationId)
            throw new DomainError(
              "CONFIGURATION_CHANGED",
              "The configuration changed. Reload before editing.",
            );
        }
        const oldItems =
          existing?.currentConfiguration?.prizes.map(
            (p) => p.merchandiseItemId,
          ) ?? [];
        await lockInventoryItems(tx, [
          ...oldItems,
          ...input.prizes.map((p) => p.merchandiseItemId),
        ]);
        const items = await tx.merchandiseItem.findMany({
          where: {
            id: { in: input.prizes.map((p) => p.merchandiseItemId) },
            archivedAt: null,
            lineup: { archivedAt: null, franchise: { archivedAt: null } },
          },
          select: { id: true },
        });
        if (items.length !== input.prizes.length)
          throw new DomainError(
            "ITEM_UNAVAILABLE",
            "Choose active catalog items for every prize.",
          );
        if (existing?.currentConfigurationId)
          await tx.inventoryReservation.updateMany({
            where: {
              gachaPrize: { configurationId: existing.currentConfigurationId },
              gachaPullId: null,
              status: "CONFIRMED",
            },
            data: { status: "RELEASED" },
          });
        const {
          id: ignored,
          expectedConfigurationId: ignoredExpected,
          prizes,
          ...values
        } = input;
        void ignored;
        void ignoredExpected;
        const data = {
          ...values,
          startsAt: input.startsAt ? new Date(input.startsAt) : null,
          endsAt: input.endsAt ? new Date(input.endsAt) : null,
        };
        if (!existing) await tx.gachaBanner.create({ data: { id, ...data } });
        else await tx.gachaBanner.update({ where: { id }, data });
        const version = (existing?.currentConfiguration?.version ?? 0) + 1,
          configurationId = randomUUID();
        const rows = prizes.map((p, displayOrder) => ({
            ...p,
            id: randomUUID(),
            displayOrder,
          })),
          weight = totalWeight(rows);
        const snapshot = {
          ...values,
          version,
          algorithm: "FIXED_WEIGHTS_STOP_ON_DEPLETION_V1",
          prizes: rows,
          totalWeight: weight,
        };
        await tx.gachaConfiguration.create({
          data: {
            id: configurationId,
            bannerId: id,
            version,
            totalWeight: weight,
            snapshot: snapshot as Prisma.InputJsonValue,
            digest: fingerprint(snapshot),
            actorUserId: actor,
            prizes: { create: rows.map((row) => ({ ...row, bannerId: id })) },
          },
        });
        const eligible = await fulfillableLocationIds(tx, "FRANCE");
        for (const prize of [...rows].sort((a, b) =>
          a.merchandiseItemId.localeCompare(b.merchandiseItemId),
        )) {
          const balances = await tx.inventoryBalance.findMany({
            where: {
              merchandiseItemId: prize.merchandiseItemId,
              storageLocationId: { in: eligible },
              quantity: { gt: 0 },
            },
            orderBy: { storageLocationId: "asc" },
          });
          let needed = prize.allocation;
          for (const balance of balances) {
            const available =
                balance.quantity -
                (await reservedAt(
                  tx,
                  prize.merchandiseItemId,
                  balance.storageLocationId,
                )),
              count = Math.min(needed, available);
            if (count <= 0) continue;
            await tx.inventoryReservation.createMany({
              data: Array.from({ length: count }, () => ({
                gachaPrizeId: prize.id,
                merchandiseItemId: prize.merchandiseItemId,
                storageLocationId: balance.storageLocationId,
                quantity: 1,
                status: "CONFIRMED" as const,
              })),
            });
            needed -= count;
            if (!needed) break;
          }
          if (needed)
            throw new DomainError(
              "INSUFFICIENT_STOCK",
              `${prize.displayName}: ${needed} more unreserved, fulfillable France units are required. No configuration or allocation was changed.`,
            );
        }
        await tx.gachaBanner.update({
          where: { id },
          data: { currentConfigurationId: configurationId },
        });
        await tx.gachaEvent.create({
          data: {
            bannerId: id,
            type: "CONFIGURED",
            note: `Version ${version}; ${rows.reduce((n, p) => n + p.allocation, 0)} units reserved. Prior awards preserved.`,
            actorUserId: actor,
          },
        });
        return { id, configurationId, version };
      });
    },
    control: async (raw: unknown) => {
      const input = z
        .object({
          bannerId: z.uuid(),
          configurationId: z.uuid(),
          action: z.enum(["PAUSE", "RESUME", "RELEASE_POOL"]),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict()
        .parse(raw);
      return authorized(async (tx, actor) => {
        const banner = await lockBanner(tx, input.bannerId);
        if (banner.currentConfigurationId !== input.configurationId)
          throw new DomainError(
            "CONFIGURATION_CHANGED",
            "Reload the current configuration.",
          );
        await lockInventoryItems(
          tx,
          banner.currentConfiguration!.prizes.map((p) => p.merchandiseItemId),
        );
        if (input.action === "RESUME") {
          const state = await poolReadiness(tx, banner, false);
          if (!state.ready)
            throw new DomainError("POOL_UNAVAILABLE", state.reason);
        }
        if (input.action === "RELEASE_POOL")
          await tx.inventoryReservation.updateMany({
            where: {
              gachaPrize: { configurationId: input.configurationId },
              gachaPullId: null,
              status: "CONFIRMED",
            },
            data: { status: "RELEASED" },
          });
        await tx.gachaBanner.update({
          where: { id: banner.id },
          data: { active: input.action === "RESUME" },
        });
        await tx.gachaEvent.create({
          data: {
            bannerId: banner.id,
            type: input.action,
            note: input.reason,
            actorUserId: actor,
          },
        });
      });
    },
    grant: async (raw: unknown) => {
      const input = grantInput.parse(raw);
      return authorized(async (tx, actor) => {
        const banner = await lockBanner(tx, input.bannerId);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`gacha-operation:${input.operationKey}`},0))::text`;
        const signature = fingerprint({ ...input, actor }),
          prior = await tx.gachaPull.findUnique({
            where: { operationKey: input.operationKey },
          });
        if (prior) {
          if (prior.requestFingerprint !== signature)
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "This operation key belongs to another grant.",
            );
          return prior;
        }
        if (banner.currentConfigurationId !== input.configurationId)
          throw new DomainError(
            "CONFIGURATION_CHANGED",
            "Odds changed. Reload and review the current version.",
          );
        return (
          await awardInTransaction(tx, banner, {
            actorUserId: actor,
            customerReference: input.customerReference,
            operationKey: input.operationKey,
            signature,
            mode: input.mode,
            reason: input.reason,
          })
        ).pull;
      });
    },
    finalize: async (raw: unknown) => {
      const input = z
        .object({
          pullId: z.uuid(),
          action: z.enum(["CONSUME", "CANCEL"]),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict()
        .parse(raw);
      return authorized(async (tx, actor) => {
        const lookup = await tx.gachaPull.findUnique({
          where: { id: input.pullId },
          select: { bannerId: true },
        });
        if (!lookup) throw new DomainError("NOT_FOUND", "Pull not found.");
        await lockBanner(tx, lookup.bannerId);
        return finalizeAwardInTransaction(tx, input, actor);
      });
    },
    simulate: async (raw: unknown) => {
      const input = z
        .object({
          configurationId: z.uuid(),
          count: z.number().int().min(1).max(100000),
        })
        .strict()
        .parse(raw);
      const prizes = await authorized(async (tx) => {
        const config = await tx.gachaConfiguration.findUnique({
          where: { id: input.configurationId },
          include: configInclude,
        });
        if (!config)
          throw new DomainError("NOT_FOUND", "Configuration not found.");
        return config.prizes;
      });
      return {
        configurationId: input.configurationId,
        ...simulate(prizes, input.count),
      };
    },
  };
}
