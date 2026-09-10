import type { PrismaClient } from "../../generated/prisma/client";
import { latestAcquisitionSql } from "./aggregates";
import type { Authorize } from "../auth/authorization";
import { withInternalTransaction } from "../auth/transaction";
import { createCatalogQueries } from "../catalog/queries";
import { searchParamsRecord } from "../shared/validation";

type Acquisition = {
  itemId: string;
  amount: number;
  currency: string;
  date: Date;
  movementId: string;
};
export function createInventoryQueries(
  database: PrismaClient,
  authorize: Authorize,
) {
  const catalog = createCatalogQueries(database, authorize);
  return {
    overview: async (input: unknown = {}) => {
      const data = searchParamsRecord.parse(input);
      // Inventory includes archived merchandise and inactive storage by default.
      const result = await catalog.list({
        sort: "alphabetical",
        archived: "true",
        stock: "has",
        ...data,
      });
      const ids = result.items.map((item) => item.id);
      const costs = await withInternalTransaction(
        database,
        authorize,
        async (tx) => {
          if (!ids.length) return [] as Acquisition[];
          return tx.$queryRaw<Acquisition[]>(latestAcquisitionSql(ids));
        },
      );
      const byId = new Map(costs.map((cost) => [cost.itemId, cost]));
      return {
        ...result,
        items: result.items.map((item) => {
          const acquisition = byId.get(item.id) ?? null;
          return {
            ...item,
            acquisition,
            estimatedValue: acquisition
              ? {
                  amount: BigInt(acquisition.amount) * BigInt(item.stock.total),
                  currency: acquisition.currency,
                }
              : null,
          };
        }),
      };
    },
  };
}
