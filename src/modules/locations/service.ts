import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { StorageLocationType } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { entityId, name, optionalText } from "../shared/validation";

const locationSchema = z.object({
  code: name, name, type: z.enum(StorageLocationType), parentId: entityId.nullable().default(null),
  active: z.boolean().default(true), fulfillmentEnabled: z.boolean().default(false), notes: optionalText,
}).strict().refine((data) => data.type !== "IN_TRANSIT" || !data.fulfillmentEnabled, "In-transit locations cannot fulfill sales.");

export function createLocationService(database: PrismaClient, authorize: Authorize) {
  return {
    create: (input: unknown) => withInternalTransaction(database, authorize, (tx) => tx.storageLocation.create({ data: locationSchema.parse(input) })),
    reparent: (input: unknown) => withInternalTransaction(database, authorize, (tx) => {
      const data = z.object({ id: entityId, parentId: entityId.nullable() }).strict().parse(input);
      return tx.storageLocation.update({ where: { id: data.id }, data: { parentId: data.parentId } });
    }),
  };
}
