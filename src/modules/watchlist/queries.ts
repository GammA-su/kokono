import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";
import type { Authorize } from "../auth/authorization";
import { createCatalogQueries } from "../catalog/queries";
import { quantityNeeded, sourcingFilterSchema } from "./filters";

export function createWatchlistQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  const catalog = createCatalogQueries(database, authorize);
  return {
    list: async (input: unknown = {}) => {
      const data = z.record(z.string(), z.unknown()).parse(input);
      const sourcing = sourcingFilterSchema.parse(data);
      const result = await catalog.list(
        { archived: "true", ...data, watch: "enabled", sort: "priority" },
        sourcing,
      );
      return {
        ...result,
        filters: { ...result.filters, ...sourcing },
        items: result.items.map((item) => ({
          ...item,
          quantityNeeded: quantityNeeded(
            item.purchaseWatch?.targetQuantity ?? null,
            item.stock.total,
          ),
          japanOwned: item.stock.countries.JP ?? 0,
          franceOwned: item.stock.countries.FR ?? 0,
        })),
      };
    },
  };
}
