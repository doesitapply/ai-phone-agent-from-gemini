#!/usr/bin/env node
import { readFileSync } from "node:fs";

const paidHandoff = readFileSync("scripts/check-paid-activation-handoff-live.mjs", "utf8");
const launchBlockers = readFileSync("scripts/check-launch-blockers.sh", "utf8");
const buyerRoutes = readFileSync("src/routes/buyer-routes.ts", "utf8");
const provisioningRoutes = readFileSync("src/routes/provisioning-routes.ts", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

const failures = [];

function requireIncludes(label, text, snippet) {
  if (!text.includes(snippet)) failures.push(`${label} must include ${snippet}`);
}

requireIncludes("paid handoff live smoke", paidHandoff, "CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE");
requireIncludes("paid handoff live smoke", paidHandoff, "create-live-smirk-paid-handoff-smoke");
requireIncludes("paid handoff live smoke", paidHandoff, "cleanup:smoke-workspaces");
requireIncludes("paid handoff live smoke", paidHandoff, "cleanup:smoke-workspaces:apply");
requireIncludes("paid handoff live smoke", paidHandoff, "cleanupApprovalRequired");
requireIncludes("paid handoff live smoke", paidHandoff, "Do not apply confirmed smoke cleanup without separate explicit cleanup approval after reviewing the dry-run.");
requireIncludes("paid handoff live smoke", paidHandoff, "provisioning_request_id");
requireIncludes("paid handoff live smoke", paidHandoff, "manual_fallback_required");
requireIncludes("paid handoff live smoke", paidHandoff, "request_summary?.status_label");
requireIncludes("paid handoff live smoke", paidHandoff, "next_step_label");
requireIncludes("paid handoff live smoke", paidHandoff, "publicLeakChecks");
requireIncludes("paid handoff live smoke", paidHandoff, "raw_request_exposed");
requireIncludes("paid handoff live smoke", paidHandoff, "request_id_exposed");
requireIncludes("paid handoff live smoke", paidHandoff, "stripe_event_id_exposed");
requireIncludes("paid handoff live smoke", paidHandoff, "smokeCheckoutSessionId");
requireIncludes("paid handoff live smoke", paidHandoff, "checkout_reference_received === true");
requireIncludes("paid handoff live smoke", paidHandoff, "checkout_session_id_exposed");
requireIncludes("paid handoff live smoke", paidHandoff, "workspace_id_exposed");
requireIncludes("paid handoff live smoke", paidHandoff, "invite_link_exposed");
requireIncludes("paid handoff live smoke", paidHandoff, "exception_reason_exposed");
requireIncludes("paid handoff live smoke", paidHandoff, "cacheProtected");
requireIncludes("checkout create route", buyerRoutes, 'app.post("/api/checkout/create", publicDemoRateLimit');
requireIncludes("checkout create route", buyerRoutes, 'res.setHeader("Cache-Control", "no-store")');
requireIncludes("checkout create route", buyerRoutes, 'success_url: `${publicAppUrl}/success?session_id={CHECKOUT_SESSION_ID}`');
requireIncludes("checkout create route", buyerRoutes, 'cancel_url: `${publicAppUrl}/pricing`');
requireIncludes("provisioning request route", provisioningRoutes, 'app.post("/api/provisioning/request", publicDemoRateLimit');
requireIncludes("provisioning request route", provisioningRoutes, 'res.set("Cache-Control", "no-store")');
requireIncludes("provisioning checkout-status route", provisioningRoutes, 'app.post("/api/provisioning/checkout-status", publicDemoRateLimit');
requireIncludes("provisioning checkout-status route", provisioningRoutes, 'res.set("Cache-Control", "no-store")');
requireIncludes("provisioning checkout-status route", provisioningRoutes, "normalizeStripeCheckoutSessionId");
requireIncludes("provisioning checkout-status route", provisioningRoutes, "checkout_reference_received: checkoutReferenceReceived");
requireIncludes("provisioning checkout-status route", provisioningRoutes, "checkoutSessionId");
requireIncludes("provisioning checkout-status route", provisioningRoutes, "^cs_(test|live)_[A-Za-z0-9_]{8,240}$");
requireIncludes("buyer success page", app, 'pathname === "/success"');
requireIncludes("buyer cancel page", app, 'pathname === "/cancel"');
requireIncludes("buyer success page", app, "/api/provisioning/checkout-status");
requireIncludes("buyer success page", app, 'new URLSearchParams(window.location.search).get("session_id")');
requireIncludes("buyer success page", app, "checkout_session_id: sessionId");
requireIncludes("buyer success page", app, "request_summary?.status_label");
requireIncludes("buyer success page", app, "next_step_label");
requireIncludes("buyer success page", app, "manual_fallback_required");

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
    "src/routes/buyer-routes.ts",
    "src/routes/provisioning-routes.ts",
    "src/App.tsx",
    "package.json",
  ],
  failures,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
