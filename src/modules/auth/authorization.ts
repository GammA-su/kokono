import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { DomainError } from "../shared/errors";

export type InternalActor = { id: string };
export type Authorize = () => Promise<InternalActor>;

export async function assertInternalAccount(
  database: PrismaClient | Prisma.TransactionClient,
  userId: string | undefined,
): Promise<InternalActor> {
  if (!userId) throw new DomainError("UNAUTHENTICATED", "An internal session is required.");
  const user = await database.user.findUnique({
    where: { id: userId },
    select: { id: true, isInternal: true, active: true },
  });
  if (!user?.isInternal || !user.active) {
    throw new DomainError("FORBIDDEN", "An active internal account is required.");
  }
  return { id: user.id };
}
