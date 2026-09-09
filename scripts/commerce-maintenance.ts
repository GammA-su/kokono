import { createDatabaseClient } from "../src/db/client";
import { expireReservations } from "../src/modules/commerce/service";
import { createPaymentService } from "../src/modules/commerce/payments";
import {
  paymentConfiguration,
  stripeProvider,
} from "../src/modules/commerce/stripe";
const db = createDatabaseClient(process.env.DATABASE_URL ?? "");
try {
  const expired = await expireReservations(db);
  const payments = paymentConfiguration().enabled
    ? await createPaymentService(db, stripeProvider()).reconcile()
    : { disabled: true };
  const deleted = await db.checkoutQuote.deleteMany({
    where: {
      order: null,
      createdAt: { lt: new Date(Date.now() - 30 * 86400000) },
    },
  });
  console.log(
    JSON.stringify({ expired, payments, expiredQuotesRemoved: deleted.count }),
  );
  if ("failed" in payments && payments.failed) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
