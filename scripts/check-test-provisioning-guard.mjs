#!/usr/bin/env node
import assert from "node:assert/strict";
import { isTestLikeProvisioningInput } from "../src/provisioning-safety.ts";

const blockedCases = [
  { businessName: "Test Business", ownerEmail: "test@example.com", source: "test" },
  { businessName: "SMIRK Smoke Test", ownerEmail: "smoke+buyer@example.com", source: "buyer-auth-smoke" },
  { businessName: "SMIRK Stripe Webhook Smoke", ownerEmail: "smoke+stripe@example.com", source: "stripe_webhook_smoke" },
  { businessName: "Demo HVAC", ownerEmail: "owner+test@demo.com", source: "public_pricing" },
  { businessName: "Demo HVAC", ownerEmail: "owner@demo.com", source: "smoke-check" },
];

const allowedCases = [
  { businessName: "Reno Plumbing Co", ownerEmail: "owner@renoplumbing.com", source: "public_pricing" },
  { businessName: "Acme HVAC", ownerEmail: "dispatch@acmehvac.com", source: "stripe_checkout_completed" },
  { businessName: "North Valley Dental", ownerEmail: "admin@northvalleydental.com", source: "signup" },
];

for (const input of blockedCases) {
  assert.equal(isTestLikeProvisioningInput(input), true, `expected blocked: ${JSON.stringify(input)}`);
}

for (const input of allowedCases) {
  assert.equal(isTestLikeProvisioningInput(input), false, `expected allowed: ${JSON.stringify(input)}`);
}

console.log(JSON.stringify({ ok: true, blocked: blockedCases.length, allowed: allowedCases.length }, null, 2));
