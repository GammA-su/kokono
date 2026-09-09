import "dotenv/config";
import { access, constants } from "node:fs/promises";
import { deploymentInfrastructureChecks, productionConfigurationIssues } from "../src/modules/operations/configuration";

/**
 * `--local-infrastructure` rehearses a production-like configuration on a developer machine.
 * It defers only the checks that need real deployment infrastructure (public HTTPS origins and
 * a TLS database) and enforces every other production rule unchanged. It is a command-line flag
 * on purpose: no environment variable can enable it, so a deployed service cannot weaken its own
 * preflight, and the output always states that this is not a production certification.
 */
const localInfrastructure = process.argv.includes("--local-infrastructure");
const issues = productionConfigurationIssues(process.env, { localInfrastructure });
if (process.env.MERCHANDISE_UPLOAD_DIR) {
  try { await access(process.env.MERCHANDISE_UPLOAD_DIR, constants.R_OK | constants.W_OK); }
  catch { issues.push("MERCHANDISE_UPLOAD_DIR: runtime user cannot read/write the directory"); }
}
console.log(JSON.stringify({
  check: "production-configuration",
  mode: localInfrastructure ? "local-production-like" : "production",
  ok: issues.length === 0,
  issues,
  ...(localInfrastructure ? { deferredToDeployment: deploymentInfrastructureChecks } : {}),
  limitations: localInfrastructure
    ? "Local rehearsal only. Deferred checks above are NOT verified and must pass unmodified on the deployment host. Does not certify DNS, TLS, database roles/migrations, persistent mounts, external providers, backups or schedules."
    : "Does not certify DNS, TLS connections, database roles/migrations, persistent mounts, external providers, backups, schedules or production readiness.",
}, null, 2));
if (issues.length) process.exitCode = 1;
