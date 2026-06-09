#!/usr/bin/env node
import { readFileSync } from "node:fs";

const buyerAuthSmoke = readFileSync("scripts/buyer-funnel-auth-smoke.sh", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

const failures = [];

function requireIncludes(label, text, snippet) {
  if (!text.includes(snippet)) failures.push(`${label} must include ${snippet}`);
}

requireIncludes("buyer auth smoke", buyerAuthSmoke, "CONFIRM_SMIRK_BUYER_AUTH_LIVE_WRITE");
requireIncludes("buyer auth smoke", buyerAuthSmoke, "create-live-smirk-buyer-auth-smoke");
requireIncludes("buyer auth smoke", buyerAuthSmoke, "cleanup:smoke-workspaces");
requireIncludes("buyer auth smoke", buyerAuthSmoke, "cleanup:smoke-workspaces:apply");
requireIncludes("buyer auth smoke", buyerAuthSmoke, "manual_fallback_required");
requireIncludes("buyer auth smoke", buyerAuthSmoke, "/api/provisioning/request");
requireIncludes("buyer auth smoke", buyerAuthSmoke, "/api/provisioning/checkout-status");

if (packageJson.scripts?.["smoke:buyer-auth"] !== "bash scripts/buyer-funnel-auth-smoke.sh") {
  failures.push("smoke:buyer-auth must run scripts/buyer-funnel-auth-smoke.sh directly");
}
if (packageJson.scripts?.["check:buyer-auth-smoke-safety"] !== "node scripts/check-buyer-auth-smoke-safety.mjs") {
  failures.push("package.json must expose check:buyer-auth-smoke-safety");
}
const postDeploy = String(packageJson.scripts?.["check:post-deploy-live"] || "");
if (!postDeploy.includes("check:buyer-auth-smoke-safety")) {
  failures.push("check:post-deploy-live must run check:buyer-auth-smoke-safety");
}
if (postDeploy.includes("smoke:buyer-auth")) {
  failures.push("check:post-deploy-live must not run smoke:buyer-auth because it writes live smoke state");
}

const out = {
  ok: failures.length === 0,
  checked: [
    "scripts/buyer-funnel-auth-smoke.sh",
    "package.json",
  ],
  failures,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
