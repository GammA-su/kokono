import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client";

const provisioningSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email().transform((email) => email.trim().toLowerCase()),
  password: z.string().min(12).max(128),
}).strict();

/** Trusted CLI operation only. No public route calls this function. Existing accounts are never overwritten. */
export async function provisionInternalUser(database: PrismaClient, input: unknown) {
  const data = provisioningSchema.parse(input);
  const password = await hashPassword(data.password);
  const id = randomUUID();
  return database.user.create({
    data: {
      id, name: data.name, email: data.email, isInternal: true,
      accounts: { create: { id: randomUUID(), accountId: id, providerId: "credential", password } },
    },
    select: { id: true, email: true },
  });
}
