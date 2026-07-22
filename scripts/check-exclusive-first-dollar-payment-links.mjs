#!/usr/bin/env node
import Stripe from "stripe";
import { verifyExclusiveActiveFirstDollarPaymentLink } from "./lib/exclusive-first-dollar-payment-links.mjs";
import { evaluateStarterPaymentLinkFulfillmentIds } from "../src/payment-link-fulfillment-ids.js";
import { railwayVariables } from "./railway-json.mjs";

const requiredKeys = [
  "STRIPE_REVENUE_READ_KEY",
  "STRIPE_PAYMENT_LINK_STARTER_ID",
  "STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS",
];
let railwayEnv = {};
let railwayEnvReadable = true;
if (requiredKeys.some((key) => !String(process.env[key] || "").trim())) {
  try {
    railwayEnv = railwayVariables({ quiet: true, attempts: 2, delayMs: 1000 });
  } catch {
    railwayEnvReadable = false;
  }
}
const value = (key) => String(process.env[key] || railwayEnv[key] || "").trim();

const restrictedKey = value("STRIPE_REVENUE_READ_KEY");
const expectedStarterId = value("STRIPE_PAYMENT_LINK_STARTER_ID");
const fulfillmentIds = evaluateStarterPaymentLinkFulfillmentIds({
  currentId: expectedStarterId,
  rawIds: value("STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS"),
});
if (!/^rk_live_[A-Za-z0-9_]+$/.test(restrictedKey)) {
  console.error("FAIL STRIPE_REVENUE_READ_KEY must be a dedicated live restricted key before Payment Link exclusivity can be proven");
  if (!railwayEnvReadable) console.error("- Railway production variables could not be read; provider exclusivity remains unverified");
  process.exit(1);
}
if (!/^plink_[A-Za-z0-9_]+$/.test(expectedStarterId)) {
  console.error("FAIL STRIPE_PAYMENT_LINK_STARTER_ID must be the exact proposed live Starter plink_ ID");
  process.exit(1);
}
if (!fulfillmentIds.ready) {
  console.error("FAIL STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS must explicitly include the current Starter ID and only bounded exact historical plink_ IDs");
  for (const blocker of fulfillmentIds.blockers) console.error(`- ${blocker}`);
  process.exit(1);
}

const stripe = new Stripe(restrictedKey, {
  apiVersion: "2026-04-22.dahlia",
  maxNetworkRetries: 2,
  timeout: 10_000,
});
const approvedFoundersId = value("STRIPE_PAYMENT_LINK_FOUNDERS_ID");
const result = await verifyExclusiveActiveFirstDollarPaymentLink({
  stripe,
  expectedStarterId,
  approvedFulfillmentIds: fulfillmentIds.ids,
  approvedFoundersId,
});
if (!result.ok) {
  console.error("FAIL Stripe still has an active SMIRK Payment Link outside the one approved Starter checkout lane");
  for (const blocker of result.blockers || []) console.error(`- ${blocker}`);
  console.error("Deactivate each exact legacy SMIRK link in Stripe, then rerun this read-only check. Clearing Railway variables alone is not sufficient.");
  process.exit(1);
}
console.log(`OK Stripe has exactly one recognized active SMIRK checkout lane: Starter ${expectedStarterId}${approvedFoundersId ? ` (+ approved founders lane ${approvedFoundersId})` : ""}`);
