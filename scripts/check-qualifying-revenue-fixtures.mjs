#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  inactiveHistoricalStarterPaymentLinkBinding,
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
const taxMode = "stripe_automatic_tax";

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
      customer_proof_request_id: 901,
      customer_proof_call_linked: true,
      customer_proof_call_sid: "CA11111111111111111111111111111111",
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
      linked_proof_call_sid: "CA11111111111111111111111111111111",
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
  const unrelatedLaterCall = structuredClone(activationEvidence);
  unrelatedLaterCall.automatic_chain.customer_proof_call_linked = false;
  unrelatedLaterCall.automatic_chain.customer_proof_call_sid = null;
  unrelatedLaterCall.current_state.linked_proof_call_sid = null;
  unrelatedLaterCall.current_state.latest_complete_proof_at = new Date((state.session.created + 360) * 1000).toISOString();
  assert.equal(validateCheckoutActivationEvidence(unrelatedLaterCall, payment, workspace).ok, false, "an unrelated later workspace call must not fulfill the customer's proof request");
  const mismatchedLinkedCall = structuredClone(activationEvidence);
  mismatchedLinkedCall.current_state.linked_proof_call_sid = "CA22222222222222222222222222222222";
  assert.equal(validateCheckoutActivationEvidence(mismatchedLinkedCall, payment, workspace).ok, false, "activation current state must name the same exact call linked to the customer request");

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
  const historicalId = "plink_prior_inactive_starter";
  const historicalBinding = inactiveHistoricalStarterPaymentLinkBinding(
    { id: historicalId, livemode: true, active: false },
    historicalId,
    policyVersion,
  );
  assert.equal(historicalBinding.ok, true, "an exact provider-inactive historical Starter ID may bind immutable paid revenue evidence");
  assert.equal(
    inactiveHistoricalStarterPaymentLinkBinding({ id: historicalId, livemode: true, active: true }, historicalId, policyVersion).ok,
    false,
    "a reactivated historical Payment Link must never qualify revenue",
  );
  const { state, stripe } = fixture();
  state.session = {
    ...state.session,
    payment_link: historicalId,
    metadata: { smirk_customer_policy_version: policyVersion },
  };
  state.lineItems.data[0].description = "SMIRK AI Starter";
  state.lineItems.data[0].pricing.price_details.price.id = "price_prior_starter";
  state.lineItems.data[0].pricing.price_details.price.product.id = "prod_prior_starter";
  state.lineItems.data[0].pricing.price_details.price.product.name = "Renamed after the paid Checkout";
  const historicalPayment = await resolveExactCheckoutPayment({
    stripe,
    listedSession: state.session,
    allowedPaymentLinks: new Map([[historicalId, historicalBinding.binding]]),
    nowEpoch,
    policyVersion,
  });
  assert.equal(historicalPayment.ok, true, "a settled old Session from an exact inactive historical Starter ID must remain revenue-eligible after link rotation");
  state.lineItems.data[0].description = "Unrelated product snapshot";
  const wrongHistoricalDescription = await resolveExactCheckoutPayment({
    stripe,
    listedSession: state.session,
    allowedPaymentLinks: new Map([[historicalId, historicalBinding.binding]]),
    nowEpoch,
    policyVersion,
  });
  assert.equal(wrongHistoricalDescription.ok, false, "historical-ID revenue must still require the immutable canonical Starter line description");
}

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
  const providerState = {
    linkCurrency: "usd",
    allowPromotionCodes: false,
    trialPeriodDays: null,
    optionalItems: [],
    shippingAddressCollection: null,
    shippingOptions: [],
    termsConsent: "required",
    phoneCollectionEnabled: true,
    businessNameCollectionEnabled: true,
    businessNameCollectionOptional: false,
    automaticTaxEnabled: true,
    priceActive: true,
    priceLivemode: true,
    priceBillingScheme: "per_unit",
    priceCustomUnitAmount: null,
    priceTransformQuantity: null,
    priceUsageType: "licensed",
    priceMeter: null,
    priceTrialPeriodDays: null,
    productActive: true,
    productLivemode: true,
  };
  const stripe = {
    paymentLinks: {
      retrieve: async (id) => {
        const config = configById.get(id);
        return {
          id,
          livemode: true,
          active: true,
          url: config.url,
          currency: providerState.linkCurrency,
          allow_promotion_codes: providerState.allowPromotionCodes,
          optional_items: providerState.optionalItems,
          shipping_address_collection: providerState.shippingAddressCollection,
          shipping_options: providerState.shippingOptions,
          consent_collection: { terms_of_service: providerState.termsConsent },
          phone_number_collection: { enabled: providerState.phoneCollectionEnabled },
          name_collection: {
            business: {
              enabled: providerState.businessNameCollectionEnabled,
              optional: providerState.businessNameCollectionOptional,
            },
          },
          automatic_tax: { enabled: providerState.automaticTaxEnabled },
          after_completion: { type: "redirect", redirect: { url: "https://smirkcalls.com/success?session_id={CHECKOUT_SESSION_ID}" } },
          metadata: { smirk_customer_policy_version: policyVersion },
          subscription_data: {
            metadata: { smirk_customer_policy_version: policyVersion },
            trial_period_days: providerState.trialPeriodDays,
          },
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
              active: providerState.priceActive,
              livemode: providerState.priceLivemode,
              billing_scheme: providerState.priceBillingScheme,
              custom_unit_amount: providerState.priceCustomUnitAmount,
              transform_quantity: providerState.priceTransformQuantity,
              type: "recurring",
              currency: "usd",
              unit_amount: expected[plan].amount,
              recurring: {
                interval: "month",
                interval_count: 1,
                usage_type: providerState.priceUsageType,
                meter: providerState.priceMeter,
                trial_period_days: providerState.priceTrialPeriodDays,
              },
              product: {
                id: `prod_${plan}_verified`,
                active: providerState.productActive,
                livemode: providerState.productLivemode,
                name: expected[plan].name,
              },
            },
          }],
        };
      },
    },
  };
  const verified = await verifyCanonicalRevenuePaymentLinks({ stripe, configs, policyVersion, taxMode });
  assert.equal(verified.ok, true, "all three canonical Payment Links must be read and verified from Stripe");
  assert.equal(verified.allowedPaymentLinks.size, 3);
  const starterOnly = await verifyCanonicalRevenuePaymentLinks({ stripe, configs: [configs[0]], policyVersion, taxMode });
  assert.equal(starterOnly.ok, true, "one enabled plan can be verified independently without an unrelated disabled offer");
  assert.equal(starterOnly.allowedPaymentLinks.size, 1);
  const noConfiguredLink = await verifyCanonicalRevenuePaymentLinks({ stripe, configs: [], policyVersion, taxMode });
  assert.equal(noConfiguredLink.ok, false, "an empty per-link verification request must fail closed");
  for (const [label, stateKey, driftValue, failedCheck] of [
    ["non-USD Payment Link base currency drift", "linkCurrency", "eur", "link-base-currency-usd"],
    ["promotion-enabled Payment Link drift", "allowPromotionCodes", true, "promotion-codes-disabled"],
    ["trial-enabled Payment Link drift", "trialPeriodDays", 30, "trial-disabled"],
    ["optional-item Payment Link drift", "optionalItems", [{ price: "price_optional_verified", quantity: 1 }], "optional-items-disabled"],
    ["shipping-collection Payment Link drift", "shippingAddressCollection", { allowed_countries: ["US"] }, "shipping-address-collection-disabled"],
    ["shipping-option Payment Link drift", "shippingOptions", [{ shipping_rate: "shr_verified", shipping_amount: 500 }], "shipping-options-disabled"],
    ["missing Terms consent Payment Link drift", "termsConsent", null, "terms-consent-required"],
    ["missing phone collection Payment Link drift", "phoneCollectionEnabled", false, "phone-collection-required"],
    ["missing business-name collection Payment Link drift", "businessNameCollectionEnabled", false, "business-name-collection-required"],
    ["optional business-name collection Payment Link drift", "businessNameCollectionOptional", true, "business-name-collection-required"],
    ["automatic tax Payment Link drift", "automaticTaxEnabled", false, "approved-tax-mode"],
    ["inactive Price drift", "priceActive", false, "price-active"],
    ["test-mode Price drift", "priceLivemode", false, "price-live-mode"],
    ["tiered Price drift", "priceBillingScheme", "tiered", "immediate-licensed-billing-model"],
    ["custom-amount Price drift", "priceCustomUnitAmount", { minimum: 1 }, "immediate-licensed-billing-model"],
    ["transformed-quantity Price drift", "priceTransformQuantity", { divide_by: 100, round: "up" }, "immediate-licensed-billing-model"],
    ["metered Price drift", "priceUsageType", "metered", "immediate-licensed-billing-model"],
    ["meter-bound Price drift", "priceMeter", "mtr_verified", "immediate-licensed-billing-model"],
    ["default-trial Price drift", "priceTrialPeriodDays", 30, "immediate-licensed-billing-model"],
    ["inactive Product drift", "productActive", false, "product-active"],
    ["test-mode Product drift", "productLivemode", false, "product-live-mode"],
  ]) {
    const previousValue = providerState[stateKey];
    providerState[stateKey] = driftValue;
    const drifted = await verifyCanonicalRevenuePaymentLinks({ stripe, configs, policyVersion, taxMode });
    assert.equal(drifted.ok, false, `${label} must fail authoritative revenue proof`);
    assert.ok(drifted.failedChecks?.includes(failedCheck), `${label} must report ${failedCheck}`);
    providerState[stateKey] = previousValue;
  }
  const duplicate = await verifyCanonicalRevenuePaymentLinks({
    stripe,
    configs: configs.map((entry, index) => index === 1 ? { ...entry, id: configs[0].id } : entry),
    policyVersion,
    taxMode,
  });
  assert.equal(duplicate.ok, false, "duplicate Payment Link IDs must fail closed before evidence scanning");
  const invalidTaxMode = await verifyCanonicalRevenuePaymentLinks({ stripe, configs, policyVersion, taxMode: "" });
  assert.equal(invalidTaxMode.ok, false, "an unapproved tax mode must fail closed before evidence scanning");
  assert.equal(invalidTaxMode.reason, "approved-customer-policy-tax-mode-invalid");
}

console.log("OK qualifying revenue fixtures reject wrong payment, product, policy, Payment Link, workspace, refund, dispute, unsafe origin, and truncated evidence");
