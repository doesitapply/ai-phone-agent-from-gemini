#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import Stripe from "stripe";

const appUrl = String(process.env.APP_URL || "https://ai-phone-agent-production-6811.up.railway.app").replace(/\/$/, "");

function readRailwayVariables() {
  try {
    const raw = execFileSync(
      "bash",
      ["-lc", "source ./scripts/load-railway-auth.sh >/dev/null 2>&1 || true; railway variable list --json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

const railwayVars = readRailwayVariables();
const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || railwayVars.STRIPE_WEBHOOK_SECRET || "").trim();
const autoFulfill = String(process.env.AUTO_FULFILL_PROVISIONING_REQUESTS || railwayVars.AUTO_FULFILL_PROVISIONING_REQUESTS || "false").trim().toLowerCase() === "true";

if (!webhookSecret) {
  fail("missing STRIPE_WEBHOOK_SECRET", {
    message: "Set STRIPE_WEBHOOK_SECRET in env or Railway variables before verifying signed Stripe webhooks.",
  });
}

if (autoFulfill && process.env.ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE !== "1") {
  fail("refusing to run signed webhook smoke while auto-fulfillment is enabled", {
    message: "Set ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 only if creating a real smoke workspace is intended.",
  });
}

const timestamp = Date.now();
const eventId = `evt_smirk_paid_handoff_${timestamp}`;
const sessionId = `cs_smirk_paid_handoff_${timestamp}`;
const ownerEmail = `smoke+stripe-${timestamp}@example.com`;
const businessName = "SMIRK Stripe Webhook Smoke";

const payload = JSON.stringify({
  id: eventId,
  object: "event",
  api_version: "2025-10-29.clover",
  created: Math.floor(timestamp / 1000),
  livemode: false,
  pending_webhooks: 1,
  request: { id: null, idempotency_key: null },
  type: "checkout.session.completed",
  data: {
    object: {
      id: sessionId,
      object: "checkout.session",
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      customer: `cus_smirk_${timestamp}`,
      subscription: `sub_smirk_${timestamp}`,
      customer_email: ownerEmail,
      customer_details: {
        email: ownerEmail,
        name: businessName,
        phone: "+15555550123",
      },
      metadata: {
        plan: "starter",
        business_name: businessName,
        owner_email: ownerEmail,
        owner_phone: "+15555550123",
        source: "gate3-stripe-webhook-smoke",
      },
    },
  },
});

const stripe = new Stripe("sk_test_unused_for_signature_generation");
const signature = stripe.webhooks.generateTestHeaderString({
  payload,
  secret: webhookSecret,
});

const webhookRes = await fetch(`${appUrl}/api/stripe/webhook`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "stripe-signature": signature,
  },
  body: payload,
});
const webhookText = await webhookRes.text();
let webhookBody;
try {
  webhookBody = JSON.parse(webhookText);
} catch {
  webhookBody = { raw: webhookText.slice(0, 500) };
}

if (webhookRes.status !== 200 || webhookBody?.received !== true) {
  fail("signed Stripe webhook did not return received=true", {
    status: webhookRes.status,
    body: webhookBody,
  });
}

const statusRes = await fetch(`${appUrl}/api/provisioning/checkout-status`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: ownerEmail }),
});
const statusText = await statusRes.text();
let statusBody;
try {
  statusBody = JSON.parse(statusText);
} catch {
  statusBody = { raw: statusText.slice(0, 500) };
}

if (statusRes.status !== 200 || statusBody?.ok !== true || statusBody?.found !== true) {
  fail("checkout-status did not find the signed webhook provisioning row", {
    status: statusRes.status,
    body: statusBody,
  });
}

const request = statusBody.request || {};
const expectedStatus = autoFulfill ? ["workspace_created", "workspace_and_line_created", "manual_fallback_required"] : ["manual_fallback_required"];
if (request.request_id !== eventId || !expectedStatus.includes(request.status)) {
  fail("signed webhook provisioning row did not match expected status", {
    expectedRequestId: eventId,
    expectedStatus,
    request,
  });
}

console.log(JSON.stringify({
  ok: true,
  appUrl,
  webhook: {
    event_id: eventId,
    session_id: sessionId,
    received: true,
  },
  checkoutStatus: {
    found: statusBody.found,
    next_step: statusBody.next_step,
    request_id: request.id,
    stripe_event_id: request.request_id,
    request_status: request.status,
    workspace_id: request.workspace_id || null,
  },
}, null, 2));
