#!/usr/bin/env node
import { readFileSync } from "node:fs";

const paidHandoff = readFileSync("scripts/check-paid-activation-handoff-live.mjs", "utf8");
const launchBlockers = readFileSync("scripts/check-launch-blockers.sh", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

const failures = [];

function requireIncludes(label, text, snippet) {
  if (!text.includes(snippet)) failures.push(`${label} must include ${snippet}`);
}

requireIncludes("paid handoff live smoke", paidHandoff, "CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE");
requireIncludes("paid handoff live smoke", paidHandoff, "create-live-smirk-paid-handoff-smoke");
requireIncludes("paid handoff live smoke", paidHandoff, "cleanup:smoke-workspaces");
requireIncludes("paid handoff live smoke", paidHandoff, "cleanup:smoke-workspaces:apply");
requireIncludes("paid handoff live smoke", paidHandoff, "provisioning_request_id");
requireIncludes("paid handoff live smoke", paidHandoff, "manual_fallback_required");

if (!pkg.scripts?.["check:paid-handoff-live"]) {
  failures.push("package.json must expose check:paid-handoff-live");
}
if (pkg.scripts?.["check:paid-handoff-live"] !== "node scripts/check-paid-activation-handoff-live.mjs") {
  failures.push("check:paid-handoff-live must run scripts/check-paid-activation-handoff-live.mjs directly");
}
if (pkg.scripts?.["check:launch-blockers"] !== "bash scripts/check-launch-blockers.sh") {
  failures.push("check:launch-blockers must run scripts/check-launch-blockers.sh");
}

requireIncludes("launch blockers", launchBlockers, "check:paid-handoff-safety");
if (launchBlockers.includes("check:paid-handoff-live")) {
  failures.push("launch blockers must not run check:paid-handoff-live because it writes live smoke state");
}

const out = {
  ok: failures.length === 0,
  checked: [
    "scripts/check-paid-activation-handoff-live.mjs",
    "scripts/check-launch-blockers.sh",
    "package.json",
  ],
  failures,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
