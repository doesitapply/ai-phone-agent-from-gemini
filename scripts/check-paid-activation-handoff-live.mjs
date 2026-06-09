#!/usr/bin/env node

const appUrl = String(process.env.APP_URL || "https://smirkcalls.com").replace(/\/$/, "");
const writeConfirmation = String(process.env.CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE || "").trim();
const requiredWriteConfirmation = "create-live-smirk-paid-handoff-smoke";

if (writeConfirmation !== requiredWriteConfirmation) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-live-write-confirmation",
    message: "This check creates a live SMIRK Smoke Test provisioning request to prove paid signup reaches a tracked manual fallback.",
    requiredEnv: "CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE",
    requiredValue: requiredWriteConfirmation,
    nextAction: `Run only after explicit approval: CONFIRM_SMIRK_PAID_HANDOFF_LIVE_WRITE=${requiredWriteConfirmation} npm run check:paid-handoff-live`,
    cleanupDryRunCommand: "npm run cleanup:smoke-workspaces",
    cleanupApplyCommand: "CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply",
  }, null, 2));
  process.exit(1);
}

async function request(path, init = {}) {
  const res = await fetch(`${appUrl}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { res, body };
}

function fail(message, detail) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

function assert(condition, message, detail) {
  if (!condition) fail(message, detail);
}

const smokeBuyer = {
  business_name: "SMIRK Smoke Test",
  owner_email: "smoke+buyer@example.com",
  phone: "+15555550123",
  plan: "starter",
};

const pricing = await request("/api/pricing");
assert(pricing.res.status === 200, "pricing route did not return 200", {
  status: pricing.res.status,
  body: pricing.body,
});

const plans = Array.isArray(pricing.body?.plans) ? pricing.body.plans : [];
const starter = plans.find((plan) => plan?.id === "starter");
assert(starter?.price === 197, "starter plan is missing or mispriced", { starter });
assert(
  /^https:\/\/buy\.stripe\.com\//.test(String(starter?.checkout_url || "")) || Boolean(starter?.fallback_url),
  "starter plan has no checkout or fallback URL",
  { starter }
);

const checkout = await request("/api/checkout/create", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...smokeBuyer,
    source: "gate3-paid-handoff-smoke",
  }),
});
assert(checkout.res.status === 200, "checkout create did not return 200", {
  status: checkout.res.status,
  body: checkout.body,
});
assert(checkout.body?.ok === true, "checkout create did not return ok=true", checkout.body);
assert(
  /^https:\/\/(checkout|buy)\.stripe\.com\//.test(String(checkout.body?.checkout_url || "")),
  "checkout create did not return a Stripe checkout URL",
  checkout.body
);

const activation = await request("/api/provisioning/request", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...smokeBuyer,
    source: "buyer-auth-smoke",
  }),
});
assert(activation.res.status === 202, "activation request did not return 202", {
  status: activation.res.status,
  body: activation.body,
});
assert(activation.body?.ok === true, "activation request did not return ok=true", activation.body);
assert(
  activation.body?.status === "manual_fallback_required" &&
    activation.body?.fallback_status === "manual_fallback_required" &&
    activation.body?.provisioning_request_id,
  "activation request did not create a tracked manual fallback",
  activation.body
);

const status = await request("/api/provisioning/checkout-status", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: smokeBuyer.owner_email }),
});
assert(status.res.status === 200, "checkout status did not return 200", {
  status: status.res.status,
  body: status.body,
});
assert(status.body?.ok === true && status.body?.found === true, "checkout status did not find the smoke buyer", status.body);
assert(
  status.body?.request?.id === activation.body.provisioning_request_id &&
    status.body?.request?.status === "manual_fallback_required" &&
    status.body?.next_step === "manual_follow_up",
  "checkout status did not point to the tracked manual fallback request",
  {
    activation: activation.body,
    checkoutStatus: status.body,
  }
);

console.log(JSON.stringify({
  ok: true,
  appUrl,
  checkout: {
    source: checkout.body.source || null,
    id: checkout.body.id || null,
    hasCheckoutUrl: true,
  },
  activation: {
    provisioning_request_id: activation.body.provisioning_request_id,
    status: activation.body.status,
    fallback_status: activation.body.fallback_status,
  },
  checkoutStatus: {
    found: status.body.found,
    next_step: status.body.next_step,
    request_id: status.body.request?.id,
    request_status: status.body.request?.status,
  },
}, null, 2));
