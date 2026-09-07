import { createDatabaseClient } from "../src/db/client";
import { provisionInternalUser } from "../src/modules/auth/provision";

const database = createDatabaseClient(process.env.DATABASE_URL ?? "");
try {
  const user = await provisionInternalUser(database, {
    name: process.env.PROVISION_NAME,
    email: process.env.PROVISION_EMAIL,
    password: process.env.PROVISION_PASSWORD,
  });
  console.log(`Provisioned internal account: ${user.email}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Account provisioning failed.");
  process.exitCode = 1;
} finally {
  delete process.env.PROVISION_PASSWORD;
  await database.$disconnect();
}
