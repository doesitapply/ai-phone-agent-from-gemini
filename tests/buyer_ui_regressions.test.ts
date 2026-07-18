import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  parsePublicInvitePreviewPayload,
  parsePublicPricingPayload,
  shouldOfferPublicSetupHelp,
} from "../src/App.js";
import { validateBusinessSetupStep } from "../src/components/SetupWizard.js";

const validPlan = {
  id: "starter",
  name: "SMIRK AI Starter",
  price: 197,
  interval: "month",
  description: "Missed-call recovery for one local-service team.",
  features: ["Call record", "Owner alert", "Callback task"],
  usage_summary: "Published Starter limits",
  best_for: "Owner-operated service businesses",
  cta: "Start Starter Plan",
  checkout_available: true,
  checkout_blocker: null,
  fallback_url: "https://smirkcalls.com/book",
};

test("pricing payloads fail closed instead of rendering an empty or broken checkout surface", () => {
  for (const payload of [null, {}, { plans: [] }, { plans: [{ ...validPlan, features: [] }] }]) {
    assert.throws(
      () => parsePublicPricingPayload(payload),
      /Plans are temporarily unavailable/,
    );
  }

  const parsed = parsePublicPricingPayload({ plans: [validPlan], policy_links: [] });
  assert.equal(parsed.plans.length, 1);
  assert.equal(parsed.plans[0].id, "starter");
  assert.equal(parsed.plans[0].fallback_url, "https://smirkcalls.com/book");

  const unsafeFallback = parsePublicPricingPayload({
    plans: [{ ...validPlan, fallback_url: "http://127.0.0.1/private" }],
  });
  assert.equal(unsafeFallback.plans[0].fallback_url, null);
});

test("invite preview requires an authoritative success payload and real workspace identity", () => {
  for (const payload of [
    {},
    { success: false, workspace: { name: "Acme", plan: "starter" } },
    { success: true, workspace: { name: "", plan: "starter" } },
    { success: true, workspace: { name: "Acme", plan: "starter" }, expires_at: "not-a-date" },
  ]) {
    assert.throws(
      () => parsePublicInvitePreviewPayload(payload),
      /invite could not be verified/i,
    );
  }

  assert.deepEqual(
    parsePublicInvitePreviewPayload({
      success: true,
      accepted: false,
      expires_at: "2026-07-19T12:00:00.000Z",
      workspace: { name: "Acme Plumbing", plan: "starter" },
    }),
    {
      workspaceName: "Acme Plumbing",
      plan: "starter",
      accepted: false,
      expiresAt: "2026-07-19T12:00:00.000Z",
    },
  );
});

test("business setup step blocks missing or invalid prerequisites before advancing", () => {
  const valid = {
    businessName: "Acme Plumbing",
    businessPhone: "+17754204485",
    businessWebsite: "https://acmeplumbing.com",
    serviceArea: "Reno, Sparks, and Carson City",
    businessHours: "Mon-Fri 8am-6pm",
    ownerPhone: "",
    escalationPreference: "Email the owner and call for urgent human requests.",
    proofCallTarget: "+17754204485",
  };
  assert.deepEqual(validateBusinessSetupStep(valid), { valid: true, errors: [] });

  const missing = validateBusinessSetupStep({
    ...valid,
    businessName: "",
    businessPhone: "",
    serviceArea: "",
    ownerPhone: "",
    escalationPreference: "",
    proofCallTarget: "",
  });
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join("\n"), /business name/i);
  assert.match(missing.errors.join("\n"), /service area/i);
  assert.match(missing.errors.join("\n"), /callback number/i);
  assert.match(missing.errors.join("\n"), /urgent calls/i);
  assert.match(missing.errors.join("\n"), /proof-call number/i);

  const invalidPhone = validateBusinessSetupStep({ ...valid, businessPhone: "775-420-4485" });
  assert.equal(invalidPhone.valid, false);
  assert.match(invalidPhone.errors.join("\n"), /international format/i);
});

test("checkout-success recovery offers setup help whenever the checkout reference is missing", () => {
  assert.equal(shouldOfferPublicSetupHelp("", false), true);
  assert.equal(shouldOfferPublicSetupHelp("   ", false), true);
  assert.equal(shouldOfferPublicSetupHelp("cs_live_fixture", true), true);
  assert.equal(shouldOfferPublicSetupHelp("cs_live_fixture", false), false);
});

test("buyer components wire the guards into the rendered flows", () => {
  const appSource = fs.readFileSync("src/App.tsx", "utf8");
  const wizardSource = fs.readFileSync("src/components/SetupWizard.tsx", "utf8");
  assert.equal((appSource.match(/parsePublicPricingPayload\(body\)/g) || []).length, 2);
  assert.match(appSource, /const pricingUnavailable = Boolean\(error && plans\.length === 0\)/);
  assert.match(appSource, /!pricingUnavailable \? <>/);
  assert.match(appSource, /const preview = parsePublicInvitePreviewPayload\(body\)/);
  assert.match(appSource, /const offerSetupHelp = shouldOfferPublicSetupHelp\(sessionId, activationNeedsHelp\)/);
  assert.match(appSource, /href="\/book"[^>]*>Request setup help<\/a>/);
  assert.match(wizardSource, /const validation = validateBusinessSetupStep\(\{/);
  assert.match(wizardSource, /if \(!validation\.valid\) \{ flash\(validation\.errors\[0\], true\); return; \}/);
});
