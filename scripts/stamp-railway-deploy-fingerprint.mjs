#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { railwaySetVariable, railwayVariables } from "./railway-json.mjs";

const apply = process.argv.includes("--apply");

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...options }).trim();
}

function assertLiveRailwayEnvReady() {
  try {
    const output = run("npm", ["run", "-s", "check:railway:first-dollar-env"], { stdio: ["ignore", "pipe", "pipe"] });
    if (output) process.stderr.write(`${output}\n`);
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      step: "live-railway-env-failed",
      message: "Fix missing or placeholder live Railway first-dollar env values before reading or mutating deploy fingerprints.",
    }));
    const output = `${error.stdout || ""}${error.stderr || ""}`.trim();
    if (output) console.error(output);
    process.exit(1);
  }
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
      railwaySetVariable(name, value);
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
assertLiveRailwayEnvReady();
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
  deployTriggered: true,
}, null, 2));

if (!branchMatches || !versionMatches) process.exit(1);
