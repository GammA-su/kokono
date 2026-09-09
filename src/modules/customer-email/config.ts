import { z } from "zod";

export type EmailEnvironment = Record<string, string | undefined>;
export interface CustomerEmailConfig {
  apiKey: string;
  from: string;
  replyTo?: string;
  siteOrigin: string;
  siteName: string;
}
const invalid = (field: string): never => {
  // Configuration errors name the setting only, never its potentially secret value.
  throw new Error(`Invalid or missing customer email configuration: ${field}.`);
};
function mailbox(value: string | undefined, field: string, named: boolean) {
  if (!value || value.length > 320 || /[\r\n]/.test(value))
    return invalid(field);
  const address =
    named && value.includes("<")
      ? /^[^<>\r\n]+ <([^<>]+)>$/.exec(value)?.[1]
      : value;
  if (!z.email().max(254).safeParse(address).success) return invalid(field);
  return value;
}
function frontendOrigin(
  value: string | undefined,
  field: string,
  production: boolean,
) {
  if (!value) return invalid(field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(field);
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return invalid(field);
  if (
    url.protocol !== "https:" &&
    (production || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    return invalid(field);
  return url.origin;
}
/** Explicit opt-in. Incomplete enabled configuration fails at provider construction. */
export function customerEmailConfig(
  env: EmailEnvironment = process.env,
): CustomerEmailConfig | null {
  const provider = env.CUSTOMER_EMAIL_PROVIDER ?? "disabled";
  if (provider === "disabled") return null;
  if (provider !== "resend") return invalid("CUSTOMER_EMAIL_PROVIDER");
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey || !/^re_[A-Za-z0-9_-]+$/.test(apiKey))
    return invalid("RESEND_API_KEY");
  const siteOrigin = frontendOrigin(
    env.SITE_ORIGIN ?? env.STOREFRONT_BASE_URL,
    "SITE_ORIGIN / STOREFRONT_BASE_URL",
    env.NODE_ENV === "production",
  );
  if (
    env.STOREFRONT_BASE_URL &&
    frontendOrigin(
      env.STOREFRONT_BASE_URL,
      "STOREFRONT_BASE_URL",
      env.NODE_ENV === "production",
    ) !== siteOrigin
  )
    return invalid("SITE_ORIGIN must match STOREFRONT_BASE_URL");
  const siteName = env.CUSTOMER_EMAIL_SITE_NAME ?? "Kokoni";
  if (!siteName.trim() || siteName.length > 80 || /[\r\n]/.test(siteName))
    return invalid("CUSTOMER_EMAIL_SITE_NAME");
  return {
    apiKey,
    from: mailbox(env.CUSTOMER_EMAIL_FROM, "CUSTOMER_EMAIL_FROM", true),
    ...(env.CUSTOMER_EMAIL_REPLY_TO
      ? {
          replyTo: mailbox(
            env.CUSTOMER_EMAIL_REPLY_TO,
            "CUSTOMER_EMAIL_REPLY_TO",
            false,
          ),
        }
      : {}),
    siteOrigin,
    siteName,
  };
}
