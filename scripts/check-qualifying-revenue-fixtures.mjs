#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  identifySmirkCheckout,
  isClearlyNonCustomer,
  paymentLinkPlanMap,
  resolveExactCheckoutPayment,
  selectExactWorkspace,
  validateRevenueAppOrigin,
} from "./lib/qualifying-revenue-evidence.mjs";

const nowEpoch = 2_000_000_000;

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
      data: [{ id: "il_1", description: "SMIRK AI Starter", amount: 19700, subscription: "sub_real_1", pricing: null }],
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

const wrongProduct = await resolve((state) => { state.lineItems.data[0].description = "Unrelated Starter"; });
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
  const providerReadFailure = await resolveExactCheckoutPayment({ stripe, listedSession: state.session, allowedPaymentLinks: new Map(), nowEpoch });
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
  const unexpandedCharge = await resolveExactCheckoutPayment({ stripe, listedSession: state.session, allowedPaymentLinks: new Map(), nowEpoch });
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
  const unexpandedBalanceTransaction = await resolveExactCheckoutPayment({ stripe, listedSession: state.session, allowedPaymentLinks: new Map(), nowEpoch });
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
  const unresolvedCharge = await resolveExactCheckoutPayment({ stripe, listedSession: state.session, allowedPaymentLinks: new Map(), nowEpoch });
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
  const unresolvedBalanceTransaction = await resolveExactCheckoutPayment({ stripe, listedSession: state.session, allowedPaymentLinks: new Map(), nowEpoch });
  assert.equal(unresolvedBalanceTransaction.ok, false);
  assert.equal(unresolvedBalanceTransaction.reason, "stripe-exact-payment-evidence-read-failed", "an unresolvable BalanceTransaction ID must remain an incomplete provider read, not ordinary no-revenue");
  assert.equal(unresolvedBalanceTransaction.stripeError.statusCode, 403);
}

const paymentLinks = paymentLinkPlanMap({ starter: "plink_starter_live" });
const linkedCheckout = { ...fixture().state.session, metadata: {}, payment_link: "plink_starter_live" };
assert.equal(identifySmirkCheckout(linkedCheckout, paymentLinks).ok, true, "exact allowlisted Payment Link should bind product");
assert.equal(identifySmirkCheckout({ ...linkedCheckout, payment_link: "plink_unrelated" }, paymentLinks).ok, false, "unallowlisted Payment Link must fail");
assert.equal(identifySmirkCheckout({ ...linkedCheckout, currency: "eur" }, paymentLinks).ok, false, "wrong currency must fail");
assert.equal(identifySmirkCheckout({ ...linkedCheckout, amount_total: 1 }, paymentLinks).ok, true, "any positive exact product-bound real payment remains eligible for revenue proof");
assert.equal(identifySmirkCheckout({ ...linkedCheckout, amount_total: 0 }, paymentLinks).ok, false, "zero-dollar checkout must fail");

console.log("OK qualifying revenue fixtures reject wrong payment, product, workspace, refund, dispute, unsafe origin, and truncated evidence");
