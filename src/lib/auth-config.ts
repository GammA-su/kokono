import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { PrismaClient } from "../generated/prisma/client";

// Factory also used by integration tests against real Better Auth sessions.
export function createAuth(database: PrismaClient, options: { baseURL: string; secret: string }) {
  if (options.secret.length < 32) throw new Error("BETTER_AUTH_SECRET must have at least 32 characters.");

  return betterAuth({
    appName: "Kokono Inventory",
    baseURL: options.baseURL,
    secret: options.secret,
    database: prismaAdapter(database, { provider: "postgresql", transaction: true }),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    user: {
      deleteUser: { enabled: false },
      additionalFields: {
        isInternal: { type: "boolean", defaultValue: false, input: false },
        active: { type: "boolean", defaultValue: true, input: false },
      },
    },
    session: { cookieCache: { enabled: false } },
  });
}
