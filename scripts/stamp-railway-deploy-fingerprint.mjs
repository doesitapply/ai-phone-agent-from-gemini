#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { railwaySetVariable, railwayVariables } from "./railway-json.mjs";
import {
  DEPLOY_BRANCH_CONFIRMATION_ENV,
  DEPLOY_COMMIT_CONFIRMATION_ENV,
  DEPLOY_CONFIRMATION_ENV,
  FIRST_DOLLAR_BOOTSTRAP_MODE_ENV,
  evaluateFirstDollarBootstrapDeploy,
} from "./lib/first-dollar-bootstrap-deploy.mjs";

const apply = process.argv.includes("--apply");

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...options }).trim();
}

function runResult(cmd, args) {
  try {
    return {
      ok: true,
      output: run(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }),
    };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout || ""}${error.stderr || ""}`.trim(),
    };
  }
}

function assertLiveRailwayEnvReady() {
  const liveEnv = runResult("npm", ["run", "-s", "check:railway:first-dollar-env"]);
  if (liveEnv.ok) {
    if (liveEnv.output) process.stderr.write(`${liveEnv.output}\n`);
    return { ready: true, bootstrapExceptionUsed: false };
  }

  if (liveEnv.output) process.stderr.write(`${liveEnv.output}\n`);
  const preflightResult = runResult("npm", ["run", "-s", "check:deploy-post-call-fix-ready"]);
  let preflight = null;
  try {
    preflight = preflightResult.output ? JSON.parse(preflightResult.output) : null;
  } catch {
    preflight = null;
  }
  const evaluation = evaluateFirstDollarBootstrapDeploy({
    preflight,
    targetCommit: targetVersion,
    targetBranch,
    bootstrapMode: process.env[FIRST_DOLLAR_BOOTSTRAP_MODE_ENV],
    deployConfirmation: process.env[DEPLOY_CONFIRMATION_ENV],
    branchConfirmation: process.env[DEPLOY_BRANCH_CONFIRMATION_ENV],
    commitConfirmation: process.env[DEPLOY_COMMIT_CONFIRMATION_ENV],
  });

  if (!preflightResult.ok || !evaluation.ok) {
    console.error(JSON.stringify({
      ok: false,
      step: "live-railway-env-failed",
      message: "Fix missing or placeholder live Railway first-dollar env values before reading or mutating deploy fingerprints.",
      bootstrapMode: `${FIRST_DOLLAR_BOOTSTRAP_MODE_ENV}=deploy-fail-closed-checkout`,
      bootstrapDenied: true,
      preflightCommandPassed: preflightResult.ok,
      failures: evaluation.failures,
    }, null, 2));
    process.exit(1);
  }

  const strictContractChecks = [
    ["realRevenueContract", ["run", "-s", "check:real-revenue-contract"]],
    ["paidHandoffSafety", ["run", "-s", "check:paid-handoff-safety"]],
    ["firstDollarGuardCoverage", ["run", "-s", "check:first-dollar-guard-coverage"]],
  ].map(([name, args]) => {
    const result = runResult("npm", args);
    return { name, ...result };
  });
  const failedContracts = strictContractChecks.filter((check) => !check.ok);
  if (failedContracts.length > 0) {
    console.error(JSON.stringify({
      ok: false,
      step: "first-dollar-bootstrap-contract-failed",
      message: "The incomplete-env bootstrap cannot stamp Railway unless fail-closed revenue contracts pass again at the mutation boundary.",
      failures: failedContracts.map((check) => ({
        check: check.name,
        detail: check.output.slice(-2000),
      })),
    }, null, 2));
    process.exit(1);
  }

  console.error(JSON.stringify({
    ok: true,
    warning: "incomplete-first-dollar-env-bootstrap-deploy",
    message: "Live first-dollar env is incomplete; allowing only the explicitly approved exact-commit fingerprint stamp for healthy stale production.",
    targetBranch,
    targetVersion,
    strictContractChecks: strictContractChecks.map((check) => ({ check: check.name, ok: check.ok })),
    postDeployShipChecksRemainStrict: true,
  }, null, 2));
  return { ready: false, bootstrapExceptionUsed: true };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readRailwayVariables() {
  try {
    return railwayVariables({ quiet: true });
  } catch {
    return {};
  }
}

function stampRailwayVariable(name, value) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      railwaySetVariable(name, value, { skipDeploys: true });
      return;
    } catch (error) {
      lastError = error;
      const vars = readRailwayVariables();
      if (String(vars[name] || "") === value) return;
      if (attempt < 3) sleep(2000 * attempt);
    }
  }

  const message = String(lastError?.stderr || lastError?.message || "railway-variable-set-failed")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 3)
    .join(" ");
  console.error(JSON.stringify({
    ok: false,
    applied: false,
    error: "railway-variable-set-failed",
    variable: name,
    message,
  }, null, 2));
  process.exit(1);
}

const targetBranch = run("git", ["branch", "--show-current"]) || "main";
const targetVersion = run("git", ["rev-parse", "HEAD"]);
const firstDollarEnvGate = assertLiveRailwayEnvReady();
const vars = readRailwayVariables();
const currentBranch = String(vars.SMIRK_DEPLOY_BRANCH || "");
const currentVersion = String(vars.SMIRK_DEPLOY_VERSION || "");
const needsStamp = currentBranch !== targetBranch || currentVersion !== targetVersion;

if (!needsStamp) {
  console.log(JSON.stringify({
    ok: true,
    applied: false,
    alreadyCurrent: true,
    targetBranch,
    targetVersion,
    railwayBranchMatches: true,
    railwayVersionMatches: true,
    firstDollarEnvReady: firstDollarEnvGate.ready,
    firstDollarEnvBootstrapExceptionUsed: firstDollarEnvGate.bootstrapExceptionUsed,
  }, null, 2));
  process.exit(0);
}

if (!apply) {
  console.log(JSON.stringify({
    ok: true,
    applied: false,
    alreadyCurrent: false,
    targetBranch,
    targetVersion,
    railwayBranchMatches: currentBranch === targetBranch,
    railwayVersionMatches: currentVersion === targetVersion,
    firstDollarEnvReady: firstDollarEnvGate.ready,
    firstDollarEnvBootstrapExceptionUsed: firstDollarEnvGate.bootstrapExceptionUsed,
    nextAction: "Run npm run stamp:deploy-fingerprint to update Railway SMIRK_DEPLOY_BRANCH and SMIRK_DEPLOY_VERSION.",
  }, null, 2));
  process.exit(0);
}

stampRailwayVariable("SMIRK_DEPLOY_BRANCH", targetBranch);
stampRailwayVariable("SMIRK_DEPLOY_VERSION", targetVersion);

const updatedVars = readRailwayVariables();
const branchMatches = String(updatedVars.SMIRK_DEPLOY_BRANCH || "") === targetBranch;
const versionMatches = String(updatedVars.SMIRK_DEPLOY_VERSION || "") === targetVersion;

console.log(JSON.stringify({
  ok: branchMatches && versionMatches,
  applied: true,
  alreadyCurrent: false,
  targetBranch,
  targetVersion,
  railwayBranchMatches: branchMatches,
  railwayVersionMatches: versionMatches,
  deployTriggered: false,
  skipDeploys: true,
  firstDollarEnvReady: firstDollarEnvGate.ready,
  firstDollarEnvBootstrapExceptionUsed: firstDollarEnvGate.bootstrapExceptionUsed,
}, null, 2));

if (!branchMatches || !versionMatches) process.exit(1);
