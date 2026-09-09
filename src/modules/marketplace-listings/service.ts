import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { assertInternalAccount, type Authorize } from "../auth/authorization";
import { createPurchaseInTransaction } from "../purchases/service";
import { DomainError } from "../shared/errors";
import {
  candidateInput,
  candidateUrl,
  conversionInput,
  editableStatuses,
} from "./validation";
import { listingUrlMetadata } from "./providers";

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function lock(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM marketplace_listings WHERE id = ${id}::uuid FOR UPDATE`;
  const row = await tx.marketplaceListing.findUnique({
    where: { id },
    include: { purchaseItem: true },
  });
  if (!row)
    throw new DomainError("NOT_FOUND", "Marketplace candidate not found.");
  return row;
}
function checkEditable(
  row: { purchaseItemId: string | null; updatedAt: Date },
  version: string,
) {
  if (row.purchaseItemId)
    throw new DomainError(
      "CONVERTED",
      "This candidate is linked to a purchase. Manage that purchase separately; its source record is preserved.",
    );
  if (row.updatedAt.toISOString() !== version)
    throw new DomainError(
      "CONFLICT",
      "This candidate changed. Reload before saving.",
    );
}
export function createMarketplaceListingService(
  database: PrismaClient,
  authorize: Authorize,
) {
  async function run<T>(
    operation: (tx: Prisma.TransactionClient, actorId: string) => Promise<T>,
  ) {
    const actor = await authorize();
    return database.$transaction(
      async (tx) => {
        await assertInternalAccount(tx, actor.id);
        return operation(tx, actor.id);
      },
      { maxWait: 10000, timeout: 30000 },
    );
  }
  return {
    save: (input: unknown, version?: unknown) =>
      run(async (tx, actorId) => {
        const parsed = candidateInput.parse(input);
        const metadata = listingUrlMetadata(parsed.url);
        const data = {
          ...parsed,
          url: candidateUrl.parse(metadata.url),
          marketplace: metadata.marketplace ?? parsed.marketplace,
          externalListingId:
            parsed.externalListingId ?? metadata.externalListingId,
        };
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`marketplace-candidate:${data.id}`},0))::text`;
        const creationFingerprint = fingerprint({ data, actorId });
        if (version !== undefined) {
          const row = await lock(tx, data.id);
          checkEditable(row, z.iso.datetime().parse(version));
          if (row.merchandiseItemId !== data.merchandiseItemId)
            throw new DomainError(
              "INVALID_ITEM",
              "An offer cannot be reassigned to another catalog item.",
            );
        } else {
          const existing = await tx.marketplaceListing.findUnique({
            where: { id: data.id },
          });
          if (existing) {
            if (existing.creationFingerprint !== creationFingerprint)
              throw new DomainError(
                "CONFLICT",
                "This creation key was already used for a different candidate.",
              );
            return existing;
          }
        }
        const item = await tx.merchandiseItem.findFirst({
          where: {
            id: data.merchandiseItemId,
            archivedAt: null,
            lineup: { archivedAt: null, franchise: { archivedAt: null } },
          },
        });
        if (!item)
          throw new DomainError(
            "INVALID_ITEM",
            "Choose active catalog merchandise.",
          );
        // Serialize duplicate checks per item, including future connector calls.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`marketplace-item:${item.id}`},0))::text`;
        const duplicate = await tx.marketplaceListing.findFirst({
          where: {
            merchandiseItemId: item.id,
            id: { not: data.id },
            OR: [
              { url: data.url },
              ...(data.externalListingId
                ? [
                    {
                      marketplace: data.marketplace,
                      externalListingId: data.externalListingId,
                    },
                  ]
                : []),
            ],
          },
        });
        if (duplicate)
          throw new DomainError(
            "DUPLICATE",
            "This offer is already recorded for this merchandise item. Open the existing candidate instead.",
          );
        if (version !== undefined)
          return tx.marketplaceListing.update({ where: { id: data.id }, data });
        return tx.marketplaceListing.create({
          data: { ...data, creationFingerprint, createdByUserId: actorId },
        });
      }),
    setStatus: (input: unknown) =>
      run(async (tx) => {
        const parsed = z
          .object({
            id: z.uuid(),
            status: z.enum(editableStatuses),
            version: z.iso.datetime(),
          })
          .parse(input);
        const row = await lock(tx, parsed.id);
        checkEditable(row, parsed.version);
        return tx.marketplaceListing.update({
          where: { id: row.id },
          data: { status: parsed.status },
        });
      }),
    markChecked: (input: unknown) =>
      run(async (tx) => {
        const row = await lock(tx, z.uuid().parse(input));
        return tx.marketplaceListing.update({
          where: { id: row.id },
          data: { lastCheckedAt: new Date() },
        });
      }),
    convert: (input: unknown) =>
      run(async (tx, actorId) => {
        const parsed = conversionInput.parse(input);
        const row = await lock(tx, parsed.id);
        const conversionFingerprint = fingerprint(parsed);
        if (row.purchaseItem) {
          if (row.conversionFingerprint !== conversionFingerprint)
            throw new DomainError(
              "CONVERTED",
              "Already converted. Open the linked purchase; a second purchase was not created.",
            );
          return tx.purchase.findUniqueOrThrow({
            where: { id: row.purchaseItem.purchaseId },
            include: { items: true },
          });
        }
        checkEditable(row, parsed.version);
        if (row.status !== "AVAILABLE")
          throw new DomainError(
            "NOT_AVAILABLE",
            "Only an available candidate can be converted. Verify availability and update its status first.",
          );
        const purchase = await createPurchaseInTransaction(
          tx,
          {
            id: randomUUID(),
            supplier: parsed.supplier,
            marketplace: row.marketplace,
            externalReference: parsed.externalReference,
            purchaseDate: parsed.purchaseDate,
            status: parsed.status,
            currency: row.currency,
            domesticShippingAmount: parsed.domesticShippingAmount,
            feesAmount: parsed.feesAmount,
            taxesAmount: parsed.taxesAmount,
            notes: parsed.notes,
            items: [
              {
                merchandiseItemId: row.merchandiseItemId,
                quantity: parsed.quantity,
                unitPriceAmount: parsed.unitPriceAmount,
                condition: row.condition,
                sellerListingUrl: row.url,
                notes: `Marketplace candidate ${row.id}`,
              },
            ],
          },
          actorId,
        );
        await tx.marketplaceListing.update({
          where: { id: row.id },
          data: {
            status: "PURCHASED",
            purchaseItemId: purchase.items[0].id,
            conversionFingerprint,
          },
        });
        return purchase;
      }),
  };
}
