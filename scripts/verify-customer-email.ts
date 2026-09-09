/**
 * Controlled external email acceptance. Sends real messages through the shipped Resend
 * transport to one operator-supplied recipient. Never prints API keys or tokens; only
 * provider message identifiers and status, which are safe to record as evidence.
 *
 *   npx tsx --env-file=.env scripts/verify-customer-email.ts --to you@example.test
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { customerEmailConfig } from "../src/modules/customer-email/config";
import { createResendCustomerMail, customerEmailIdempotencyKey } from "../src/modules/customer-email/resend";

const to = process.argv[process.argv.indexOf("--to") + 1];
if (!process.argv.includes("--to") || !to || to.startsWith("--"))
  throw new Error("Pass --to <recipient>. No default recipient is assumed.");

const config = customerEmailConfig();
if (!config) throw new Error("CUSTOMER_EMAIL_PROVIDER is disabled; nothing was sent.");
// A 32-byte base64url token has the exact shape the templates accept, without minting a
// real database token: these messages must not grant access to any account.
const token = () => randomBytes(32).toString("base64url");

const results: Record<string, unknown>[] = [];
async function attempt(name: string, run: () => Promise<void>) {
  const started = Date.now();
  try {
    await run();
    results.push({ check: name, outcome: "accepted", ms: Date.now() - started });
    console.log(`${name}: accepted`);
  } catch (error) {
    results.push({ check: name, outcome: "rejected", ms: Date.now() - started,
      message: error instanceof Error ? error.message : "failed" });
    console.log(`${name}: rejected (${error instanceof Error ? error.message : "failed"})`);
  }
}

const send = createResendCustomerMail(config);
console.log(`Sender domain: ${config.from.replace(/^.*<|>$/g, "")}`);
console.log(`Recipient: ${to}`);

await attempt("verify_email_delivery", () => send({ email: to, purpose: "VERIFY", token: token() }));
await attempt("reset_email_delivery", () => send({ email: to, purpose: "RESET", token: token() }));

// §14 failure paths, exercised against the real provider and the real transport.
await attempt("invalid_credential_rejected", () =>
  createResendCustomerMail({ ...config, apiKey: "re_invalid_credential_test" })({ email: to, purpose: "VERIFY", token: token() }));
await attempt("unverified_sender_rejected", () =>
  createResendCustomerMail({ ...config, from: "Kokoni <noreply@definitely-not-verified.invalid>" })({ email: to, purpose: "VERIFY", token: token() }));
await attempt("provider_timeout_rejected", () =>
  createResendCustomerMail(config, ((() =>
    new Promise((_, reject) => setTimeout(() => reject(new Error("simulated timeout")), 10))) as unknown as typeof fetch))(
    { email: to, purpose: "VERIFY", token: token() }));
await attempt("invalid_recipient_rejected", () => send({ email: "not-an-address", purpose: "VERIFY", token: token() }));

// Idempotency keys are derived from token material, so a replayed identical message
// collapses at the provider instead of delivering twice.
const replay = { email: to, purpose: "VERIFY" as const, token: token() };
await attempt("replay_first_send", () => send(replay));
await attempt("replay_same_token_again", () => send(replay));
const key = customerEmailIdempotencyKey(replay);
console.log(`Idempotency key is a digest, not the token: ${/^customer-verify:[a-f0-9]{64}$/.test(key)}`);
console.log(`Key leaks token: ${key.includes(replay.token)}`);

await mkdir(resolve(".local/audit"), { recursive: true });
await writeFile(resolve(".local/audit/email-acceptance.json"),
  JSON.stringify({ at: new Date().toISOString(), sender: config.from, recipient: to,
    idempotencyKeyIsDigest: /^customer-verify:[a-f0-9]{64}$/.test(key),
    idempotencyKeyLeaksToken: key.includes(replay.token), results }, null, 2));
console.log("Saved .local/audit/email-acceptance.json");
