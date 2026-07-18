#!/usr/bin/env node
import {
  SMIRK_RAILWAY_PRODUCTION_TARGET,
} from "./lib/first-dollar-pending-env.mjs";
import { deploymentMatchesPendingActivation } from "./lib/pending-env-deployment-binding.mjs";
import { railwayDeployments } from "./railway-json.mjs";

const target = SMIRK_RAILWAY_PRODUCTION_TARGET;
const timeoutMs = Math.max(30_000, Number(process.env.SMIRK_PENDING_ACTIVATION_DEPLOY_TIMEOUT_MS || 15 * 60_000));
const pollMs = Math.max(1_000, Number(process.env.SMIRK_PENDING_ACTIVATION_DEPLOY_POLL_MS || 5_000));
const terminalFailures = new Set(["FAILED", "CRASHED", "CANCELED", "CANCELLED", "REMOVED"]);

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, ...detail }, null, 2));
  process.exit(1);
}

let baseline;
try {
  baseline = JSON.parse(String(process.env.SMIRK_PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON || ""));
} catch {
  fail("pending-env-deployment-baseline-json-invalid");
}
if (baseline?.ok !== true) fail("pending-env-deployment-baseline-not-ok");
if (baseline.pending !== true) {
  console.log(JSON.stringify({ ok: true, pending: false, waited: false, reason: "no-pending-first-dollar-env-manifest", target }, null, 2));
  process.exit(0);
}
if (
  baseline?.target?.projectId !== target.projectId
  || baseline?.target?.serviceId !== target.serviceId
  || baseline?.target?.environmentId !== target.environmentId
  || !/^[a-f0-9]{64}$/.test(String(baseline?.manifest?.digest || ""))
  || !/^[a-f0-9]{40}$/.test(String(baseline?.manifest?.commit || ""))
  || !/^smirk-first-dollar-activation:[a-f0-9]{40}:[a-f0-9]{64}:[a-f0-9]{24}$/.test(String(baseline?.uploadMessage || ""))
  || !Number.isFinite(Date.parse(baseline?.capturedAt || ""))
) {
  fail("pending-env-deployment-baseline-binding-invalid");
}

const baselineIds = new Set(Array.isArray(baseline.baselineDeploymentIds) ? baseline.baselineDeploymentIds.map(String) : []);
const startedAt = Date.now();
let lastNewDeployments = [];
while (Date.now() - startedAt < timeoutMs) {
  try {
    const deployments = railwayDeployments({
      projectId: target.projectId,
      serviceId: target.serviceId,
      environmentId: target.environmentId,
      first: 20,
      quiet: true,
    });
    const newDeployments = deployments
      .filter((deployment) => deploymentMatchesPendingActivation({ deployment, baseline, target }))
      .sort((a, b) => Date.parse(b?.createdAt || 0) - Date.parse(a?.createdAt || 0));
    lastNewDeployments = newDeployments.map((deployment) => ({
      id: deployment.id,
      status: deployment.status,
      createdAt: deployment.createdAt,
      updatedAt: deployment.updatedAt,
    }));
    const succeeded = newDeployments.find((deployment) => String(deployment?.status || "").toUpperCase() === "SUCCESS");
    if (succeeded) {
      console.log(JSON.stringify({
        ok: true,
        pending: true,
        waited: true,
        target,
        manifest: baseline.manifest,
        deployment: {
          id: succeeded.id,
          status: succeeded.status,
          createdAt: succeeded.createdAt,
          updatedAt: succeeded.updatedAt,
        },
        message: "The exact nonce-bound Railway upload for this pending manifest completed successfully.",
      }, null, 2));
      process.exit(0);
    }
    const newest = newDeployments[0];
    if (newest && terminalFailures.has(String(newest.status || "").toUpperCase())) {
      fail("pending-env-activation-deployment-terminal-failure", { deployment: lastNewDeployments[0] });
    }
  } catch (error) {
    lastNewDeployments = [{ error: error?.detail || String(error?.message || error) }];
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

fail("pending-env-activation-deployment-timeout", {
  timeoutMs,
  baselineDeploymentIds: [...baselineIds],
  lastNewDeployments,
  target,
});
