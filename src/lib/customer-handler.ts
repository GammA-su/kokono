import "server-only";
import { db } from "./db";
import { createCustomerHandler } from "../modules/customers/http";
import { configuredCustomerMail } from "../modules/customer-email/resend";

// Both namespaces share provider wiring so the session capability matches actual configured transport.
export const customerHandler = createCustomerHandler(
  db,
  configuredCustomerMail(),
);
