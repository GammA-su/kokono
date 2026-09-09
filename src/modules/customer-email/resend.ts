import { createHash } from "node:crypto";
import { z } from "zod";
import type { CustomerMail, CustomerMailMessage } from "../customers/service";
import {
  customerEmailConfig,
  type CustomerEmailConfig,
  type EmailEnvironment,
} from "./config";
import { renderCustomerEmail } from "./templates";

/**
 * Account keys derive from 256-bit random token material; order keys derive from the order
 * number, which is the stable identity a replayed webhook or a repeated dispatch would reuse.
 * Neither form is ever a plaintext token, email address or customer ID.
 */
export function customerEmailIdempotencyKey(message: CustomerMailMessage) {
  const material =
    "token" in message
      ? `customer-email-v1:${message.purpose}:${message.token}`
      : `customer-email-v1:${message.purpose}:${message.order.number}`;
  return `customer-${message.purpose.toLowerCase().replaceAll("_", "-")}:${createHash("sha256").update(material).digest("hex")}`;
}
export function createResendCustomerMail(
  config: CustomerEmailConfig,
  transport: typeof fetch = fetch,
): CustomerMail {
  if (
    (process.env.NODE_ENV === "test" || process.env.VITEST) &&
    transport === fetch
  )
    throw new Error(
      "Live customer email is disabled in automated tests. Inject a test transport.",
    );
  return async (message) => {
    if (!z.email().max(254).safeParse(message.email).success)
      throw new Error("Invalid customer email recipient.");
    const rendered = renderCustomerEmail(config, message);
    try {
      // Native Node fetch is sufficient for this one fixed REST endpoint. No provider callback URL is accepted.
      const response = await transport("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": customerEmailIdempotencyKey(message),
        },
        body: JSON.stringify({
          from: config.from,
          to: [message.email],
          ...rendered,
          ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Provider rejected email.");
      }
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        !("id" in result) ||
        typeof result.id !== "string" ||
        !result.id ||
        "error" in result
      )
        throw new Error("Provider did not accept email.");
    } catch {
      // Do not propagate response bodies/errors: they can echo addresses, URLs, tokens or headers.
      // The existing domain invalidates the new token and retains its safe acknowledgement policy.
      throw new Error("Customer email delivery could not be confirmed.");
    }
  };
}
export function configuredCustomerMail(
  env: EmailEnvironment = process.env,
): CustomerMail | undefined {
  // Production-build HTTP tests explicitly disable the provider as well.
  if (env.NODE_ENV === "test" || env.VITEST) return undefined;
  const config = customerEmailConfig(env);
  return config ? createResendCustomerMail(config) : undefined;
}
