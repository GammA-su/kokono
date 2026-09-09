import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { withInternalTransaction } from "../auth/transaction";
import type { Authorize } from "../auth/authorization";
import { locationPaths } from "../locations/queries";
import { configInclude, poolReadiness } from "./service";
import { probability } from "./odds";
import { customerGachaEnabled } from "./customer-service";
import { gachaPolicy } from "./validation";
/** Public discovery of reviewed configurations. No actor, recipient, costs or mutable inventory rows. */
export async function publicGachaBanners(
  db: PrismaClient,
  rawPage: unknown = 1,
) {
  const requested = z.coerce.number().int().min(1).catch(1).parse(rawPage),
    size = 24;
  return db.$transaction(
    async (tx) => {
      const where = { currentConfigurationId: { not: null } },
        total = await tx.gachaBanner.count({ where }),
        pageCount = Math.max(1, Math.ceil(total / size)),
        page = Math.min(requested, pageCount);
      const rows = await tx.gachaBanner.findMany({
        where,
        orderBy: [{ active: "desc" }, { createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * size,
        take: size,
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          active: true,
          customerEnabled: true,
          startsAt: true,
          endsAt: true,
        },
      });
      return {
        items: rows.map((b) => ({
          id: b.id,
          slug: b.slug,
          name: b.name,
          description: b.description,
          active: b.active,
          startsAt: b.startsAt?.toISOString() ?? null,
          endsAt: b.endsAt?.toISOString() ?? null,
          artwork: null,
          price: null,
          publicDrawsEnabled: customerGachaEnabled() && b.customerEnabled,
        })),
        pageInfo: { page, size, total, pageCount },
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
export function createGachaQueries(db: PrismaClient, authorize: Authorize) {
  return {
    list: (raw: unknown) =>
      withInternalTransaction(db, authorize, async (tx) => {
        const input = z
            .object({
              q: z.string().trim().max(100).catch(""),
              page: z.coerce.number().int().min(1).catch(1),
            })
            .parse(raw),
          where = input.q
            ? { name: { contains: input.q, mode: "insensitive" as const } }
            : {};
        const total = await tx.gachaBanner.count({ where }),
          size = 30,
          pageCount = Math.max(1, Math.ceil(total / size)),
          page = Math.min(input.page, pageCount);
        const items = await tx.gachaBanner.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          skip: (page - 1) * size,
          take: size,
          include: {
            currentConfiguration: { select: { version: true } },
            _count: { select: { pulls: true } },
          },
        });
        return { items, total, size, pageCount, filters: { ...input, page } };
      }),
    detail: (raw: unknown, pageRaw: unknown = 1) =>
      withInternalTransaction(db, authorize, async (tx) => {
        const id = z.uuid().parse(raw),
          banner = await tx.gachaBanner.findUnique({
            where: { id },
            include: { currentConfiguration: { include: configInclude } },
          });
        if (!banner) return null;
        const readiness = await poolReadiness(tx, banner),
          total = await tx.gachaPull.count({ where: { bannerId: id } }),
          size = 30,
          pageCount = Math.max(1, Math.ceil(total / size)),
          page = Math.min(
            z.coerce.number().int().min(1).catch(1).parse(pageRaw),
            pageCount,
          );
        const pulls = await tx.gachaPull.findMany({
          where: { bannerId: id },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          skip: (page - 1) * size,
          take: size,
          include: {
            prize: true,
            configuration: {
              select: { version: true, digest: true, totalWeight: true },
            },
            actorUser: { select: { name: true } },
            reservation: true,
          },
        });
        const events = await tx.gachaEvent.findMany({
          where: { bannerId: id },
          orderBy: { createdAt: "desc" },
          take: 50,
          include: { actorUser: { select: { name: true } } },
        });
        const locations = await locationPaths(tx);
        return {
          banner,
          readiness: {
            ...readiness,
            remaining: Object.fromEntries(readiness.remaining),
          },
          pulls,
          events,
          locations,
          total,
          size,
          pageCount,
          page,
        };
      }),
  };
}
/** Dedicated read-only public selector. Never returns customer/actor/audit/storage data. */
export async function publicGachaOdds(db: PrismaClient, raw: string) {
  const slug = z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(180)
    .parse(raw);
  return db.$transaction(
    async (tx) => {
      const banner = await tx.gachaBanner.findUnique({
        where: { slug },
        include: { currentConfiguration: { include: configInclude } },
      });
      if (!banner?.currentConfiguration) return null;
      const config = banner.currentConfiguration,
        state = await poolReadiness(tx, banner);
      return {
        bannerId: banner.id,
        // Monetary pulls remain unavailable; customer eligibility is a private query.
        price: null,
        artwork: null,
        slug: banner.slug,
        name: banner.name,
        description: banner.description,
        active: banner.active,
        startsAt: banner.startsAt?.toISOString() ?? null,
        endsAt: banner.endsAt?.toISOString() ?? null,
        configurationId: config.id,
        version: config.version,
        configurationDigest: config.digest,
        terms: banner.terms,
        termsVersion: banner.termsVersion,
        selectionRule: "FIXED_WEIGHTS_STOP_ON_DEPLETION_V1",
        drawState: state.reason,
        paidDrawsEnabled: gachaPolicy().paidDrawsEnabled,
        publicDrawsEnabled: customerGachaEnabled() && banner.customerEnabled,
        prizes: config.prizes.map((p) => ({
          id: p.id,
          name: p.displayName,
          description: p.description,
          tier: p.tier,
          allocation: p.allocation,
          remaining: state.remaining.get(p.id) ?? 0,
          probability: probability(p.weight, config.totalWeight),
        })),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
