import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { assertInternalAccount, type Authorize } from "./authorization";

export async function withInternalTransaction<T>(
  database: PrismaClient,
  authorize: Authorize,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  const actor = await authorize();
  return database.$transaction(async (tx) => {
    await assertInternalAccount(tx, actor.id);
    return operation(tx);
  });
}
