import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { entityId } from "../shared/validation";
import { DomainError } from "../shared/errors";
import { lineupInputSchema, sourcesSchema } from "./validation";

export function generatedSlug(name: string) {
  const stem =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 120) || "lineup";
  return `${stem}-${randomUUID().slice(0, 8)}`;
}
function sourceRows(sources: z.output<typeof sourcesSchema>) {
  return sources.map(({ checkedDate, ...source }) => ({
    ...source,
    checkedAt: checkedDate,
  }));
}
type SourceData = ReturnType<typeof sourceRows>[number];
async function syncSources(
  current: Array<{ id: string; url: string; checkedAt: Date | null }>,
  incoming: SourceData[],
  store: {
    create: (data: SourceData) => Promise<{ id: string }>;
    update: (id: string, data: SourceData) => Promise<{ id: string }>;
    remove: (ids: string[]) => Promise<unknown>;
  },
) {
  const retained = new Set<string>();
  for (const data of incoming) {
    const existing = current.find((source) => source.url === data.url);
    // Editing other fields should not recreate evidence or erase a precise check timestamp.
    const checkedAt =
      existing?.checkedAt &&
      existing.checkedAt.toISOString().slice(0, 10) ===
        data.checkedAt?.toISOString().slice(0, 10)
        ? existing.checkedAt
        : data.checkedAt;
    const saved = existing
      ? await store.update(existing.id, { ...data, checkedAt })
      : await store.create(data);
    retained.add(saved.id);
  }
  const removed = current
    .filter((source) => !retained.has(source.id))
    .map((source) => source.id);
  if (removed.length) await store.remove(removed);
}
async function lockedLineup(tx: Prisma.TransactionClient, input: unknown) {
  const id = entityId.parse(input);
  await tx.$queryRaw`SELECT id FROM lineups WHERE id = ${id}::uuid FOR UPDATE`;
  const row = await tx.lineup.findUnique({
    where: { id },
    include: { sources: true, _count: { select: { items: true } } },
  });
  if (!row)
    throw new DomainError("LINEUP_NOT_FOUND", "This lineup no longer exists.");
  return row;
}

export function createLineupService(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    save: (input: unknown, identity?: { id: string; updatedAt: string }) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const { sources, announcedDate, releaseDate, ...data } =
          lineupInputSchema.parse(input);
        const franchise = await tx.franchise.findUnique({
          where: { id: data.franchiseId },
        });
        if (!franchise || franchise.archivedAt)
          throw new DomainError(
            "FRANCHISE_UNAVAILABLE",
            "Choose an active franchise.",
          );
        const values = {
          ...data,
          announcedDate: announcedDate?.date ?? null,
          announcedDatePrecision: announcedDate?.precision ?? null,
          releaseDate: releaseDate?.date ?? null,
          releaseDatePrecision: releaseDate?.precision ?? null,
        };
        if (!identity)
          return tx.lineup.create({
            data: {
              ...values,
              slug: generatedSlug(data.name),
              sources: { create: sourceRows(sources) },
            },
          });
        const current = await lockedLineup(tx, identity.id);
        if (current.updatedAt.toISOString() !== identity.updatedAt)
          throw new DomainError(
            "EDIT_CONFLICT",
            "This lineup changed in another session. Reload before saving to avoid overwriting those changes.",
          );
        await syncSources(current.sources, sourceRows(sources), {
          create: (data) =>
            tx.lineupSource.create({ data: { ...data, lineupId: current.id } }),
          update: (id, data) => tx.lineupSource.update({ where: { id }, data }),
          remove: (ids) =>
            tx.lineupSource.deleteMany({
              where: { id: { in: ids }, lineupId: current.id },
            }),
        });
        return tx.lineup.update({ where: { id: current.id }, data: values });
      }),
    duplicate: (id: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const current = await lockedLineup(tx, id);
        if (
          (
            await tx.franchise.findUniqueOrThrow({
              where: { id: current.franchiseId },
            })
          ).archivedAt
        )
          throw new DomainError(
            "FRANCHISE_UNAVAILABLE",
            "Restore the franchise before duplicating this lineup.",
          );
        return tx.lineup.create({
          data: {
            franchiseId: current.franchiseId,
            name: `${current.name} (copy)`,
            japaneseName: current.japaneseName,
            slug: generatedSlug(current.name),
            description: current.description,
            manufacturer: current.manufacturer,
            announcedDate: current.announcedDate,
            announcedDatePrecision: current.announcedDatePrecision,
            releaseDate: current.releaseDate,
            releaseDatePrecision: current.releaseDatePrecision,
            status: current.status,
            mainImageStorageKey: current.mainImageStorageKey,
            notes: current.notes,
            // Verification applies to the original release. Copies must be checked again.
            sources: {
              create: current.sources.map((source) => ({
                provider: source.provider,
                sourceType: source.sourceType,
                url: source.url,
                notes: source.notes,
              })),
            },
          },
        });
      }),
    remove: (id: unknown, confirmedName: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const current = await lockedLineup(tx, id);
        if (confirmedName !== current.name)
          throw new DomainError(
            "CONFIRM_NAME",
            "Enter the lineup name exactly to confirm.",
          );
        if (current._count.items > 0) {
          await tx.lineup.update({
            where: { id: current.id },
            data: { archivedAt: new Date() },
          });
          return "archived" as const;
        }
        await tx.lineupSource.deleteMany({ where: { lineupId: current.id } });
        await tx.lineup.delete({ where: { id: current.id } });
        return "deleted" as const;
      }),
    restore: (id: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const current = await lockedLineup(tx, id);
        return tx.lineup.update({
          where: { id: current.id },
          data: { archivedAt: null },
        });
      }),
    saveItemSources: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const data = z
          .object({
            lineupId: entityId,
            itemId: entityId,
            updatedAt: z.string(),
            sources: sourcesSchema,
          })
          .strict()
          .parse(input);
        await tx.$queryRaw`SELECT id FROM merchandise_items WHERE id = ${data.itemId}::uuid FOR UPDATE`;
        const item = await tx.merchandiseItem.findFirst({
          where: { id: data.itemId, lineupId: data.lineupId },
          include: { sources: true },
        });
        if (!item)
          throw new DomainError(
            "ITEM_NOT_FOUND",
            "This item does not belong to this lineup.",
          );
        if (item.updatedAt.toISOString() !== data.updatedAt)
          throw new DomainError(
            "EDIT_CONFLICT",
            "This item changed in another session. Reload before saving.",
          );
        await syncSources(item.sources, sourceRows(data.sources), {
          create: (source) =>
            tx.itemSource.create({
              data: { ...source, merchandiseItemId: item.id },
            }),
          update: (id, source) =>
            tx.itemSource.update({ where: { id }, data: source }),
          remove: (ids) =>
            tx.itemSource.deleteMany({
              where: { id: { in: ids }, merchandiseItemId: item.id },
            }),
        });
        return tx.merchandiseItem.update({
          where: { id: item.id },
          data: { updatedAt: new Date() },
        });
      }),
  };
}
