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

const paymentFailedBlock = sliceBetween(saas, 'if (type === "invoice.payment_failed"', 'if (type === "charge.refunded"');
const cancellationBlock = sliceBetween(saas, 'if (type === "customer.subscription.deleted"', 'if (type === "invoice.payment_failed"');
const refundBlock = sliceBetween(saas, 'if (type === "charge.refunded"', 'if (type === "charge.dispute.created"');
const disputeBlock = sliceBetween(saas, 'if (type === "charge.dispute.created"', "\n  }\n}\n\n// ── Workspace Stats");

expect("billing lifecycle workspace lookup helper exists", saas.includes("async function findWorkspaceByStripeIds"));
expect("billing lifecycle alert/event helper exists", saas.includes("async function recordStripeBillingLifecycle"));
expect("billing lifecycle helper creates idempotent activation events", saas.includes("await createActivationEventIfChanged({") && saas.includes("workspace_matched: Boolean(input.workspace?.id)"));
expect("billing lifecycle helper sends operator alerts", saas.includes("await " + "send" + "Provisioning" + "Alert({") && saas.includes("event: input.alertEvent"));
expect("billing lifecycle alert idempotency is scoped to the exact Stripe event", saas.includes("deliveryScope: input.stripeEventId"));
expect("retryable billing alerts fail the webhook for Stripe replay", saas.includes("alertDelivery.retryable") && saas.includes('error.code = "STRIPE_BILLING_ALERT_RETRYABLE"') && saas.includes("throw error;"));

expect("payment failed webhook branch exists", Boolean(paymentFailedBlock));
expect("payment failed marks workspace past_due", paymentFailedBlock.includes('status: "past_due"') && saas.includes("applyStripeSubscriptionStateFactToWorkspace"));
expect("payment failed records activation event", paymentFailedBlock.includes('eventType: "billing_payment_failed"'));
expect("payment failed sends operator alert", paymentFailedBlock.includes('alertEvent: "stripe_payment_failed"'));
expect("payment failed is treated as blocked", paymentFailedBlock.includes('status: "blocked"'));
expect("payment failed preserves invoice context", paymentFailedBlock.includes("hosted_invoice_url") && paymentFailedBlock.includes("amount_due"));

expect("subscription deleted webhook branch exists", Boolean(cancellationBlock));
expect("subscription deleted marks workspace canceled", cancellationBlock.includes('status: "canceled"') && saas.includes("applyStripeSubscriptionStateFactToWorkspace"));
expect("subscription deleted records activation event", cancellationBlock.includes('eventType: "billing_subscription_canceled"'));
expect("subscription deleted sends operator alert", cancellationBlock.includes('alertEvent: "stripe_subscription_canceled"'));
expect("subscription deleted lookup uses customer and subscription id", cancellationBlock.includes("const subscriptionId = cleanStripeId(obj.id)") && cancellationBlock.includes("customerId && subscriptionId") && cancellationBlock.includes("findWorkspaceByStripeIds({ customerId, subscriptionId })"));

expect("refund webhook branch exists", Boolean(refundBlock));
expect("refund branch uses charge.refunded", saas.includes('if (type === "charge.refunded"'));
expect("refund records activation event", refundBlock.includes('eventType: "billing_refund_recorded"'));
expect("refund sends operator alert", refundBlock.includes('alertEvent: "stripe_refund_recorded"'));
expect("refund records amount context", refundBlock.includes("amount_refunded") && refundBlock.includes("receipt_url"));
expect("refund path does not cancel workspace directly", !refundBlock.includes("subscription_status = 'canceled'"));
expect("refund state change requires exact PaymentIntent subscription binding", saas.includes("stripe_payment_bindings") && refundBlock.includes("payment_intent_id") && refundBlock.includes("exact_subscription_binding") && refundBlock.includes("fullyRefunded && exactWorkspace?.id"));
expect("fully refunded exact payment revokes usage", saas.includes("!hasWorkspaceBillingEntitlement(ws.plan, ws.subscription_status)") && saas.includes('ws.subscription_status === "refunded"') && saas.includes('"Payment fully refunded"'));
expect("cancellation and payment failure update exact subscription only", saas.includes("AND stripe_subscription_id = ${fact.subscription_id}") && cancellationBlock.includes("findWorkspaceByStripeIds({ customerId, subscriptionId })") && paymentFailedBlock.includes("findWorkspaceByStripeIds({ customerId, subscriptionId })"));
expect("billing mutations require exact customer and subscription", saas.includes("AND stripe_customer_id = ${fact.customer_id}") && cancellationBlock.includes("customerId && subscriptionId") && paymentFailedBlock.includes("customerId && subscriptionId"));
expect("subscription lookup never falls back from supplied subscription to customer", saas.includes("return null;\n  }\n  if (customerId)"));
expect("refund and dispute facts persist before exact binding", saas.includes("stripe_payment_adverse_events") && saas.includes("stripe_invoice_payment_facts") && saas.includes("reconcileStripePaymentFactsForWorkspace"));
expect("Stripe payment facts and bindings cannot be reassigned on ID conflict", saas.includes("stripe_invoice_payment_facts.invoice_id = EXCLUDED.invoice_id") && saas.includes("stripe_payment_bindings.workspace_id = EXCLUDED.workspace_id"));
expect("refund path uses workspace-bound payment intent", refundBlock.includes("workspace_id IS NOT NULL") && refundBlock.includes("matchesExactStripeWorkspaceBinding"));
expect("dispute webhook suspends exact workspace", Boolean(disputeBlock) && disputeBlock.includes("subscription_status = 'disputed'") && disputeBlock.includes('eventType: "billing_dispute_recorded"'));
expect("refunded and disputed suspension survives subscription updates", saas.includes("subscription_status IN ('refunded', 'disputed') THEN subscription_status"));
expect("subscription updates are fenced by Stripe event time", saas.includes("stripe_billing_event_created < ${fact.event_created}") && saas.includes("stripe_billing_event_id IS DISTINCT FROM ${fact.event_id}"));
expect("restrictive billing events win same-second ordering", saas.includes("isRestrictiveWorkspaceBillingStatus(status)") && saas.includes("AND ${restrictiveStatus}"));
expect("pre-provision cancellation and failure facts are durable", saas.includes("CREATE TABLE IF NOT EXISTS stripe_subscription_state_facts") && cancellationBlock.includes("recordStripeSubscriptionStateFact({") && paymentFailedBlock.includes("recordStripeSubscriptionStateFact({") && saas.includes("reconcileStripeSubscriptionStateForWorkspace(workspace)") && saas.includes("reconcileStripeSubscriptionStateForWorkspace(refreshedWorkspace)"));
expect("same-event billing replays retry alerts after state was already applied", cancellationBlock.includes("lifecycleWorkspace = appliedWorkspace || (incomingWasCurrent ? matchedWorkspace : null)") && paymentFailedBlock.includes("lifecycleWorkspace = appliedWorkspace || (incomingWasCurrent ? matchedWorkspace : null)") && cancellationBlock.includes("if (!matchedWorkspace || incomingWasCurrent)") && paymentFailedBlock.includes("if (!matchedWorkspace || incomingWasCurrent)"));
expect("Checkout retries never reactivate an existing workspace", !sliceBetween(saas, "if (existingWorkspace.length === 1", "const autoFulfill").includes('subscription_status: "active"'));
expect("security reconciliation and unexpected provisioning failures remain retryable", saas.includes('code = "STRIPE_BILLING_RECONCILIATION_RETRYABLE"') && saas.includes("await setCheckoutProvisioningFallback(claim, provisioningRequestId, errorMessage)") && saas.includes("throw err;"));
expect("all paid non-active billing states lose entitlement", saas.includes("hasWorkspaceBillingEntitlement(ws.plan, ws.subscription_status)"));
expect("checkout claim has bounded stale-processing takeover", saas.includes("checkoutFulfillmentLeaseCutoff()") && saas.includes("stripe_checkout_fulfillments.updated_at < ${staleBefore}"));
expect("checkout recovery uses stable session request id", saas.includes("const requestId = checkoutSessionId") && saas.includes("idx_provisioning_requests_stripe_session_unique"));
expect("paid workspace inserts Stripe binding atomically with workspace", saas.includes("stripe_customer_id, stripe_subscription_id, stripe_billing_event_created") && saas.includes("stripe_customer_id: stripeCustomerId") && saas.includes("stripe_subscription_id: stripeSubscriptionId"));

for (const event of ["stripe_payment_failed", "stripe_subscription_canceled", "stripe_refund_recorded", "stripe_dispute_recorded"]) {
  expect(`provisioning alert event includes ${event}`, alerts.includes(`| "${event}"`));
  expect(`provisioning alert label handles ${event}`, alerts.includes(`case "${event}":`));
}
expect("alert delivery reports transient provider and network failures as retryable", alerts.includes("isRetryableResendResponse") && alerts.includes("retryable: true, error: message"));
expect("smoke suppression requires explicit trusted authority", alerts.includes("input.approvedSyntheticSmoke === true") && !alerts.includes('ownerEmail.includes("smoke+")') && !alerts.includes('businessName.includes("smirk smoke")') && !alerts.includes('source.includes("smoke")'));

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

console.log("OK billing lifecycle contract covers exact billing identity, failed payment, cancellation, refunds, disputes, crash recovery, and non-mutating launch gates");
