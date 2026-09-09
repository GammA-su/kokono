import { isAbsolute } from "node:path";
import { customerEmailConfig } from "../customer-email/config";
import { policySchema } from "../commerce/policy";
import { verificationPolicy } from "../customers/service";

/**
 * Requirements that can only be satisfied by real deployment infrastructure: public DNS, a
 * publicly trusted certificate and a TLS-capable managed database. A local host has none of
 * these, so a production-like local profile defers exactly these and nothing else. The set is
 * named here so the deferral is a reviewed list rather than a judgement made at the call site.
 */
export const deploymentInfrastructureChecks = [
  "BETTER_AUTH_URL: requires a public HTTPS origin",
  "STOREFRONT_BASE_URL: requires a public HTTPS origin",
  "DATABASE_URL: requires sslmode=verify-full against a TLS database",
] as const;

/**
 * Deployment preflight: field names only, never echo configuration values.
 *
 * `localInfrastructure` is a deliberate, caller-supplied escape hatch for rehearsing a
 * production-like configuration on a developer machine. It is never read from the environment,
 * so no deployed process can turn itself into a relaxed check by setting a variable; the only
 * way to reach it is an explicit command-line flag whose output states what was deferred.
 */
export function productionConfigurationIssues(
  env: Record<string, string | undefined>,
  options: { localInfrastructure?: boolean } = {},
) {
  const issues: string[] = [];
  const invalid = (field: string) => issues.push(`${field}: missing or invalid production configuration`);
  const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
  if (env.NODE_ENV !== "production") invalid("NODE_ENV");
  for (const field of ["BETTER_AUTH_URL", "STOREFRONT_BASE_URL"]) {
    try {
      const url = new URL(env[field] ?? "");
      // Everything except the transport is still enforced locally: shape, no credentials, no
      // path/query/fragment and no reserved example domain.
      if (url.pathname !== "/" || url.username || url.password || url.hash || url.search || url.hostname.endsWith(".example")) invalid(field);
      else if (url.protocol !== "https:" && !(options.localInfrastructure && url.protocol === "http:" && loopback(url.hostname))) invalid(field);
    } catch { invalid(field); }
  }
  if (env.SITE_ORIGIN && env.SITE_ORIGIN.replace(/\/$/, "") !== env.STOREFRONT_BASE_URL?.replace(/\/$/, "")) invalid("SITE_ORIGIN");
  for (const field of ["BETTER_AUTH_SECRET", "COMMERCE_GATEWAY_SECRET"])
    if ((env[field]?.length ?? 0) < 32 || /CHANGE_ME|REPLACE|<|>/.test(env[field] ?? "")) invalid(field);
  try {
    const url = new URL(env.DATABASE_URL ?? "");
    const tls = url.searchParams.get("sslmode") === "verify-full";
    if (!/^postgres(ql)?:$/.test(url.protocol) || !url.username || !url.password || !url.pathname.slice(1)) invalid("DATABASE_URL");
    else if (!tls && !(options.localInfrastructure && loopback(url.hostname))) invalid("DATABASE_URL");
  } catch { invalid("DATABASE_URL"); }
  if (!env.MERCHANDISE_UPLOAD_DIR || !isAbsolute(env.MERCHANDISE_UPLOAD_DIR)) invalid("MERCHANDISE_UPLOAD_DIR");
  for (const field of ["GACHA_DRAWS_ENABLED", "GACHA_CUSTOMER_EXECUTION_ENABLED", "COMMERCE_TEST_CHECKOUT_ENABLED", "CUSTOMER_REQUIRE_VERIFIED_EMAIL", "STOREFRONT_PRODUCT_ROUTES_READY"])
    if (!["true", "false"].includes(env[field] ?? "")) invalid(field);
  if (env.ALLOW_DEVELOPMENT_SEED === "true") invalid("ALLOW_DEVELOPMENT_SEED");
  // A typo here would silently remove a verification gate the operator believed was configured.
  try { verificationPolicy(env); } catch { invalid("CUSTOMER_VERIFICATION_POLICY"); }
  if (env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) invalid("STRIPE_SECRET_KEY: live payments are not implemented");
  if (env.COMMERCE_TEST_CHECKOUT_ENABLED === "true" && (!env.STRIPE_SECRET_KEY?.startsWith("sk_test_") || !env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_"))) invalid("Stripe test configuration");
  // The mail configuration derives its link origin from the same site origin relaxed above, so
  // it is relaxed the same way and for the same single reason: no public TLS on a local host.
  // Sender, key shape and site-name validation are unchanged.
  try {
    customerEmailConfig(options.localInfrastructure ? { ...env, NODE_ENV: "development" } : env);
  } catch { invalid("Customer email configuration"); }
  try { policySchema.parse(env.COMMERCE_POLICY_JSON ? JSON.parse(env.COMMERCE_POLICY_JSON) : {}); } catch { invalid("COMMERCE_POLICY_JSON"); }
  return issues;
}
