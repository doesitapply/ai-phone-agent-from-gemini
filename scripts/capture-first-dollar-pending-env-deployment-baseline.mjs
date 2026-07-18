#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS,
  SMIRK_RAILWAY_PRODUCTION_TARGET,
  evaluateFirstDollarPendingEnvActivation,
  exactRailwayProductionTargetMatches,
} from "./lib/first-dollar-pending-env.mjs";
import { pendingActivationUploadMessage } from "./lib/pending-env-deployment-binding.mjs";
import { railwayDeployments, railwayProjectContext, railwayVariables } from "./railway-json.mjs";

const target = SMIRK_RAILWAY_PRODUCTION_TARGET;
const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, ...detail }, null, 2));
  process.exit(1);
}

try {
  const context = railwayProjectContext({
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
  });
  const targetEvaluation = exactRailwayProductionTargetMatches(context);
  if (!targetEvaluation.ok) fail("pending-env-deployment-baseline-target-mismatch", targetEvaluation);
  const vars = railwayVariables({
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
  });
  const evaluation = evaluateFirstDollarPendingEnvActivation({
    vars,
    currentCommit,
    confirmations: {
      deploy: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.deploy.env],
      deployCommit: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.deployCommit.env],
      pendingDigest: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.pendingDigest.env],
      activationDeploy: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.activationDeploy.env],
      realStarterCheckout: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.realStarterCheckout.env],
    },
  });
  if (!evaluation.ok) fail("pending-env-deployment-baseline-not-authorized", { failures: evaluation.failures });
  if (!evaluation.pending) {
    console.log(JSON.stringify({ ok: true, pending: false, target }, null, 2));
    process.exit(0);
  }

  const capturedAt = new Date().toISOString();
  const uploadMessage = pendingActivationUploadMessage({
    commit: evaluation.manifest.commit,
    digest: evaluation.manifest.digest,
    nonce: randomBytes(12).toString("hex"),
  });
  const deployments = railwayDeployments({
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
    first: 20,
  });
  const wrongTarget = deployments.filter((deployment) => (
    (deployment?.serviceId && deployment.serviceId !== target.serviceId)
    || (deployment?.environmentId && deployment.environmentId !== target.environmentId)
  ));
  if (wrongTarget.length > 0) fail("pending-env-deployment-baseline-result-target-mismatch");
  const ordered = [...deployments].sort((a, b) => Date.parse(b?.createdAt || 0) - Date.parse(a?.createdAt || 0));
  console.log(JSON.stringify({
    ok: true,
    pending: true,
    target,
    manifest: evaluation.manifest,
    uploadMessage,
    capturedAt,
    baselineDeploymentIds: ordered.map((deployment) => String(deployment?.id || "")).filter(Boolean),
    latestDeployment: ordered[0] ? {
      id: ordered[0].id,
      status: ordered[0].status,
      createdAt: ordered[0].createdAt,
    } : null,
  }, null, 2));
} catch (error) {
  fail("pending-env-deployment-baseline-failed", { detail: error?.detail || String(error?.message || error) });
}
