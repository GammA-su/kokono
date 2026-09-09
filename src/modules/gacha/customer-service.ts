import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import {
  requireCustomer,
  customerRateLimit,
  verificationRequired,
} from "../customers/service";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import { DomainError } from "../shared/errors";
import { awardInTransaction, lockBanner, poolReadiness } from "./service";
import { gachaPolicy } from "./validation";
import { managedImagePattern } from "../publication/media";

export const customerGachaEnabled = () =>
  process.env.GACHA_CUSTOMER_EXECUTION_ENABLED === "true" &&
  gachaPolicy().drawsEnabled;
const options = { timeout: 30000, maxWait: 10000 };
const pullInput = z
  .object({
    bannerId: z.uuid(),
    configurationId: z.uuid(),
    count: z.literal(1),
    requestKey: z.uuid(),
  })
  .strict();
const signature = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
const missing = () =>
  new DomainError("NOT_FOUND", "This gacha record was not found.");
const pageInput = z.coerce.number().int().min(1).max(1000000).catch(1);
const rewardStatus = z.enum([
  "AWARDED",
  "CLAIMED",
  "PREPARING",
  "SHIPPED",
  "DELIVERED",
  "CONSUMED",
  "CANCELLED",
]);

export interface CustomerPullReceipt {
  pullId: string;
  bannerId: string;
  configurationId: string;
  configurationVersion: number;
  banner: { id: string; slug: string; name: string };
  createdAt: string;
  prizes: {
    id: string;
    rewardId: string;
    name: string;
    tier: string;
    description: string;
    image: { id: string; url: string; alt: string } | null;
  }[];
}
// Receipt JSON is created exclusively by this projection and immutable in PostgreSQL.
function receipt(value: Prisma.JsonValue) {
  return value as unknown as CustomerPullReceipt;
}

async function allowances(
  tx: Prisma.TransactionClient,
  customerId: string,
  bannerId: string,
) {
  const [{ now }] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  const rows = await tx.gachaAuthorization.findMany({
    where: { customerId, bannerId, expiresAt: { gt: now } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    include: { _count: { select: { pulls: true } } },
  });
  return rows.filter((a) => a._count.pulls < a.maxPulls);
}

/** Internal no-charge authorizations are distinct from prize selection and cannot accept payment. */
export function createGachaCustomerAdmin(
  db: PrismaClient,
  authorize: Authorize,
) {
  return {
    enable: async (raw: unknown) => {
      const input = z
        .object({
          bannerId: z.uuid(),
          enabled: z.boolean(),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict()
        .parse(raw);
      const actor = await authorize();
      return db.$transaction(async (tx) => {
        await assertInternalAccount(tx, actor.id);
        await lockBanner(tx, input.bannerId);
        await tx.gachaBanner.update({
          where: { id: input.bannerId },
          data: { customerEnabled: input.enabled },
        });
        await tx.gachaEvent.create({
          data: {
            bannerId: input.bannerId,
            actorUserId: actor.id,
            type: input.enabled
              ? "CUSTOMER_FREE_ENABLED"
              : "CUSTOMER_FREE_DISABLED",
            note: input.reason,
          },
        });
      }, options);
    },
    authorize: async (raw: unknown) => {
      const input = z
        .object({
          bannerId: z.uuid(),
          customerId: z.uuid(),
          operationKey: z.uuid(),
          maxPulls: z.number().int().min(1).max(100),
          expiresAt: z.iso.datetime({ offset: true }),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict()
        .parse(raw);
      const actor = await authorize();
      return db.$transaction(async (tx) => {
        await assertInternalAccount(tx, actor.id);
        await lockBanner(tx, input.bannerId);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`gacha-authorization:${input.operationKey}`},0))::text`;
        const prior = await tx.gachaAuthorization.findUnique({
          where: { operationKey: input.operationKey },
        });
        if (prior) {
          if (
            prior.customerId !== input.customerId ||
            prior.bannerId !== input.bannerId ||
            prior.maxPulls !== input.maxPulls ||
            prior.expiresAt.toISOString() !==
              new Date(input.expiresAt).toISOString() ||
            prior.reason !== input.reason ||
            prior.actorUserId !== actor.id
          )
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "This authorization key has already been used.",
            );
          return prior;
        }
        const customer = await tx.customer.findUnique({
          where: { id: input.customerId },
        });
        if (!customer || customer.status === "DISABLED")
          throw new DomainError(
            "CUSTOMER_UNAVAILABLE",
            "Choose an enabled customer account.",
          );
        const [{ now }] = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT clock_timestamp() AS now`;
        const expiresAt = new Date(input.expiresAt);
        if (
          expiresAt <= now ||
          expiresAt.getTime() > now.getTime() + 30 * 86400000
        )
          throw new DomainError(
            "INVALID_EXPIRY",
            "Authorization must expire within the next 30 days.",
          );
        const result = await tx.gachaAuthorization.create({
          data: { ...input, expiresAt, actorUserId: actor.id },
        });
        await tx.gachaEvent.create({
          data: {
            bannerId: input.bannerId,
            actorUserId: actor.id,
            type: "CUSTOMER_FREE_AUTHORIZED",
            note: `Authorization ${result.id}; customer ${customer.id}; ${input.maxPulls} no-charge pulls. ${input.reason}`,
          },
        });
        return result;
      }, options);
    },
  };
}

export function createCustomerGachaService(db: PrismaClient) {
  return {
    eligibility: async (token: string, raw: unknown) => {
      const bannerId = z.uuid().parse(raw);
      return db.$transaction(async (tx) => {
        const customer = await requireCustomer(tx, token);
        const banner = await lockBanner(tx, bannerId),
          state = await poolReadiness(tx, banner);
        const available = await allowances(tx, customer.id, bannerId);
        const remaining = available.reduce(
          (sum, a) => sum + a.maxPulls - a._count.pulls,
          0,
        );
        const reason =
          !customerGachaEnabled() || !banner.customerEnabled
            ? "CUSTOMER_DISABLED"
            : verificationRequired("GACHA") && !customer.emailVerifiedAt
              ? "EMAIL_VERIFICATION_REQUIRED"
              : !state.ready
                ? state.reason
                : !remaining
                  ? "AUTHORIZATION_REQUIRED"
                  : "READY";
        return {
          enabled: reason === "READY",
          reason,
          mode: "ADMIN_AUTHORIZED_FREE",
          paidEnabled: false,
          supportedCounts: [1],
          remaining,
          bannerId,
          configurationId: banner.currentConfigurationId,
        };
      }, options);
    },
    pull: async (token: string, raw: unknown) => {
      const input = pullInput.parse(raw);
      const customer = await requireCustomer(db, token);
      // Independent transaction: rejected commands cannot roll the abuse counter back.
      await customerRateLimit(db, `gacha-pull:${customer.id}`, 20, 60);
      return db.$transaction(async (tx) => {
        // Serializes same customer's key across banners and account disabling/password reset.
        await tx.$queryRaw`SELECT id FROM customers WHERE id=${customer.id}::uuid FOR UPDATE`;
        await requireCustomer(tx, token);
        const prior = await tx.gachaPull.findUnique({
          where: {
            customerId_requestKey: {
              customerId: customer.id,
              requestKey: input.requestKey,
            },
          },
          include: { reward: true },
        });
        if (prior) {
          if (prior.requestFingerprint !== signature(input))
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "This request key belongs to a different pull request.",
            );
          if (!prior.reward) throw missing();
          return receipt(prior.reward.receipt);
        }
        await requireCustomer(tx, token, "GACHA");
        const banner = await lockBanner(tx, input.bannerId);
        if (
          !customerGachaEnabled() ||
          !banner.customerEnabled ||
          banner.paidEnabled
        )
          throw new DomainError(
            "CUSTOMER_DISABLED",
            "Customer pulls are disabled for this banner. Paid pulls are unavailable.",
          );
        if (banner.currentConfigurationId !== input.configurationId)
          throw new DomainError(
            "CONFIGURATION_CHANGED",
            "Odds changed. Refresh the banner and review the current odds before a new request. No pull was made.",
          );
        const authorization = (await allowances(tx, customer.id, banner.id))[0];
        if (!authorization)
          throw new DomainError(
            "AUTHORIZATION_REQUIRED",
            "An unexpired administrator-granted free pull is required.",
          );
        const { pull, reservation } = await awardInTransaction(tx, banner, {
          actorUserId: null,
          customerReference: customer.id,
          operationKey: randomUUID(),
          signature: signature(input),
          mode: "ADMIN_AUTHORIZED_FREE",
          reason:
            "Customer executed an administrator-authorized no-charge pull.",
          customer: {
            customerId: customer.id,
            requestKey: input.requestKey,
            authorizationId: authorization.id,
          },
        });
        const prize = banner.currentConfiguration!.prizes.find(
          (p) => p.id === pull.prizeId,
        )!;
        const images = await tx.itemImage.findMany({
          where: {
            merchandiseItemId: prize.merchandiseItemId,
            approvedForPublicUse: true,
          },
          orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
          select: { id: true, storageKey: true, caption: true },
        });
        const image = images.find((i) =>
          managedImagePattern.test(i.storageKey),
        );
        const rewardId = randomUUID();
        const publicReceipt: CustomerPullReceipt = {
          pullId: pull.id,
          bannerId: banner.id,
          configurationId: pull.configurationId,
          configurationVersion: banner.currentConfiguration!.version,
          banner: { id: banner.id, slug: banner.slug, name: banner.name },
          createdAt: pull.createdAt.toISOString(),
          prizes: [
            {
              id: prize.id,
              rewardId,
              name: prize.displayName,
              tier: prize.tier,
              description: prize.description,
              image: image
                ? {
                    id: image.id,
                    url: `/api/storefront/v1/images/${image.id}`,
                    alt: image.caption || prize.displayName,
                  }
                : null,
            },
          ],
        };
        await tx.gachaReward.create({
          data: {
            id: rewardId,
            customerId: customer.id,
            pullId: pull.id,
            prizeId: prize.id,
            merchandiseItemId: prize.merchandiseItemId,
            reservationId: reservation.id,
            receipt: publicReceipt as unknown as Prisma.InputJsonValue,
          },
        });
        return publicReceipt;
      }, options);
    },
    recover: async (token: string, raw: unknown, byRequestKey = false) => {
      const id = z.uuid().parse(raw),
        customer = await requireCustomer(db, token);
      // Lock the customer to wait out an in-flight POST before reporting key not found.
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customers WHERE id=${customer.id}::uuid FOR UPDATE`;
        await requireCustomer(tx, token);
        const pull = await tx.gachaPull.findFirst({
          where: {
            customerId: customer.id,
            ...(byRequestKey ? { requestKey: id } : { id }),
          },
          select: { reward: { select: { receipt: true } } },
        });
        if (!pull?.reward) throw missing();
        return receipt(pull.reward.receipt);
      }, options);
    },
    reward: async (token: string, raw: unknown) => {
      const id = z.uuid().parse(raw),
        customer = await requireCustomer(db, token);
      const row = await db.gachaReward.findFirst({
        where: { id, customerId: customer.id },
        select: {
          fulfillment: {
            select: {
              address: true,
              status: true,
              shipment: {
                select: {
                  carrier: true,
                  trackingNumber: true,
                  shippedAt: true,
                  deliveredAt: true,
                },
              },
            },
          },
          id: true,
          status: true,
          quantity: true,
          receipt: true,
          updatedAt: true,
        },
      });
      if (!row) throw missing();
      return {
        fulfillment: row.fulfillment,
        id: row.id,
        status: row.status,
        quantity: row.quantity,
        updatedAt: row.updatedAt.toISOString(),
        receipt: receipt(row.receipt),
      };
    },
    history: async (token: string, rawPage: unknown, status?: unknown) => {
      const customer = await requireCustomer(db, token),
        requested = pageInput.parse(rawPage);
      const where = {
        customerId: customer.id,
        ...(status == null || status === ""
          ? {}
          : { status: rewardStatus.parse(status) }),
      };
      return db.$transaction(
        async (tx) => {
          const total = await tx.gachaReward.count({ where }),
            size = 20,
            pageCount = Math.max(1, Math.ceil(total / size)),
            page = Math.min(requested, pageCount);
          const rows = await tx.gachaReward.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            skip: (page - 1) * size,
            take: size,
            select: {
              id: true,
              status: true,
              quantity: true,
              receipt: true,
              updatedAt: true,
            },
          });
          return {
            items: rows.map((row) => ({
              id: row.id,
              status: row.status,
              quantity: row.quantity,
              updatedAt: row.updatedAt.toISOString(),
              receipt: receipt(row.receipt),
            })),
            pageInfo: { page, size, total, pageCount },
          };
        },
        { isolationLevel: "RepeatableRead" },
      );
    },
  };
}
