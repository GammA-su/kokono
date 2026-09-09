import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { StorageLocationType } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { entityId, name, optionalText } from "../shared/validation";
import { DomainError } from "../shared/errors";
import type { Prisma } from "../../generated/prisma/client";

const locationSchema = z
  .object({
    code: name,
    name,
    type: z.enum(StorageLocationType),
    parentId: entityId.nullable().default(null),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    active: z.boolean().default(true),
    fulfillmentEnabled: z.boolean().default(false),
    notes: optionalText,
  })
  .strict()
  .refine(
    (data) => data.type !== "IN_TRANSIT" || !data.fulfillmentEnabled,
    "In-transit locations cannot fulfill sales.",
  );

async function validateParent(
  tx: Prisma.TransactionClient,
  id: string | null,
  parentId: string | null,
) {
  // Same lock as the database hierarchy trigger, before any validation/row lock.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || '.storage_locations:hierarchy', 0))::text`;
  if (!parentId) return;
  const ancestors = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE path AS (
      SELECT id, parent_id FROM storage_locations WHERE id = ${parentId}::uuid
      UNION SELECT p.id, p.parent_id FROM storage_locations p JOIN path c ON c.parent_id = p.id
    ) SELECT id::text FROM path`;
  if (!ancestors.length)
    throw new DomainError(
      "LOCATION_NOT_FOUND",
      "The parent location no longer exists.",
    );
  if (ancestors.some((row) => row.id === id))
    throw new DomainError(
      "LOCATION_CYCLE",
      "A location cannot be its own parent or move inside one of its descendants.",
    );
}

export function createLocationService(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    create: (input: unknown) =>
      withInternalTransaction(database, authorize, (tx) =>
        createLocationInTransaction(tx, input),
      ),
    update: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const { id, updatedAt, values } = z
          .object({
            id: entityId,
            updatedAt: z.string(),
            values: locationSchema,
          })
          .strict()
          .parse(input);
        await validateParent(tx, id, values.parentId);
        const current = await tx.storageLocation.findUnique({ where: { id } });
        if (!current)
          throw new DomainError(
            "LOCATION_NOT_FOUND",
            "This location no longer exists.",
          );
        if (current.updatedAt.toISOString() !== updatedAt)
          throw new DomainError(
            "EDIT_CONFLICT",
            "This location changed in another session. Reload before saving.",
          );
        return tx.storageLocation.update({ where: { id }, data: values });
      }),
    reparent: (input: unknown) =>
      withInternalTransaction(database, authorize, async (tx) => {
        const data = z
          .object({ id: entityId, parentId: entityId.nullable() })
          .strict()
          .parse(input);
        await validateParent(tx, data.id, data.parentId);
        return tx.storageLocation.update({
          where: { id: data.id },
          data: { parentId: data.parentId },
        });
      }),
  };
}

/** Trusted transaction composition for physical shipment storage; caller must authorize. */
export async function createLocationInTransaction(
  tx: Prisma.TransactionClient,
  input: unknown,
) {
  const data = locationSchema.parse(input);
  await validateParent(tx, null, data.parentId);
  return tx.storageLocation.create({
    data: {
      ...data,
      countryCode:
        data.countryCode === undefined
          ? data.type === "JAPAN_WAREHOUSE"
            ? "JP"
            : data.type === "FRANCE_HOME"
              ? "FR"
              : null
          : data.countryCode,
    },
  });
}
