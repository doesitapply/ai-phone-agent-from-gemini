#!/usr/bin/env node
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const failures = [];

function expect(label, condition) {
  if (!condition) failures.push(label);
}

function sliceBetween(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  if (start < 0) return "";
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  return end > start ? text.slice(start, end) : text.slice(start);
}

const saas = read("src/saas.ts");
const alerts = read("src/monetization-alerts.ts");
const packageJson = read("package.json");
const firstDollarGuard = read("scripts/check-first-dollar-guard-coverage.mjs");
const deployReady = read("scripts/check-deploy-post-call-fix-ready.mjs");
const launchDoc = read("docs/SMIRK_30_DAY_MARKET_VALIDATION_GOAL.md");
const platformKit = read("docs/launch/platform-submission-kit.md");

const paymentFailedBlock = sliceBetween(saas, 'if (type === "invoice.payment_failed")', 'if (type === "charge.refunded")');
const cancellationBlock = sliceBetween(saas, 'if (type === "customer.subscription.deleted")', 'if (type === "invoice.payment_failed")');
const refundBlock = sliceBetween(saas, 'if (type === "charge.refunded")', "\n  }\n}\n\n// ── Workspace Stats");

expect("billing lifecycle workspace lookup helper exists", saas.includes("async function findWorkspaceByStripeIds"));
expect("billing lifecycle alert/event helper exists", saas.includes("async function recordStripeBillingLifecycle"));
expect("billing lifecycle helper creates activation events", saas.includes("await createActivationEvent({") && saas.includes("workspace_matched: Boolean(input.workspace?.id)"));
expect("billing lifecycle helper sends operator alerts", saas.includes("await " + "send" + "Provisioning" + "Alert({") && saas.includes("event: input.alertEvent"));

expect("payment failed webhook branch exists", Boolean(paymentFailedBlock));
expect("payment failed marks workspace past_due", paymentFailedBlock.includes("subscription_status = 'past_due'"));
expect("payment failed records activation event", paymentFailedBlock.includes('eventType: "billing_payment_failed"'));
expect("payment failed sends operator alert", paymentFailedBlock.includes('alertEvent: "stripe_payment_failed"'));
expect("payment failed is treated as blocked", paymentFailedBlock.includes('status: "blocked"'));
expect("payment failed preserves invoice context", paymentFailedBlock.includes("hosted_invoice_url") && paymentFailedBlock.includes("amount_due"));

expect("subscription deleted webhook branch exists", Boolean(cancellationBlock));
expect("subscription deleted marks workspace canceled", cancellationBlock.includes("subscription_status = 'canceled'"));
expect("subscription deleted records activation event", cancellationBlock.includes('eventType: "billing_subscription_canceled"'));
expect("subscription deleted sends operator alert", cancellationBlock.includes('alertEvent: "stripe_subscription_canceled"'));
expect("subscription deleted lookup uses customer and subscription id", cancellationBlock.includes("const subscriptionId = cleanStripeId(obj.id)") && cancellationBlock.includes("findWorkspaceByStripeIds({ customerId, subscriptionId })"));

expect("refund webhook branch exists", Boolean(refundBlock));
expect("refund branch uses charge.refunded", saas.includes('if (type === "charge.refunded")'));
expect("refund records activation event", refundBlock.includes('eventType: "billing_refund_recorded"'));
expect("refund sends operator alert", refundBlock.includes('alertEvent: "stripe_refund_recorded"'));
expect("refund records amount context", refundBlock.includes("amount_refunded") && refundBlock.includes("receipt_url"));
expect("refund path does not cancel workspace directly", !refundBlock.includes("subscription_status = 'canceled'"));

for (const event of ["stripe_payment_failed", "stripe_subscription_canceled", "stripe_refund_recorded"]) {
  expect(`provisioning alert event includes ${event}`, alerts.includes(`| "${event}"`));
  expect(`provisioning alert label handles ${event}`, alerts.includes(`case "${event}":`));
}

expect("package exposes billing lifecycle check", packageJson.includes('"check:billing-lifecycle": "node scripts/check-billing-lifecycle-contract.mjs"'));
expect("post-deploy live gate runs billing lifecycle check", packageJson.includes("check:billing-lifecycle"));
expect("deploy readiness gate runs billing lifecycle check", deployReady.includes("check:billing-lifecycle") && deployReady.includes("billingLifecycle"));
expect("first-dollar guard coverage protects billing lifecycle check", firstDollarGuard.includes("check:billing-lifecycle") && firstDollarGuard.includes("billing lifecycle"));
expect("launch goal documents billing lifecycle check", launchDoc.includes("npm run check:billing-lifecycle"));
expect("platform kit keeps AppSumo gated on billing lifecycle check", platformKit.includes("npm run check:billing-lifecycle"));

const checkerSource = read("scripts/check-billing-lifecycle-contract.mjs");
const forbiddenRuntimeNeedles = [
  "fet" + "ch(",
  "exec" + "FileSync",
  "stri" + "pe.",
  "process.env." + "STRIPE",
  "send" + "ProvisioningAlert(",
];
expect("billing lifecycle checker is static and non-mutating", forbiddenRuntimeNeedles.every((needle) => !checkerSource.includes(needle)));

if (failures.length > 0) {
  console.error("FAIL billing lifecycle contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK billing lifecycle contract covers failed payment, cancellation, refund, operator alerts, and non-mutating launch gates");
