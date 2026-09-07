import { z } from "zod";
import { MovementType } from "../../generated/prisma/enums";
import { currencyCode, databaseInteger, entityId, moneyAmount } from "../shared/validation";

export const inventoryOperationSchema = z.object({
  merchandiseItemId: entityId,
  movementType: z.enum(MovementType),
  quantityDelta: databaseInteger.refine((n) => n !== 0, "Quantity cannot be zero."),
  sourceLocationId: entityId.nullable().default(null),
  destinationLocationId: entityId.nullable().default(null),
  operationKey: z.string().trim().min(1).max(200),
  acquisitionUnitCostAmount: moneyAmount.nullable().default(null),
  acquisitionUnitCostCurrency: currencyCode.nullable().default(null),
  notes: z.string().trim().min(1).max(20_000).nullable().default(null),
  referenceType: z.string().trim().min(1).max(100).nullable().default(null),
  referenceId: z.string().trim().min(1).max(200).nullable().default(null),
}).strict().superRefine((data, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const source = data.sourceLocationId;
  const destination = data.destinationLocationId;
  if (data.movementType === MovementType.TRANSFER) {
    if (!source || !destination || source === destination || data.quantityDelta <= 0) {
      issue("Transfers require distinct source/destination locations and a positive quantity.");
    }
  } else if (data.quantityDelta > 0 ? !destination || !!source : !source || !!destination) {
    issue("Incoming movements require only a destination; outgoing movements require only a source.");
  }
  if ([MovementType.PURCHASE, MovementType.GACHA].includes(data.movementType as "PURCHASE" | "GACHA") && data.quantityDelta < 0) {
    issue("Purchases and gacha acquisitions must add stock.");
  }
  if ([MovementType.SALE, MovementType.DAMAGED, MovementType.LOST].includes(data.movementType as "SALE" | "DAMAGED" | "LOST") && data.quantityDelta > 0) {
    issue("Sales, damage, and losses must remove stock.");
  }
  if ((data.acquisitionUnitCostAmount === null) !== (data.acquisitionUnitCostCurrency === null)) {
    issue("Acquisition amount and currency must be supplied together.");
  }
  if ((data.referenceType === null) !== (data.referenceId === null)) issue("Reference type and ID must be supplied together.");
  if (data.movementType === MovementType.ADJUSTMENT && !data.notes) issue("Adjustments require an explanation.");
});

export type InventoryOperation = z.input<typeof inventoryOperationSchema>;
