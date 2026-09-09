import { createHash, randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { z } from "zod";
import type {
  Customer,
  PrismaClient,
  Prisma,
} from "../../generated/prisma/client";
import { DomainError } from "../shared/errors";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import { addressSchema } from "../commerce/policy";

type Database = PrismaClient | Prisma.TransactionClient;
export const secretHash = (s: string) =>
  createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
export const sessionSeconds = 60 * 60 * 24 * 30;
export const emailInput = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));
const passwordInput = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(1024);
const profileInput = z
  .object({
    displayName: z.string().trim().max(100).default(""),
    lastName: z.string().trim().max(100).default(""),
  })
  .strict();
const tokenInput = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/**
 * Where a verified email address is required before an action may proceed.
 *
 * The three supported policies are an owner decision, not a code change:
 *   off    — unverified accounts may check out and pull. Lowest friction, highest abuse risk.
 *   gacha  — checkout is open; gacha pulls and reward claims require verification. This limits
 *            give-away abuse without adding friction to paying customers.
 *   all    — both checkout and gacha require verification. Strictest; depends entirely on mail
 *            delivery being reliable, so enable it only after provider delivery is proven.
 *
 * `CUSTOMER_REQUIRE_VERIFIED_EMAIL` is still honoured so existing deployments keep their
 * behaviour: true means `all`, false means `off`. `CUSTOMER_VERIFICATION_POLICY` wins when set.
 */
export type VerificationScope = "CHECKOUT" | "GACHA";
export type VerificationPolicy = "off" | "gacha" | "all";
export function verificationPolicy(
  env: Record<string, string | undefined> = process.env,
): VerificationPolicy {
  const configured = env.CUSTOMER_VERIFICATION_POLICY;
  if (configured === "off" || configured === "gacha" || configured === "all")
    return configured;
  if (configured)
    throw new Error("Invalid CUSTOMER_VERIFICATION_POLICY: expected off, gacha or all.");
  return env.CUSTOMER_REQUIRE_VERIFIED_EMAIL === "true" ? "all" : "off";
}
export const verificationRequired = (scope: VerificationScope) => {
  const policy = verificationPolicy();
  return policy === "all" || (policy === "gacha" && scope === "GACHA");
};
export function customerDto(c: Customer) {
  return {
    id: c.id,
    email: c.email,
    displayName: c.displayName,
    lastName: c.lastName,
    emailVerified: !!c.emailVerifiedAt,
    createdAt: c.createdAt.toISOString(),
  };
}
export async function requireCustomer(
  db: Database,
  token: string,
  // The scope the caller is guarding, or false when the action needs no verification at all.
  verified: VerificationScope | false = false,
) {
  if (!tokenInput.safeParse(token).success)
    throw new DomainError(
      "UNAUTHORIZED",
      "Please sign in to your customer account.",
    );
  const session = await db.customerSession.findUnique({
    where: { tokenHash: secretHash(token) },
    include: { customer: true },
  });
  if (
    !session ||
    session.expiresAt <= new Date() ||
    session.customer.status === "DISABLED"
  )
    throw new DomainError(
      "UNAUTHORIZED",
      "Please sign in to your customer account.",
    );
  if (verified && verificationRequired(verified) && !session.customer.emailVerifiedAt)
    throw new DomainError(
      "EMAIL_VERIFICATION_REQUIRED",
      "Verify your email before continuing.",
    );
  return session.customer;
}
/** Durable, atomic fixed windows shared by backend replicas. No raw IP or email is stored. */
export async function customerRateLimit(
  db: PrismaClient,
  key: string,
  limit: number,
  seconds = 600,
) {
  const now = new Date(),
    expires = new Date(now.getTime() + seconds * 1000);
  const rows = await db.$queryRaw<
    { count: number }[]
  >`INSERT INTO customer_rate_limits (key,count,expires_at) VALUES (${secretHash(key)},1,${expires}) ON CONFLICT (key) DO UPDATE SET count=CASE WHEN customer_rate_limits.expires_at <= ${now} THEN 1 ELSE customer_rate_limits.count+1 END, expires_at=CASE WHEN customer_rate_limits.expires_at <= ${now} THEN ${expires} ELSE customer_rate_limits.expires_at END RETURNING count`;
  if (rows[0].count > limit)
    throw new DomainError(
      "RATE_LIMITED",
      "Too many attempts. Please try again later.",
    );
}
/**
 * Transactional customer mail. Account messages carry a single-use token; order messages carry
 * the order facts a customer needs to recognise the message. There is no marketing purpose and
 * no list: every message is the direct result of an action on that customer's own order.
 */
export type CustomerOrderSummary = {
  number: string;
  totalAmount: number;
  currency: string;
  carrier?: string;
  trackingNumber?: string;
};
export type CustomerMailMessage =
  | { email: string; purpose: "RESET" | "VERIFY"; token: string }
  | {
      email: string;
      purpose: "ORDER_CONFIRMED" | "ORDER_SHIPPED";
      order: CustomerOrderSummary;
    };
export type CustomerMail = (message: CustomerMailMessage) => Promise<void>;
// No provider configured: do not write tokens to logs/files or pretend delivery occurred.
export function createCustomerService(
  db: PrismaClient,
  deliver?: CustomerMail,
) {
  async function issue(c: Customer, purpose: "RESET" | "VERIFY") {
    if (!deliver || c.status === "DISABLED") return;
    const token = secret();
    await db.customerToken.create({
      data: {
        customerId: c.id,
        tokenHash: secretHash(token),
        purpose,
        expiresAt: new Date(
          Date.now() + (purpose === "RESET" ? 3600000 : 86400000),
        ),
      },
    });
    try {
      await deliver({ email: c.email, purpose, token });
    } catch {
      await db.customerToken.deleteMany({
        where: { tokenHash: secretHash(token) },
      });
    }
  }
  async function session(
    tx: Prisma.TransactionClient,
    c: Customer,
    previous?: string,
  ) {
    if (previous)
      await tx.customerSession.deleteMany({
        where: { tokenHash: secretHash(previous) },
      });
    const token = secret();
    await tx.customerSession.create({
      data: {
        customerId: c.id,
        tokenHash: secretHash(token),
        expiresAt: new Date(Date.now() + sessionSeconds * 1000),
      },
    });
    await tx.customer.update({
      where: { id: c.id },
      data: { lastLoginAt: new Date() },
    });
    await tx.customerEvent.create({
      data: { customerId: c.id, type: "LOGIN" },
    });
    return { token, customer: customerDto(c) };
  }
  return {
    register: async (raw: unknown, previous?: string) => {
      const input = z
        .object({
          email: emailInput,
          password: passwordInput,
          displayName: z.string().trim().max(100).default(""),
        })
        .strict()
        .parse(raw);
      const passwordHash = await hashPassword(input.password);
      let result;
      try {
        result = await db.$transaction(async (tx) => {
          const c = await tx.customer.create({
            data: {
              email: input.email,
              displayName: input.displayName,
              passwordHash,
              commerceKey: secret(),
            },
          });
          await tx.customerEvent.create({
            data: { customerId: c.id, type: "REGISTERED" },
          });
          return { c, login: await session(tx, c, previous) };
        });
      } catch (e) {
        if ((e as { code?: string }).code === "P2002")
          throw new DomainError(
            "REGISTRATION_UNAVAILABLE",
            "Unable to register with these details. Try signing in or resetting your password.",
          );
        throw e;
      }
      await issue(result.c, "VERIFY");
      return result.login;
    },
    login: async (raw: unknown, previous?: string) => {
      const input = z
        .object({ email: emailInput, password: z.string().min(1).max(1024) })
        .strict()
        .parse(raw);
      await customerRateLimit(db, `login-email:${input.email}`, 10);
      const c = await db.customer.findUnique({ where: { email: input.email } });
      const valid = c
        ? await verifyPassword({
            hash: c.passwordHash,
            password: input.password,
          })
        : (await hashPassword(input.password), false);
      if (!c || !valid || c.status === "DISABLED")
        throw new DomainError(
          "INVALID_CREDENTIALS",
          "Email or password is incorrect.",
        );
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customers WHERE id=${c.id}::uuid FOR UPDATE`;
        const current = await tx.customer.findUniqueOrThrow({
          where: { id: c.id },
        });
        if (
          current.status === "DISABLED" ||
          current.passwordHash !== c.passwordHash
        )
          throw new DomainError(
            "INVALID_CREDENTIALS",
            "Email or password is incorrect.",
          );
        return session(tx, current, previous);
      });
    },
    logout: async (token: string) =>
      db.$transaction(async (tx) => {
        const prior = await tx.customerSession.findUnique({
          where: { tokenHash: secretHash(token) },
        });
        await tx.customerSession.deleteMany({
          where: { tokenHash: secretHash(token) },
        });
        if (prior)
          await tx.customerEvent.create({
            data: { customerId: prior.customerId, type: "LOGOUT" },
          });
      }),
    session: async (token: string) => {
      try {
        return {
          authenticated: true as const,
          customer: customerDto(await requireCustomer(db, token)),
          emailDeliveryAvailable: !!deliver,
        };
      } catch (e) {
        if (e instanceof DomainError && e.code === "UNAUTHORIZED")
          return {
            authenticated: false as const,
            customer: null,
            emailDeliveryAvailable: !!deliver,
          };
        throw e;
      }
    },
    profile: async (token: string, raw: unknown) => {
      const c = await requireCustomer(db, token);
      return customerDto(
        await db.customer.update({
          where: { id: c.id },
          data: profileInput.parse(raw),
        }),
      );
    },
    requestReset: async (raw: unknown) => {
      const { email } = z.object({ email: emailInput }).strict().parse(raw);
      await customerRateLimit(db, `reset-email:${email}`, 3, 3600);
      const c = await db.customer.findUnique({ where: { email } });
      if (c) await issue(c, "RESET");
      return {
        message:
          "If an eligible account exists and email delivery is configured, a reset link will be sent.",
      };
    },
    requestVerification: async (token: string) => {
      const c = await requireCustomer(db, token);
      await customerRateLimit(db, `verify:${c.id}`, 3, 3600);
      if (!c.emailVerifiedAt) await issue(c, "VERIFY");
      return {
        message: deliver
          ? "A verification email has been requested."
          : "Email delivery is not configured yet. Your email remains unverified.",
      };
    },
    redeem: async (purpose: "RESET" | "VERIFY", raw: unknown) => {
      const input = (
        purpose === "RESET"
          ? z.object({ token: tokenInput, password: passwordInput }).strict()
          : z.object({ token: tokenInput }).strict()
      ).parse(raw);
      const passwordHash =
        "password" in input
          ? await hashPassword(passwordInput.parse(input.password))
          : undefined;
      return db.$transaction(async (tx) => {
        const candidate = await tx.customerToken.findUnique({
          where: { tokenHash: secretHash(input.token) },
        });
        if (!candidate || candidate.purpose !== purpose)
          throw new DomainError(
            "INVALID_TOKEN",
            "This link is invalid or expired.",
          );
        await tx.$queryRaw`SELECT id FROM customers WHERE id=${candidate.customerId}::uuid FOR UPDATE`;
        const c = await tx.customer.findUniqueOrThrow({
          where: { id: candidate.customerId },
        });
        const consumed = await tx.customerToken.deleteMany({
          where: { id: candidate.id, purpose, expiresAt: { gt: new Date() } },
        });
        if (!consumed.count || c.status === "DISABLED")
          throw new DomainError(
            "INVALID_TOKEN",
            "This link is invalid or expired.",
          );
        await tx.customer.update({
          where: { id: c.id },
          data:
            purpose === "RESET"
              ? { passwordHash }
              : { emailVerifiedAt: new Date(), status: "ACTIVE" },
        });
        await tx.customerToken.deleteMany({
          where: { customerId: c.id, purpose },
        });
        if (purpose === "RESET")
          await tx.customerSession.deleteMany({ where: { customerId: c.id } });
        await tx.customerEvent.create({
          data: {
            customerId: c.id,
            type: purpose === "RESET" ? "PASSWORD_RESET" : "EMAIL_VERIFIED",
          },
        });
        return { success: true };
      });
    },
    addresses: async (token: string) => {
      const c = await requireCustomer(db, token);
      return db.customerAddress.findMany({
        where: { customerId: c.id },
        select: addressSelect,
        orderBy: [{ defaultShipping: "desc" }, { createdAt: "asc" }],
      });
    },
    saveAddress: async (token: string, raw: unknown) => {
      const input = addressSchema
        .extend({
          id: z.uuid().optional(),
          label: z.string().trim().min(1).max(80),
          phone: z.string().trim().max(30).default(""),
          defaultShipping: z.boolean().default(false),
        })
        .strict()
        .parse(raw);
      return db.$transaction(async (tx) => {
        const c = await requireCustomer(tx, token);
        await tx.$queryRaw`SELECT id FROM customers WHERE id=${c.id}::uuid FOR UPDATE`;
        const { id, ...data } = input;
        if (
          id &&
          !(await tx.customerAddress.findFirst({
            where: { id, customerId: c.id },
          }))
        )
          throw new DomainError("NOT_FOUND", "Address not found.");
        if (
          !id &&
          (await tx.customerAddress.count({ where: { customerId: c.id } })) >=
            20
        )
          throw new DomainError("LIMIT_REACHED", "Save at most 20 addresses.");
        if (data.defaultShipping)
          await tx.customerAddress.updateMany({
            where: { customerId: c.id },
            data: { defaultShipping: false },
          });
        return id
          ? tx.customerAddress.update({
              where: { id },
              data,
              select: addressSelect,
            })
          : tx.customerAddress.create({
              data: { ...data, customerId: c.id },
              select: addressSelect,
            });
      });
    },
    deleteAddress: async (token: string, id: string) => {
      const c = await requireCustomer(db, token);
      const result = await db.customerAddress.deleteMany({
        where: { id: z.uuid().parse(id), customerId: c.id },
      });
      if (!result.count)
        throw new DomainError("NOT_FOUND", "Address not found.");
      return { success: true };
    },
    orders: async (token: string, rawPage: unknown) => {
      const c = await requireCustomer(db, token),
        page = z.coerce
          .number()
          .int()
          .min(1)
          .max(100000)
          .catch(1)
          .parse(rawPage),
        size = 20;
      const total = await db.order.count({ where: { customerId: c.id } });
      const items = await db.order.findMany({
        where: { customerId: c.id },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * size,
        take: size,
        select: {
          id: true,
          number: true,
          createdAt: true,
          status: true,
          totalAmount: true,
          currency: true,
        },
      });
      return {
        items,
        pageInfo: {
          page,
          size,
          total,
          pageCount: Math.max(1, Math.ceil(total / size)),
        },
      };
    },
  };
}
const addressSelect = {
  id: true,
  label: true,
  name: true,
  line1: true,
  line2: true,
  postalCode: true,
  city: true,
  country: true,
  phone: true,
  defaultShipping: true,
} as const;
export async function setCustomerDisabled(
  db: PrismaClient,
  authorize: Authorize,
  raw: unknown,
) {
  const { id, disabled } = z
      .object({ id: z.uuid(), disabled: z.boolean() })
      .strict()
      .parse(raw),
    actor = await authorize();
  return db.$transaction(async (tx) => {
    await assertInternalAccount(tx, actor.id);
    await tx.$queryRaw`SELECT id FROM customers WHERE id=${id}::uuid FOR UPDATE`;
    const c = await tx.customer.findUnique({ where: { id } });
    if (!c) throw new DomainError("NOT_FOUND", "Customer not found.");
    await tx.customer.update({
      where: { id },
      data: {
        status: disabled
          ? "DISABLED"
          : c.emailVerifiedAt
            ? "ACTIVE"
            : "PENDING_VERIFICATION",
      },
    });
    await tx.customerSession.deleteMany({ where: { customerId: id } });
    await tx.customerToken.deleteMany({ where: { customerId: id } });
    await tx.customerEvent.create({
      data: {
        customerId: id,
        type: disabled ? "DISABLED" : "REENABLED",
        actorUserId: actor.id,
      },
    });
  });
}
