import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { MovementType } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { currencyCode, databaseInteger, entityId } from "../shared/validation";
import { parseMoneyInput } from "../shared/money";
import { DomainError } from "../shared/errors";
import { applyInventoryOperation } from "./operations";

const optional = z.string().trim().max(20_000).default("");
const commandSchema = z
  .object({
    merchandiseItemId: entityId,
    operationKey: z.string().trim().min(1).max(200),
    movementType: z.enum(MovementType),
    quantity: z.coerce
      .number()
      .pipe(databaseInteger)
      .refine((n) => n !== 0, "Quantity cannot be zero."),
    direction: z.enum(["in", "out"]).default("out"),
    locationId: optional,
    sourceLocationId: optional,
    destinationLocationId: optional,
    unitCost: optional,
    currency: optional,
    reference: z.string().trim().max(200).default(""),
    reason: z.string().trim().max(2000).default(""),
    note: z.string().trim().max(17_000).default(""),
  })
  .strict();

export function parseInventoryCommand(input: unknown) {
  const data = commandSchema.parse(input);
  const type = data.movementType;
  if (type !== "ADJUSTMENT" && data.quantity < 0)
    throw new DomainError(
      "INVALID_QUANTITY",
      "Enter a positive quantity. Use direction or a signed adjustment to remove stock.",
    );
  if (type === "ADJUSTMENT" && (!data.reason || !data.note))
    throw new DomainError(
      "REASON_REQUIRED",
      "Adjustments require both a reason and a note.",
    );
  const outgoing =
    ["SALE", "DAMAGED", "LOST"].includes(type) ||
    (!["PURCHASE", "TRANSFER", "ADJUSTMENT"].includes(type) &&
      data.direction === "out");
  const delta =
    type === "ADJUSTMENT"
      ? data.quantity
      : outgoing
        ? -data.quantity
        : data.quantity;
  if (!!data.unitCost !== !!data.currency)
    throw new DomainError(
      "COST_REQUIRED",
      "Provide acquisition unit cost and currency together, or leave both empty.",
    );
  if (data.unitCost && (delta < 0 || type === "TRANSFER"))
    throw new DomainError(
      "INVALID_COST",
      "Record acquisition costs only when receiving stock.",
    );
  let cost: number | null = null;
  const currency = data.currency
    ? currencyCode.parse(data.currency.toUpperCase())
    : null;
  if (currency) {
    try {
      cost = parseMoneyInput(data.unitCost, currency);
    } catch (error) {
      throw new DomainError(
        "INVALID_COST",
        error instanceof Error ? error.message : "Invalid acquisition cost.",
      );
    }
  }
  return {
    merchandiseItemId: data.merchandiseItemId,
    operationKey: data.operationKey,
    movementType: type,
    quantityDelta: delta,
    sourceLocationId:
      type === "TRANSFER"
        ? data.sourceLocationId
        : delta < 0
          ? data.locationId
          : null,
    destinationLocationId:
      type === "TRANSFER"
        ? data.destinationLocationId
        : delta > 0
          ? data.locationId
          : null,
    acquisitionUnitCostAmount: cost,
    acquisitionUnitCostCurrency: currency,
    referenceType: data.reference ? "MANUAL" : null,
    referenceId: data.reference || null,
    notes:
      type === "ADJUSTMENT"
        ? `Reason: ${data.reason}\nNote: ${data.note}`
        : data.note || null,
  };
}

export function createInventoryCommands(
  database: PrismaClient,
  authorize: Authorize,
) {
  return {
    execute: async (input: unknown) => {
      const actor = await authorize();
      return applyInventoryOperation(
        database,
        parseInventoryCommand(input),
        actor.id,
      );
    },
  };
}
