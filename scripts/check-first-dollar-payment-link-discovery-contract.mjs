#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("./discover-first-dollar-payment-links.mjs", import.meta.url)),
  "utf8",
);

for (const required of [
  "STRIPE_REVENUE_READ_KEY",
  "railwayVariables",
  "stripe.paymentLinks.list(",
  "stripe.paymentLinks.listLineItems(",
  "readOnly: true",
  "mutationAttempted: false",
  "proposedStarterId",
  "activeLinksRequiringResolution",
  "payment-link-line-item-scan-limit-exceeded",
]) {
  assert.ok(source.includes(required), `discovery must retain ${required}`);
}

for (const forbidden of [
  "paymentLinks.create(",
  "paymentLinks.update(",
  "paymentLinks.del(",
  "paymentLinks.deactivate(",
  "prices.create(",
  "products.create(",
  "railway variables set",
  "railway variable set",
]) {
  assert.equal(
    source.includes(forbidden),
    false,
    `read-only discovery must not contain provider mutation primitive ${forbidden}`,
  );
}

console.log("OK first-dollar Payment Link discovery is statically restricted to read operations and explicit no-mutation reporting");
