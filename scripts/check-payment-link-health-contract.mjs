#!/usr/bin/env node
import fs from "node:fs";

const helper = fs.readFileSync("src/payment-link-configuration.ts", "utf8");
const systemHealth = fs.readFileSync("src/routes/system-health-routes.ts", "utf8");
const server = fs.readFileSync("server.ts", "utf8");
const legacySetter = fs.readFileSync("scripts/set-stripe-payment-links.sh", "utf8");
const fixture = fs.readFileSync("scripts/check-payment-link-health-fixtures.ts", "utf8");
const packageJson = fs.readFileSync("package.json", "utf8");

const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

expect(helper.includes("evaluatePaymentLinkConfiguration"), "shared configuration-only Payment Link evaluator is missing");
expect(helper.includes('from "./stripe-payment-link-readiness.js"'), "health configuration must reuse the exact runtime Payment Link ID/URL validators");
expect(helper.includes('from "./payment-link-fulfillment-ids.js"') && helper.includes("evaluateStarterPaymentLinkFulfillmentIds"), "health configuration must require the shared exact current/historical fulfillment-ID allowlist");
expect(helper.includes('providerVerification: "not_checked"'), "configuration evaluator must explicitly avoid claiming provider verification");
expect(helper.includes("starter-payment-link-pair-missing") && helper.includes("payment-link-pair-incomplete"), "configuration evaluator must require the exact Starter pair and reject partial offers");
expect(helper.includes("pro-payment-link-out-of-first-dollar-scope") && helper.includes("enterprise-payment-link-out-of-first-dollar-scope"), "configuration evaluator must keep broader offers outside the Starter-only launch");

expect(systemHealth.includes("evaluatePaymentLinkConfiguration(env"), "operator system health must use the shared Starter-only launch configuration predicate");
expect(systemHealth.includes("provider verification is not checked here"), "operator system health must disclose its configuration-only scope");
expect(!systemHealth.includes("starterLinkReady && proLinkReady"), "operator system health still requires both core links");

expect(server.includes("const paymentLinksConfigured = paymentLinkConfiguration.ready"), "/health must use Starter-only URL + ID configuration readiness");
expect(server.includes('STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS: z.string().optional()'), "server env parsing must preserve the exact fulfillment-ID allowlist for health and provider monitoring");
expect(server.includes("providerVerification: paymentLinkConfiguration.providerVerification"), "/health must expose that provider verification was not checked");
expect(!server.includes("STRIPE_PAYMENT_LINK_STARTER || '').trim() && (process.env.STRIPE_PAYMENT_LINK_PRO"), "/health still requires multiple URL-only offers");
expect(server.includes('STRIPE_REVENUE_READ_KEY", label: "Stripe restricted read key"') && server.includes('Native Stripe secret (disabled lane)') && server.includes("critical: false"), "hosted-only operator health must use the restricted read key and keep the native secret noncritical");

expect(legacySetter.includes("is deprecated and performs no Railway writes"), "legacy URL-only setter must be explicitly deprecated");
expect(legacySetter.includes("STRIPE_PAYMENT_LINK_STARTER_ID") && legacySetter.includes("set:first-dollar-live-env"), "legacy setter must direct operators to the guarded URL + ID path");
expect(!/^\s*railway\s+(?:variable|variables)\s+set\b/m.test(legacySetter), "legacy setter still contains a Railway mutation command");

expect(fixture.includes("one complete Starter pair") && fixture.includes("one complete Pro pair must not satisfy"), "behavior fixtures must prove Starter succeeds and Pro-only fails");
expect(fixture.includes("current Starter pair without an explicit fulfillment-ID allowlist") && fixture.includes("current Starter ID must be explicitly included") && fixture.includes("inactive historical Starter ID"), "behavior fixtures must prove the fulfillment allowlist fails closed and supports an exact safe rotation");
expect(fixture.includes("partial configured sibling") && fixture.includes("placeholder sibling"), "behavior fixtures must cover partial and placeholder sibling failures");
expect(packageJson.includes('"check:payment-link-health-contract"'), "package scripts must expose Payment Link health contract coverage");

if (failures.length > 0) {
  console.error("FAIL Payment Link health contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK health surfaces use one Starter-only launch predicate with exact fulfillment IDs and the legacy URL-only setter cannot mutate Railway");
