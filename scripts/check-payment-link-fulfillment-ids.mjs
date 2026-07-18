#!/usr/bin/env node
import { evaluateStarterPaymentLinkFulfillmentIds } from "../src/payment-link-fulfillment-ids.js";

const currentId = process.argv[2] || process.env.STRIPE_PAYMENT_LINK_STARTER_ID;
const rawIds = process.argv[3] || process.env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS;
const result = evaluateStarterPaymentLinkFulfillmentIds({ currentId, rawIds });
if (!result.ready) {
  console.error("FAIL Starter fulfillment Payment Link ID allowlist is invalid");
  for (const blocker of result.blockers) console.error(`- ${blocker}`);
  process.exit(1);
}
console.log(`OK Starter fulfillment allowlist contains ${result.ids.length} exact Payment Link ID(s), including the current checkout`);
