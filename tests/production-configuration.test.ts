import { expect, it } from "vitest";
import { resolve } from "node:path";
import { productionConfigurationIssues } from "../src/modules/operations/configuration";
const valid = { NODE_ENV: "production", DATABASE_URL: "postgresql://runtime:placeholder@db.test/kokoni?sslmode=verify-full", BETTER_AUTH_URL: "https://admin.test", STOREFRONT_BASE_URL: "https://shop.test", BETTER_AUTH_SECRET: "a".repeat(48), COMMERCE_GATEWAY_SECRET: "b".repeat(48), MERCHANDISE_UPLOAD_DIR: "C:/media", GACHA_DRAWS_ENABLED: "false", GACHA_CUSTOMER_EXECUTION_ENABLED: "false", COMMERCE_TEST_CHECKOUT_ENABLED: "false", CUSTOMER_REQUIRE_VERIFIED_EMAIL: "false", STOREFRONT_PRODUCT_ROUTES_READY: "true" };
it("accepts structurally complete configuration without enabling payments or changing verification policy", () => {
  expect(productionConfigurationIssues({ ...valid, MERCHANDISE_UPLOAD_DIR: resolve(".local") })).toEqual([]);
});
it("rejects HTTP, absent TLS/short secrets, invalid policy and live Stripe without echoing values", () => {
  const secret = "sk_live_DO_NOT_LOG";
  const issues = productionConfigurationIssues({ ...valid, MERCHANDISE_UPLOAD_DIR: resolve(".local"), BETTER_AUTH_URL: "http://admin.test", DATABASE_URL: "postgresql://secret:private@host/db", COMMERCE_GATEWAY_SECRET: "short", STRIPE_SECRET_KEY: secret, COMMERCE_POLICY_JSON: "invalid" });
  expect(issues).toHaveLength(5);
  expect(JSON.stringify(issues)).not.toMatch(/DO_NOT_LOG|private|http:\/\//);
});
