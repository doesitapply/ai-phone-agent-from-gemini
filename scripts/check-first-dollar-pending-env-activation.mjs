#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { buildExactDeployCommand } from "./lib/deploy-command.mjs";
import {
  FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS,
  SMIRK_RAILWAY_PRODUCTION_TARGET,
  evaluateFirstDollarPendingEnvActivation,
  exactRailwayProductionTargetMatches,
} from "./lib/first-dollar-pending-env.mjs";
import { railwayProjectContext, railwayVariables } from "./railway-json.mjs";

const inspectOnly = process.argv.includes("--inspect");
const target = SMIRK_RAILWAY_PRODUCTION_TARGET;

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, ...detail }, null, 2));
  process.exit(1);
}

let currentCommit;
let branch;
try {
  currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim() || "main";
} catch (error) {
  fail("pending-env-git-state-unavailable", { detail: String(error?.message || error) });
}

let vars;
try {
  const context = railwayProjectContext({
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
  });
  const targetEvaluation = exactRailwayProductionTargetMatches(context);
  if (!targetEvaluation.ok) fail("pending-env-railway-target-mismatch", targetEvaluation);
  vars = railwayVariables({
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
  });
} catch (error) {
  fail("pending-env-railway-read-failed", { detail: error?.detail || String(error?.message || error) });
}

const evaluation = evaluateFirstDollarPendingEnvActivation({
  vars,
  currentCommit,
  requireConfirmations: !inspectOnly,
  confirmations: {
    deploy: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.deploy.env],
    deployCommit: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.deployCommit.env],
    pendingDigest: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.pendingDigest.env],
    activationDeploy: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.activationDeploy.env],
    realStarterCheckout: process.env[FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.realStarterCheckout.env],
  },
});

if (!evaluation.ok) {
  fail("pending-first-dollar-env-activation-not-authorized", {
    pending: evaluation.pending,
    failures: evaluation.failures,
    manifest: evaluation.manifest,
    nextAction: evaluation.pending
      ? "Run npm run -s print:first-dollar-pending-env-activation, obtain the exact digest-bound activation approval, then use its complete command."
      : null,
  });
}

if (!evaluation.pending) {
  console.log(JSON.stringify({
    ok: true,
    pending: false,
    activationRequired: false,
    target,
    message: "No pending first-dollar environment manifest is staged; ordinary exact-commit deploy authority applies.",
  }, null, 2));
  process.exit(0);
}

const digest = evaluation.manifest.digest;
const commit = evaluation.manifest.commit;
const baseDeployCommand = buildExactDeployCommand({ branch, commit });
const activationCommand = [
  `${FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.activationDeploy.env}=${FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.activationDeploy.value}`,
  `${FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.pendingDigest.env}=${digest}`,
  `${FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.realStarterCheckout.env}=${FIRST_DOLLAR_PENDING_ENV_CONFIRMATIONS.realStarterCheckout.value}`,
  baseDeployCommand,
].join(" ");

console.log(JSON.stringify({
  ok: true,
  pending: true,
  inspectOnly,
  activationRequired: true,
  activationAuthorized: !inspectOnly,
  target,
  manifest: evaluation.manifest,
  approvalPhrase: `APPROVE_SMIRK_FIRST_DOLLAR_ACTIVATION_DEPLOY: digest=${digest}; commit=${commit}; target=${target.projectId}/${target.serviceId}/${target.environmentId}; action=deploy-and-activate-starter-197-only`,
  activationCommand,
  postSuccess: "After the exact nonce-bound deployment and live ship checks pass, deploy.sh records the activated digest with --skip-deploys while preserving pending-manifest evidence; this does not trigger another deployment.",
}, null, 2));
