#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  FIRST_DOLLAR_ACTIVATED_ENV_RECEIPT,
  FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS,
  SMIRK_RAILWAY_PRODUCTION_TARGET,
  evaluateFirstDollarPendingEnvActivation,
  exactRailwayProductionTargetMatches,
} from "./lib/first-dollar-pending-env.mjs";
import { deploymentMatchesPendingActivation } from "./lib/pending-env-deployment-binding.mjs";
import { railwayDeployments, railwayProjectContext, railwaySetVariable, railwayVariables } from "./railway-json.mjs";

const target = SMIRK_RAILWAY_PRODUCTION_TARGET;
const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function readExactTargetVars() {
  const context = railwayProjectContext({
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
  });
  const targetEvaluation = exactRailwayProductionTargetMatches(context);
  if (!targetEvaluation.ok) throw new Error("pending-env-railway-target-mismatch");
  return railwayVariables({
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
  });
}

function readVerifiedSuccessfulActivationDeployment(evaluation) {
  let baseline;
  try {
    baseline = JSON.parse(String(process.env.SMIRK_PENDING_ACTIVATION_DEPLOYMENT_BASELINE_JSON || ""));
  } catch {
    throw new Error("pending-env-activation-deployment-baseline-json-invalid");
  }
  const expectedMessagePrefix = `smirk-first-dollar-activation:${evaluation.manifest.commit}:${evaluation.manifest.digest}:`;
  if (baseline?.ok !== true
    || baseline?.pending !== true
    || baseline?.target?.projectId !== target.projectId
    || baseline?.target?.serviceId !== target.serviceId
    || baseline?.target?.environmentId !== target.environmentId
    || baseline?.manifest?.commit !== evaluation.manifest.commit
    || baseline?.manifest?.digest !== evaluation.manifest.digest
    || !new RegExp(`^${expectedMessagePrefix}[a-f0-9]{24}$`).test(String(baseline?.uploadMessage || ""))
    || !Number.isFinite(Date.parse(String(baseline?.capturedAt || "")))
    || !Array.isArray(baseline?.baselineDeploymentIds)) {
    throw new Error("pending-env-activation-deployment-baseline-binding-invalid");
  }
  const deployments = railwayDeployments({
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
    first: 20,
  });
  const succeeded = deployments.find((deployment) => (
    deploymentMatchesPendingActivation({ deployment, baseline, target })
    && String(deployment?.status || "").toUpperCase() === "SUCCESS"
  ));
  if (!succeeded) throw new Error("pending-env-exact-activation-deployment-success-not-found");
  return { baseline, deployment: succeeded };
}

try {
  const vars = readExactTargetVars();
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
  if (!evaluation.ok) throw new Error(`pending-env-activation-receipt-not-authorized:${evaluation.failures.join(",")}`);
  if (!evaluation.pending) {
    console.log(JSON.stringify({
      ok: true,
      recorded: false,
      alreadyActivated: evaluation.activated === true,
      reason: evaluation.activated === true ? "activation-receipt-already-matches" : "no-pending-first-dollar-env-manifest",
      target,
    }, null, 2));
    process.exit(0);
  }

  const verifiedRollout = readVerifiedSuccessfulActivationDeployment(evaluation);
  // This command is intentionally repeated here. The receipt is a durable
  // bypass for future ordinary deploys, so direct invocation must independently
  // prove current live parity and every ship gate rather than trust deploy.sh.
  execFileSync("npm", ["run", "-s", "check:ship-live"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  const beforeWrite = readExactTargetVars();
  const beforeWriteEvaluation = evaluateFirstDollarPendingEnvActivation({
    vars: beforeWrite,
    currentCommit,
    confirmations: {
      deploy: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.deploy.env],
      deployCommit: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.deployCommit.env],
      pendingDigest: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.pendingDigest.env],
      activationDeploy: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.activationDeploy.env],
      realStarterCheckout: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.realStarterCheckout.env],
    },
  });
  if (!beforeWriteEvaluation.ok
    || !beforeWriteEvaluation.pending
    || beforeWriteEvaluation.manifest?.digest !== evaluation.manifest.digest) {
    throw new Error("pending-env-activation-state-changed-during-ship-verification");
  }

  railwaySetVariable(FIRST_DOLLAR_ACTIVATED_ENV_RECEIPT, evaluation.manifest.digest, {
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
    skipDeploys: true,
  });
  const after = readExactTargetVars();
  const afterEvaluation = evaluateFirstDollarPendingEnvActivation({
    vars: after,
    currentCommit,
    requireConfirmations: false,
  });
  if (!afterEvaluation.ok
    || afterEvaluation.pending
    || afterEvaluation.activated !== true
    || afterEvaluation.manifest?.digest !== evaluation.manifest.digest) {
    throw new Error("pending-env-activation-receipt-raced-with-restaging-or-drift");
  }
  console.log(JSON.stringify({
    ok: true,
    recorded: true,
    digest: evaluation.manifest.digest,
    deploymentId: String(verifiedRollout.deployment.id),
    receipt: FIRST_DOLLAR_ACTIVATED_ENV_RECEIPT,
    target,
    skipDeploys: true,
    message: "Activation receipt recorded without erasing pending-manifest evidence or triggering another deployment.",
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: "pending-env-activation-receipt-failed",
    detail: error?.detail || String(error?.message || error),
  }, null, 2));
  process.exit(1);
}
