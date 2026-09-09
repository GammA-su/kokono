import { createDatabaseClient } from "../src/db/client";
const database = createDatabaseClient(process.env.DATABASE_URL!);
try {
  const now = new Date();
  const sessions = await database.customerSession.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  const tokens = await database.customerToken.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  const limits = await database.customerRateLimit.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  console.log(
    `Removed ${sessions.count} expired sessions, ${tokens.count} expired tokens, ${limits.count} expired rate-limit windows.`,
  );
} finally {
  await database.$disconnect();
}
