#!/usr/bin/env node
import fs from "node:fs";

const runtime = fs.readFileSync("scripts/check-qualifying-revenue-live.mjs", "utf8");
const evidence = fs.readFileSync("scripts/lib/qualifying-revenue-evidence.mjs", "utf8");
const fixtures = fs.readFileSync("scripts/check-qualifying-revenue-fixtures.mjs", "utf8");
const checkoutSafety = fs.readFileSync("src/checkout-safety.ts", "utf8");
const checkoutFixtures = fs.readFileSync("scripts/check-checkout-fulfillment-fixtures.ts", "utf8");
const saas = fs.readFileSync("src/saas.ts", "utf8");
const buyerRoutes = fs.readFileSync("src/routes/buyer-routes.ts", "utf8");
const provisioning = fs.readFileSync("src/routes/provisioning-routes.ts", "utf8");
const launchRoutes = fs.readFileSync("src/routes/launch-routes.ts", "utf8");
const marketStatus = fs.readFileSync("scripts/check-market-validation-status.mjs", "utf8");
const packageJson = fs.readFileSync("package.json", "utf8");
const launchGoal = fs.readFileSync("docs/SMIRK_30_DAY_MARKET_VALIDATION_GOAL.md", "utf8");

const failures = [];
const expect = (label, condition) => { if (!condition) failures.push(label); };

expect("package exposes strict live revenue check", packageJson.includes('"check:qualifying-revenue-live": "node scripts/check-qualifying-revenue-live.mjs"'));
expect("test suite protects strict revenue contract", packageJson.includes("npm run -s check:real-revenue-contract"));
expect("runtime requires a dedicated live restricted Stripe read key", runtime.includes("STRIPE_REVENUE_READ_KEY") && runtime.includes("/^rk_live_/") && !runtime.includes('value(["STRIPE_REVENUE_READ_KEY", "STRIPE_SECRET_KEY"])'));
expect("runtime pins an exact production origin before sending credentials", runtime.includes("validateRevenueAppOrigin") && evidence.includes("SAFE_PRODUCTION_ORIGINS") && evidence.includes("!url.port") && evidence.includes('url.protocol === "https:"'));
expect("runtime refuses credential-bearing redirects", runtime.includes('redirect: "error"') && runtime.includes("new URL(response.url).origin !== appUrl"));
expect("runtime starts from Checkout Sessions", runtime.includes("stripe.checkout.sessions.list"));
expect("runtime follows exact Checkout Invoice InvoicePayment PaymentIntent chain", evidence.includes("stripe.invoices.retrieve") && evidence.includes("stripe.invoicePayments.list") && evidence.includes("stripe.paymentIntents.retrieve") && !evidence.includes("stripe.paymentIntents.list"));
expect("runtime resolves unexpanded Charge and BalanceTransaction IDs", evidence.includes("stripe.charges.retrieve") && evidence.includes("stripe.balanceTransactions.retrieve") && fixtures.includes("unexpanded latest_charge ID") && fixtures.includes("unexpanded balance_transaction ID"));
expect("runtime requires succeeded allocated funds", evidence.includes('paymentIntent.status !== "succeeded"') && evidence.includes("paymentIntent.amount_received") && evidence.includes("invoicePayment.amount_paid"));
expect("runtime rejects refunds disputes and uncaptured charges", evidence.includes("charge.refunded === true") && evidence.includes("charge.amount_refunded") && evidence.includes("charge.disputed === true") && evidence.includes("charge.captured !== true"));
expect("runtime requires Stripe balance availability", evidence.includes('balanceTransaction.status !== "available"') && evidence.includes("balanceTransaction.available_on"));
expect("runtime fails closed on truncated provider evidence", runtime.includes("scan.truncated") && evidence.includes("invoice-payments-truncated") && evidence.includes("invoice-line-items-truncated"));
expect("runtime binds product through server marker or exact Payment Link", evidence.includes("native_server_marker") && evidence.includes("allowlisted_payment_link") && evidence.includes("checkout-has-no-positive-payment"));
expect("runtime excludes smoke test and team identities", runtime.includes("SMIRK_REVENUE_EXCLUDED_EMAILS") && runtime.includes("isClearlyNonCustomer"));
expect("runtime requires explicit buyer independence attestation", runtime.includes("confirmed-real-customer-unrelated-to-owner-team"));
expect("runtime binds buyer attestation to an exact Stripe customer", runtime.includes("SMIRK_REVENUE_VERIFIED_CUSTOMER_IDS") && runtime.includes("verifiedCustomerIds.has(payment.customerId)"));
expect("runtime correlates exact provider subscription to one production workspace", evidence.includes("selectExactWorkspace") && evidence.includes("subscriptionMatches.length !== 1") && runtime.includes("selectExactWorkspace"));
expect("runtime requires accepted workspace membership", runtime.includes("accepted_at") && runtime.includes("membershipAccepted"));
expect("runtime binds token and profile proof to the exact workspace buyer", runtime.includes("workspace-token-identity-mismatch") && runtime.includes("profileIdentityMatches") && runtime.includes("Number(profile?.id) === Number(workspace.id)"));
expect("runtime requires completed setup and fresh proof", runtime.includes('activationStage !== "proof_complete"') && runtime.includes("profile?.setup_readiness?.ready !== true") && runtime.includes("profile?.proof_freshness?.fresh !== true"));
expect("runtime does not print buyer email", runtime.includes("customerReference") && !runtime.includes("buyerFingerprint") && !runtime.includes("buyer_email:"));
expect("webhook fails closed on unproven checkout events", saas.includes("if (!classification.approved) return null;"));
expect("webhook requires exact live SMIRK paid subscription", checkoutSafety.includes("event?.livemode === true") && checkoutSafety.includes("session?.livemode === true") && checkoutSafety.includes('session?.mode === "subscription"') && checkoutSafety.includes("SMIRK_CHECKOUT_AMOUNTS[plan]"));
expect("native checkout stamps immutable SMIRK product marker", buyerRoutes.includes('smirk_product: "missed_call_recovery"') && buyerRoutes.includes('smirk_checkout_version: "1"'));
expect("webhook supports signed Payment Link events without an API key", buyerRoutes.includes('stripeSecretKey || "sk_test_webhook_signature_only"'));
expect("webhook rejects unsigned payloads unless explicit local override is enabled", buyerRoutes.includes("ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV") && buyerRoutes.includes("allowUnsignedDevWebhook") && buyerRoutes.includes('error: "Webhook signature verification failed"'));
expect("public readiness requires a fulfillable native checkout or exact Payment Link bindings", buyerRoutes.includes("paymentLinkBindingsReady") && buyerRoutes.includes("nativeCheckoutReady || paymentLinkBindingsReady") && buyerRoutes.includes("fulfillmentBound"));
expect("webhook atomically claims and fences exact Checkout Session", saas.includes("stripe_checkout_fulfillments") && saas.includes("ON CONFLICT (checkout_session_id) DO UPDATE") && saas.includes("claimStripeCheckoutFulfillment") && saas.includes("AND claim_token = ${claimToken}"));
expect("public intake cannot auto fulfill a paid plan", provisioning.includes("shouldProvisionPublicRequest({ promoApplied, isSmokeTestProvisioning })") && checkoutSafety.includes("return input.promoApplied && !input.isSmokeTestProvisioning") && !provisioning.includes("autoFulfill || promoApplied"));
expect("public intake reserves internal source values", provisioning.includes("normalizePublicProvisioningSource") && provisioning.includes('return allowed.has(source) ? source : "public_unverified"'));
expect("operator paid signal no longer treats plan selection as payment", !provisioning.includes("pr.requested_plan IN ('starter', 'pro', 'enterprise') THEN TRUE"));
expect("operator paid signal requires verified live activation event", provisioning.includes("FROM activation_events ae") && provisioning.includes("ae.detail ->> 'stripe_livemode' = 'true'") && provisioning.includes("ae.detail ->> 'payment_status' = 'paid'"));
expect("current billing state overrides historical paid signal", provisioning.includes("const paymentActive = hasWorkspace") && provisioning.includes('row.subscription_status === "active"'));
expect("behavior fixtures cover adversarial evidence", fixtures.includes("wrong product must fail") && fixtures.includes("unrelated clean PI must not mask") && fixtures.includes("truncated InvoicePayment evidence") && fixtures.includes("arbitrary APP_URL"));
expect("checkout behavior fixtures cover fulfillment boundaries", checkoutFixtures.includes("public paid-plan intake must never provision") && checkoutFixtures.includes("unconfigured Payment Link must fail") && checkoutFixtures.includes("ordinary test checkout") && checkoutFixtures.includes("underpriced plan"));
expect("operator ledger cannot assert provider revenue", launchRoutes.includes("revenue: false") && launchRoutes.includes("reported_paid_activation: paidActivations >= 1"));
expect("market status routes reported activation to provider verification", marketStatus.includes("provider_verification_required") && marketStatus.includes("check:qualifying-revenue-live"));
expect("launch goal names strict completion command", launchGoal.includes("npm run check:qualifying-revenue-live") && launchGoal.includes("Operator-edited launch-ledger states"));

if (failures.length > 0) {
  console.error("FAIL real revenue proof contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK real revenue proof contract requires live settled unrefunded funds and completed customer activation");
