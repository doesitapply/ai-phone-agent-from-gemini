#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  identifySmirkCheckout,
  isClearlyNonCustomer,
  paymentLinkPlanMap,
  resolveExactCheckoutPayment,
  selectExactWorkspace,
  validateCheckoutActivationEvidence,
  validateRevenueAppOrigin,
  verifyCanonicalRevenuePaymentLinks,
  verifyProviderCheckoutFulfillmentEvent,
} from "./lib/qualifying-revenue-evidence.mjs";

const nowEpoch = 2_000_000_000;
const policyVersion = "fixture-approved-policy-v1";

function fixture() {
  const session = {
    id: "cs_live_smirk_12345678",
    livemode: true,
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    amount_total: 19700,
    currency: "usd",
    created: 1_999_900_000,
    customer: "cus_real_1",
    subscription: "sub_real_1",
    invoice: "in_real_1",
    customer_details: { email: "owner@realplumber.com" },
    metadata: {
      smirk_product: "missed_call_recovery",
      smirk_checkout_version: "1",
      smirk_customer_policy_version: policyVersion,
      plan: "starter",
      owner_email: "owner@realplumber.com",
      business_name: "Real Plumber",
      source: "public_landing",
    },
  };
  const invoice = {
    id: "in_real_1",
    livemode: true,
    status: "paid",
    billing_reason: "subscription_create",
    customer: "cus_real_1",
    customer_email: "owner@realplumber.com",
    currency: "usd",
    amount_paid: 19700,
    created: 1_999_900_010,
    parent: {
      type: "subscription_details",
      subscription_details: {
        subscription: "sub_real_1",
        metadata: { ...session.metadata },
      },
    },
  };
  const invoicePayment = {
    id: "inpay_real_1",
    invoice: "in_real_1",
    livemode: true,
    status: "paid",
    amount_paid: 19700,
    currency: "usd",
    payment: { type: "payment_intent", payment_intent: "pi_exact_refund_target" },
  };
  const paymentIntent = {
    id: "pi_exact_refund_target",
    livemode: true,
    status: "succeeded",
    customer: "cus_real_1",
    amount_received: 19700,
    currency: "usd",
    latest_charge: {
      id: "ch_exact_1",
      livemode: true,
      status: "succeeded",
      paid: true,
      captured: true,
      refunded: false,
      amount_refunded: 0,
      disputed: false,
      balance_transaction: { id: "txn_exact_1", status: "available", available_on: nowEpoch - 60 },
    },
  };
  const state = {
    session,
    invoice,
    invoicePayments: { data: [invoicePayment], has_more: false },
    lineItems: {
      data: [{
        id: "il_1",
        description: "mutable display text is not trusted",
        quantity: 1,
        amount: 19700,
        subscription: "sub_real_1",
        pricing: {
          price_details: {
            price: {
              id: "price_native_starter_1",
              type: "recurring",
              currency: "usd",
              unit_amount: 19700,
              recurring: { interval: "month", interval_count: 1 },
              product: { id: "prod_native_starter_1", name: "SMIRK AI Starter" },
            },
          },
        },
      }],
      has_more: false,
    },
    paymentIntent,
  };
  const stripe = {
    checkout: { sessions: { retrieve: async () => state.session } },
    invoices: {
      retrieve: async () => state.invoice,
      list: async () => ({ data: [state.invoice], has_more: false }),
      listLineItems: async () => state.lineItems,
    },
    invoicePayments: { list: async () => state.invoicePayments },
    paymentIntents: { retrieve: async (id) => {
      assert.equal(id, state.invoicePayments.data[0].payment.payment_intent, "must retrieve the exact InvoicePayment PaymentIntent");
      return state.paymentIntent;
    } },
  };
  return { state, stripe };
}

async function resolve(mutator) {
  const { state, stripe } = fixture();
  if (mutator) mutator(state);
  return resolveExactCheckoutPayment({
    stripe,
    listedSession: state.session,
    allowedPaymentLinks: new Map(),
    nowEpoch,
    policyVersion,
  });
}

const happy = await resolve();
assert.equal(happy.ok, true, "exact native Session -> Invoice -> InvoicePayment -> PaymentIntent chain should qualify");

const refundedExactPayment = await resolve((state) => {
  state.paymentIntent.latest_charge.refunded = true;
  state.paymentIntent.latest_charge.amount_refunded = 19700;
  state.unrelatedCleanPaymentIntent = { id: "pi_same_customer_same_amount_but_unrelated", status: "succeeded" };
});
assert.equal(refundedExactPayment.ok, false, "an unrelated clean PI must not mask the exact refunded PI");
assert.equal(refundedExactPayment.reason, "charge-refunded-disputed-or-uncaptured");

const disputed = await resolve((state) => { state.paymentIntent.latest_charge.disputed = true; });
assert.equal(disputed.ok, false, "disputed charge must fail");

const partiallyRefunded = await resolve((state) => { state.paymentIntent.latest_charge.amount_refunded = 1; });
assert.equal(partiallyRefunded.ok, false, "partially refunded charge is not unrefunded revenue");

const discountedPositive = await resolve((state) => {
  state.session.amount_total = 1;
  state.invoice.amount_paid = 1;
  state.invoicePayments.data[0].amount_paid = 1;
  state.paymentIntent.amount_received = 1;
});
assert.equal(discountedPositive.ok, true, "any exact settled positive real payment may satisfy the revenue amount criterion");

const wrongProduct = await resolve((state) => { state.lineItems.data[0].pricing.price_details.price.product.name = "Unrelated Starter"; });
assert.equal(wrongProduct.ok, false, "wrong product must fail even at the same price");

const wrongProductSubscription = await resolve((state) => { state.lineItems.data[0].subscription = "sub_unrelated"; });
assert.equal(wrongProductSubscription.ok, false, "product line must belong to the exact Checkout subscription");

const wrongSubscription = await resolve((state) => {
  state.invoice.parent.subscription_details.subscription = "sub_unrelated";
});
assert.equal(wrongSubscription.ok, false, "wrong subscription invoice must fail");

const truncatedPayments = await resolve((state) => { state.invoicePayments.has_more = true; });
assert.equal(truncatedPayments.ok, false, "truncated InvoicePayment evidence must fail closed");

const truncatedLines = await resolve((state) => { state.lineItems.has_more = true; });
assert.equal(truncatedLines.ok, false, "truncated product line evidence must fail closed");

const settledLater = await resolve((state) => { state.paymentIntent.latest_charge.balance_transaction.available_on = nowEpoch + 60; });
assert.equal(settledLater.ok, false, "pending provider balance must not qualify as settled revenue");

{
  const { state, stripe } = fixture();
  stripe.paymentIntents.retrieve = async () => {
    const error = new Error("restricted key denied PaymentIntent read");
    error.type = "StripePermissionError";
    error.statusCode = 403;
    throw error;
  };
  const providerReadFailure = await resolveExactCheckoutPayment({ stripe, listedSession: state.session, allowedPaymentLinks: new Map(), nowEpoch, policyVersion });
  assert.equal(providerReadFailure.ok, false);
  assert.equal(providerReadFailure.reason, "stripe-exact-payment-evidence-read-failed", "provider permission failure must remain distinguishable from no revenue");
  assert.equal(providerReadFailure.stripeError.statusCode, 403);
}

const exactWorkspace = selectExactWorkspace([
  { id: 1, stripe_customer_id: "cus_real_1", stripe_subscription_id: "sub_other" },
  { id: 2, stripe_customer_id: "cus_real_1", stripe_subscription_id: "sub_real_1" },
], { customerId: "cus_real_1", subscriptionId: "sub_real_1" });
assert.equal(exactWorkspace.ok, true);
assert.equal(exactWorkspace.workspace.id, 2, "exact subscription must win over same-customer wrong workspace");
assert.equal(selectExactWorkspace([
  { id: 1, stripe_customer_id: "cus_real_1", stripe_subscription_id: "sub_real_1" },
  { id: 2, stripe_customer_id: "cus_real_1", stripe_subscription_id: "sub_real_1" },
], { customerId: "cus_real_1", subscriptionId: "sub_real_1" }).ok, false, "ambiguous subscription workspace must fail");

{
  const { state } = fixture();
  const payment = {
    session: state.session,
    customerId: "cus_real_1",
    subscriptionId: "sub_real_1",
    buyerEmail: "owner@realplumber.com",
    plan: "starter",
  };
  const workspace = {
    id: 42,
    stripe_customer_id: "cus_real_1",
    stripe_subscription_id: "sub_real_1",
    owner_email: "owner@realplumber.com",
    plan: "starter",
  };
  const shortlyAfterCheckout = new Date((state.session.created + 60) * 1000).toISOString();
  const checkoutCompletedAt = new Date((state.session.created + 10) * 1000).toISOString();
  const inviteAcceptedAt = new Date((state.session.created + 120) * 1000).toISOString();
  const setupEventAt = new Date((state.session.created + 180) * 1000).toISOString();
  const proofEventAt = new Date((state.session.created + 240) * 1000).toISOString();
  const completeProofAt = new Date((state.session.created + 300) * 1000).toISOString();
  const activationEvidence = {
    ok: true,
    found: true,
    checkout_session_id: state.session.id,
    fulfillment: { status: "complete", event_id: "evt_checkout_fixture_1" },
    provisioning: {
      id: 77,
      request_id: state.session.id,
      workspace_id: workspace.id,
      owner_email: workspace.owner_email,
      requested_plan: workspace.plan,
      source: "stripe_checkout_completed",
      status: "workspace_created",
      created_at: shortlyAfterCheckout,
    },
    workspace: {
      id: workspace.id,
      owner_email: workspace.owner_email,
      plan: workspace.plan,
      stripe_customer_id: workspace.stripe_customer_id,
      stripe_subscription_id: workspace.stripe_subscription_id,
      created_at: shortlyAfterCheckout,
    },
    automatic_chain: {
      checkout_completed_event: true,
      checkout_completed_at: checkoutCompletedAt,
      workspace_created_by_checkout: true,
      buyer_activation_email_sent: true,
      buyer_activation_email_sent_at: shortlyAfterCheckout,
      owner_invite_accepted: true,
      owner_invite_accepted_at: inviteAcceptedAt,
      buyer_invite_acceptance_event: true,
      buyer_invite_acceptance_event_at: inviteAcceptedAt,
      customer_setup_event: true,
      customer_setup_event_at: setupEventAt,
      customer_proof_event: true,
      customer_proof_event_at: proofEventAt,
      operator_rescue_event: false,
      operator_authored_activation_event: false,
    },
    current_state: {
      activation_stage: "proof_complete",
      setup_ready: true,
      proof_fresh: true,
      setup_completed_at: setupEventAt,
      complete_proof_calls: 1,
      latest_complete_proof_at: completeProofAt,
    },
  };
  assert.equal(validateCheckoutActivationEvidence(activationEvidence, payment, workspace).ok, true, "exact checkout-owned automatic activation chain should qualify");
  const founderRescued = structuredClone(activationEvidence);
  founderRescued.automatic_chain.workspace_created_by_checkout = false;
  assert.equal(validateCheckoutActivationEvidence(founderRescued, payment, workspace).ok, false, "a founder-rescued workspace must not satisfy automatic activation proof");
  const operatorEdited = structuredClone(activationEvidence);
  operatorEdited.automatic_chain.operator_authored_activation_event = true;
  assert.equal(validateCheckoutActivationEvidence(operatorEdited, payment, workspace).ok, false, "operator-authored activation cannot count as unassisted checkout fulfillment");
  const missingBuyerInviteProvenance = structuredClone(activationEvidence);
  missingBuyerInviteProvenance.automatic_chain.buyer_invite_acceptance_event = false;
  assert.equal(validateCheckoutActivationEvidence(missingBuyerInviteProvenance, payment, workspace).ok, false, "membership state without the buyer invite event must not qualify");
  const operatorRescued = structuredClone(activationEvidence);
  operatorRescued.automatic_chain.operator_rescue_event = true;
  operatorRescued.automatic_chain.operator_authored_activation_event = true;
  assert.equal(validateCheckoutActivationEvidence(operatorRescued, payment, workspace).ok, false, "an operator key reveal or founder edit must disqualify the activation chain");
  const missingCustomerSetup = structuredClone(activationEvidence);
  missingCustomerSetup.automatic_chain.customer_setup_event = false;
  assert.equal(validateCheckoutActivationEvidence(missingCustomerSetup, payment, workspace).ok, false, "setup without customer-authored provenance must not qualify");
  const missingCustomerProof = structuredClone(activationEvidence);
  missingCustomerProof.automatic_chain.customer_proof_event = false;
  assert.equal(validateCheckoutActivationEvidence(missingCustomerProof, payment, workspace).ok, false, "proof without customer-authored provenance must not qualify");
  const incompleteCurrentState = structuredClone(activationEvidence);
  incompleteCurrentState.current_state.activation_stage = "setup_complete";
  incompleteCurrentState.current_state.proof_fresh = false;
  assert.equal(validateCheckoutActivationEvidence(incompleteCurrentState, payment, workspace).ok, false, "historical events cannot replace a complete fresh current proof state");
  const proofBeforeCustomerRequest = structuredClone(activationEvidence);
  proofBeforeCustomerRequest.current_state.latest_complete_proof_at = new Date((state.session.created + 200) * 1000).toISOString();
  assert.equal(validateCheckoutActivationEvidence(proofBeforeCustomerRequest, payment, workspace).ok, false, "the complete proof must follow the customer-authored proof request");

  const providerEvent = {
    id: "evt_checkout_fixture_1",
    type: "checkout.session.completed",
    livemode: true,
    created: state.session.created + 10,
    data: { object: structuredClone(state.session) },
  };
  const eventStripe = {
    events: {
      retrieve: async (id) => {
        assert.equal(id, providerEvent.id);
        return providerEvent;
      },
      list: async (params) => {
        assert.equal(params.delivery_success, true, "exact checkout event scan must require provider-reported successful webhook delivery");
        return { data: [providerEvent], has_more: false };
      },
    },
    webhookEndpoints: {
      list: async () => ({
        data: [{
          id: "we_fixture_1",
          url: "https://smirkcalls.com/api/stripe/webhook",
          status: "enabled",
          enabled_events: ["checkout.session.completed"],
        }],
        has_more: false,
      }),
    },
  };
  const deliveredEvent = await verifyProviderCheckoutFulfillmentEvent({
    stripe: eventStripe,
    eventId: providerEvent.id,
    payment,
    policyVersion,
    webhookUrl: "https://smirkcalls.com/api/stripe/webhook",
  });
  assert.equal(deliveredEvent.ok, true, "exact live provider-origin checkout event and successful webhook delivery must qualify");
  eventStripe.webhookEndpoints.list = async () => ({
    data: [{ id: "we_wrong", url: "https://smirkcalls.com/api/unrelated", status: "enabled", enabled_events: ["checkout.session.completed"] }],
    has_more: false,
  });
  const wrongEndpoint = await verifyProviderCheckoutFulfillmentEvent({
    stripe: eventStripe,
    eventId: providerEvent.id,
    payment,
    policyVersion,
    webhookUrl: "https://smirkcalls.com/api/stripe/webhook",
  });
  assert.equal(wrongEndpoint.ok, false, "delivery to an unrelated endpoint must not prove canonical checkout fulfillment");
  eventStripe.webhookEndpoints.list = async () => ({
    data: [{ id: "we_fixture_1", url: "https://smirkcalls.com/api/stripe/webhook", status: "enabled", enabled_events: ["checkout.session.completed"] }],
    has_more: false,
  });
  eventStripe.events.list = async () => ({ data: [], has_more: false });
  const undeliveredEvent = await verifyProviderCheckoutFulfillmentEvent({
    stripe: eventStripe,
    eventId: providerEvent.id,
    payment,
    policyVersion,
    webhookUrl: "https://smirkcalls.com/api/stripe/webhook",
  });
  assert.equal(undeliveredEvent.ok, false, "a locally seeded fulfillment row without provider delivery proof must fail");
  assert.equal(undeliveredEvent.reason, "checkout-fulfillment-provider-delivery-unproven");
  eventStripe.events.retrieve = async () => ({ ...providerEvent, data: { object: { ...providerEvent.data.object, customer: "cus_attacker" } } });
  const mismatchedEvent = await verifyProviderCheckoutFulfillmentEvent({
    stripe: eventStripe,
    eventId: providerEvent.id,
    payment,
    policyVersion,
    webhookUrl: "https://smirkcalls.com/api/stripe/webhook",
  });
  assert.equal(mismatchedEvent.ok, false, "a provider event for a different customer must fail exact fulfillment proof");
}

assert.equal(isClearlyNonCustomer("owner@realplumber.com", new Set()), false, "common real-business mailbox names must remain eligible");
assert.equal(isClearlyNonCustomer("smoke+buyer@example.com", new Set()), true, "synthetic buyer must remain excluded");

assert.deepEqual(validateRevenueAppOrigin("https://ai-phone-agent-production-6811.up.railway.app"), {
  ok: true,
  origin: "https://ai-phone-agent-production-6811.up.railway.app",
});
assert.equal(validateRevenueAppOrigin("https://attacker.example/api").ok, false, "credentials must never be sent to an arbitrary APP_URL");
assert.equal(validateRevenueAppOrigin("https://ai-phone-agent-production-6811.up.railway.app:8443").ok, false, "an allowlisted hostname on a nonstandard port is not an allowlisted production origin");

{
  const { state, stripe } = fixture();
  const exactCharge = state.paymentIntent.latest_charge;
  state.paymentIntent.latest_charge = exactCharge.id;
  let retrievedChargeId = null;
  stripe.charges = {
    retrieve: async (id) => {
      retrievedChargeId = id;
      return exactCharge;
    },
  };
  const unexpandedCharge = await resolveExactCheckoutPayment({ stripe, listedSession: state.session, allowedPaymentLinks: new Map(), nowEpoch, policyVersion });
  assert.equal(unexpandedCharge.ok, true, "an unexpanded latest_charge ID must be resolved through the exact Charge read");
  assert.equal(retrievedChargeId, exactCharge.id, "the verifier must retrieve the exact latest_charge ID");
}

{
  const { state, stripe } = fixture();
  const exactBalanceTransaction = state.paymentIntent.latest_charge.balance_transaction;
  state.paymentIntent.latest_charge.balance_transaction = exactBalanceTransaction.id;
  let retrievedBalanceTransactionId = null;
  stripe.balanceTransactions = {
    retrieve: async (id) => {
      retrievedBalanceTransactionId = id;
      return exactBalanceTransaction;
    },
  };
  const unexpandedBalanceTransaction = await resolveExactCheckoutPayment({ stripe, listedSession: state.session, allowedPaymentLinks: new Map(), nowEpoch, policyVersion });
  assert.equal(unexpandedBalanceTransaction.ok, true, "an unexpanded balance_transaction ID must be resolved through the exact BalanceTransaction read");
  assert.equal(retrievedBalanceTransactionId, exactBalanceTransaction.id, "the verifier must retrieve the exact balance_transaction ID");
}

{
  const { state, stripe } = fixture();
  state.paymentIntent.latest_charge = state.paymentIntent.latest_charge.id;
  stripe.charges = {
    retrieve: async () => {
      const error = new Error("restricted key denied Charge read");
      error.type = "StripePermissionError";
      error.statusCode = 403;
      throw error;
    },
  };
  const unresolvedCharge = await resolveExactCheckoutPayment({ stripe, listedSession: state.session, allowedPaymentLinks: new Map(), nowEpoch, policyVersion });
  assert.equal(unresolvedCharge.ok, false);
  assert.equal(unresolvedCharge.reason, "stripe-exact-payment-evidence-read-failed", "an unresolvable Charge ID must remain an incomplete provider read, not ordinary no-revenue");
  assert.equal(unresolvedCharge.stripeError.statusCode, 403);
}

{
  const { state, stripe } = fixture();
  state.paymentIntent.latest_charge.balance_transaction = state.paymentIntent.latest_charge.balance_transaction.id;
  stripe.balanceTransactions = {
    retrieve: async () => {
      const error = new Error("restricted key denied BalanceTransaction read");
      error.type = "StripePermissionError";
      error.statusCode = 403;
      throw error;
    },
  };
  const unresolvedBalanceTransaction = await resolveExactCheckoutPayment({ stripe, listedSession: state.session, allowedPaymentLinks: new Map(), nowEpoch, policyVersion });
  assert.equal(unresolvedBalanceTransaction.ok, false);
  assert.equal(unresolvedBalanceTransaction.reason, "stripe-exact-payment-evidence-read-failed", "an unresolvable BalanceTransaction ID must remain an incomplete provider read, not ordinary no-revenue");
  assert.equal(unresolvedBalanceTransaction.stripeError.statusCode, 403);
}

const paymentLinks = paymentLinkPlanMap({ starter: "plink_starter_live" });
const linkedCheckout = { ...fixture().state.session, metadata: { smirk_customer_policy_version: policyVersion }, payment_link: "plink_starter_live" };
assert.equal(identifySmirkCheckout(linkedCheckout, paymentLinks, policyVersion).ok, true, "exact allowlisted Payment Link should bind product");
assert.equal(identifySmirkCheckout({ ...linkedCheckout, payment_link: "plink_unrelated" }, paymentLinks, policyVersion).ok, false, "unallowlisted Payment Link must fail");
assert.equal(identifySmirkCheckout({ ...linkedCheckout, currency: "eur" }, paymentLinks, policyVersion).ok, false, "wrong currency must fail");
assert.equal(identifySmirkCheckout({ ...linkedCheckout, amount_total: 1 }, paymentLinks, policyVersion).ok, true, "any positive exact product-bound real payment remains eligible for revenue proof");
assert.equal(identifySmirkCheckout({ ...linkedCheckout, amount_total: 0 }, paymentLinks, policyVersion).ok, false, "zero-dollar checkout must fail");
const nativeMarkersWithWrongLink = {
  ...fixture().state.session,
  payment_link: "plink_unrelated",
  metadata: { ...fixture().state.session.metadata },
};
assert.equal(identifySmirkCheckout(nativeMarkersWithWrongLink, paymentLinks, policyVersion).ok, false, "a present unallowlisted Payment Link must never fall back to native metadata");
assert.equal(identifySmirkCheckout({ ...fixture().state.session, metadata: { ...fixture().state.session.metadata, smirk_customer_policy_version: "stale-policy" } }, new Map(), policyVersion).ok, false, "a stale checkout policy marker must fail");

{
  const configs = [
    { plan: "starter", id: "plink_starter_verified", url: "https://buy.stripe.com/starter" },
    { plan: "pro", id: "plink_pro_verified", url: "https://buy.stripe.com/pro" },
    { plan: "enterprise", id: "plink_enterprise_verified", url: "https://buy.stripe.com/enterprise" },
  ];
  const expected = {
    starter: { amount: 19700, name: "SMIRK AI Starter" },
    pro: { amount: 39700, name: "SMIRK AI Pro" },
    enterprise: { amount: 69700, name: "SMIRK AI Agency" },
  };
  const configById = new Map(configs.map((entry) => [entry.id, entry]));
  let allowPromotionCodes = false;
  const stripe = {
    paymentLinks: {
      retrieve: async (id) => {
        const config = configById.get(id);
        return {
          id,
          livemode: true,
          active: true,
          url: config.url,
          allow_promotion_codes: allowPromotionCodes,
          after_completion: { type: "redirect", redirect: { url: "https://smirkcalls.com/success?session_id={CHECKOUT_SESSION_ID}" } },
          metadata: { smirk_customer_policy_version: policyVersion },
          subscription_data: { metadata: { smirk_customer_policy_version: policyVersion } },
        };
      },
      listLineItems: async (id) => {
        const plan = configById.get(id).plan;
        return {
          has_more: false,
          data: [{
            quantity: 1,
            adjustable_quantity: { enabled: false },
            price: {
              id: `price_${plan}_verified`,
              type: "recurring",
              currency: "usd",
              unit_amount: expected[plan].amount,
              recurring: { interval: "month", interval_count: 1 },
              product: { id: `prod_${plan}_verified`, name: expected[plan].name },
            },
          }],
        };
      },
    },
  };
  const verified = await verifyCanonicalRevenuePaymentLinks({ stripe, configs, policyVersion });
  assert.equal(verified.ok, true, "all three canonical Payment Links must be read and verified from Stripe");
  assert.equal(verified.allowedPaymentLinks.size, 3);
  const starterOnly = await verifyCanonicalRevenuePaymentLinks({ stripe, configs: [configs[0]], policyVersion });
  assert.equal(starterOnly.ok, true, "one enabled plan can be verified independently without an unrelated disabled offer");
  assert.equal(starterOnly.allowedPaymentLinks.size, 1);
  const noConfiguredLink = await verifyCanonicalRevenuePaymentLinks({ stripe, configs: [], policyVersion });
  assert.equal(noConfiguredLink.ok, false, "an empty per-link verification request must fail closed");
  allowPromotionCodes = true;
  const drifted = await verifyCanonicalRevenuePaymentLinks({ stripe, configs, policyVersion });
  assert.equal(drifted.ok, false, "promotion-enabled Payment Link drift must fail authoritative revenue proof");
  const duplicate = await verifyCanonicalRevenuePaymentLinks({
    stripe,
    configs: configs.map((entry, index) => index === 1 ? { ...entry, id: configs[0].id } : entry),
    policyVersion,
  });
  assert.equal(duplicate.ok, false, "duplicate Payment Link IDs must fail closed before evidence scanning");
}

console.log("OK qualifying revenue fixtures reject wrong payment, product, policy, Payment Link, workspace, refund, dispute, unsafe origin, and truncated evidence");
