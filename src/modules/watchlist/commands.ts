import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import { WatchPriority } from "../../generated/prisma/enums";
import type { Authorize } from "../auth/authorization";
import { createCatalogService } from "../catalog/service";
import { currencyCode, entityId } from "../shared/validation";
import { parseMoneyInput } from "../shared/money";
import { DomainError } from "../shared/errors";

const text = z.string().trim().max(20_000);
const schema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("checked"), merchandiseItemId: entityId })
    .strict(),
  z
    .object({ action: z.literal("disable"), merchandiseItemId: entityId })
    .strict(),
  z
    .object({
      action: z.literal("priority"),
      merchandiseItemId: entityId,
      priority: z.enum(WatchPriority),
    })
    .strict(),
  z
    .object({
      action: z.literal("save"),
      merchandiseItemId: entityId,
      enabled: z.boolean(),
      priority: z.enum(WatchPriority),
      targetQuantity: z.union([
        z.literal(""),
        z.coerce.number().int().positive().max(2147483647),
      ]),
      maxPrice: text,
      currency: currencyCode,
      condition: text,
      query: text,
      version: z.string().max(40).optional(),
    })
    .strict(),
]);
export function createWatchlistCommands(
  database: PrismaClient,
  authorize: Authorize,
) {
  const catalog = createCatalogService(database, authorize);
  return {
    execute: async (input: unknown) => {
      // Authenticate even invalid commands; domain services also recheck DB membership in their transactions.
      await authorize();
      const data = schema.parse(input);
      if (data.action === "checked")
        return catalog.markPurchaseWatchChecked(data.merchandiseItemId);
      if (data.action === "disable")
        return catalog.disablePurchaseWatch(data.merchandiseItemId);
      if (data.action === "priority")
        return catalog.savePurchaseWatch({
          merchandiseItemId: data.merchandiseItemId,
          priority: data.priority,
        });
      let maxUnitPriceAmount: number | null = null;
      if (data.maxPrice) {
        try {
          maxUnitPriceAmount = parseMoneyInput(data.maxPrice, data.currency);
        } catch (error) {
          throw new DomainError(
            "INVALID_PRICE",
            error instanceof Error ? error.message : "Invalid price.",
          );
        }
      }
      return catalog.savePurchaseWatch(
        {
          merchandiseItemId: data.merchandiseItemId,
          enabled: data.enabled,
          priority: data.priority,
          targetQuantity:
            data.targetQuantity === "" ? null : data.targetQuantity,
          maxUnitPriceAmount,
          maxUnitPriceCurrency: data.currency,
          conditionPreference: data.condition || null,
          marketplaceSearchQuery: data.query || null,
        },
        data.version === undefined ? undefined : data.version || null,
      );
    },
  };
}
