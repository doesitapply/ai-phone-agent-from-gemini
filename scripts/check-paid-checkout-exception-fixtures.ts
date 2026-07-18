import assert from "node:assert/strict";
import { extractPaidCheckoutException } from "../src/paid-checkout-exception.js";

const livePaid = {
  id: "evt_live_paid_exception_fixture",
  type: "checkout.session.completed",
  livemode: true,
  data: {
    object: {
      id: "cs_live_paid_exception_fixture",
      livemode: true,
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      payment_link: "plink_old_pro_fixture",
      customer: "cus_fixture",
      subscription: "sub_fixture",
      amount_subtotal: 39700,
      amount_total: 39700,
      currency: "usd",
      customer_details: {
        business_name: "Buyer\nBusiness",
        email: "BUYER@example.net",
        phone: "+1 775 555 0100",
      },
      metadata: { plan: "pro" },
    },
  },
};

const fact = extractPaidCheckoutException(livePaid, {
  reason: "first-dollar-launch-starter-only",
  allowedPaymentLinkIds: ["plink_old_pro_fixture"],
});
assert.ok(fact, "a signed live paid subscription event must produce a durable exception fact");
assert.equal(fact.plan, "pro");
assert.equal(fact.paymentLinkId, "plink_old_pro_fixture");
assert.equal(fact.buyerEmail, "buyer@example.net");
assert.equal(fact.businessName, "Buyer Business", "stored exception identity must be single-line and bounded");
assert.equal(fact.reason, "first-dollar-launch-starter-only");

const nativeSmirkPaid: any = structuredClone(livePaid);
nativeSmirkPaid.id = "evt_live_native_smirk_exception_fixture";
nativeSmirkPaid.data.object.id = "cs_live_native_smirk_exception_fixture";
nativeSmirkPaid.data.object.payment_link = null;
nativeSmirkPaid.data.object.metadata = {
  smirk_product: "missed_call_recovery",
  smirk_checkout_version: "1",
  smirk_customer_policy_version: "fixture-policy-v1",
  plan: "starter",
};
assert.ok(extractPaidCheckoutException(nativeSmirkPaid), "an identified paid SMIRK native Session must remain recoverable after native fulfillment is disabled");

const unrelatedNativePaid: any = structuredClone(nativeSmirkPaid);
unrelatedNativePaid.id = "evt_live_unrelated_native_exception_fixture";
unrelatedNativePaid.data.object.id = "cs_live_unrelated_native_exception_fixture";
unrelatedNativePaid.data.object.metadata = {};
assert.equal(extractPaidCheckoutException(unrelatedNativePaid), null, "an unrelated native Stripe purchase must not enter the SMIRK rescue queue");

const unrelatedPaymentLinkPaid: any = structuredClone(livePaid);
unrelatedPaymentLinkPaid.id = "evt_live_unrelated_payment_link_exception_fixture";
unrelatedPaymentLinkPaid.data.object.id = "cs_live_unrelated_payment_link_exception_fixture";
unrelatedPaymentLinkPaid.data.object.payment_link = "plink_live_unrelated_fixture";
assert.equal(
  extractPaidCheckoutException(unrelatedPaymentLinkPaid, { allowedPaymentLinkIds: ["plink_old_pro_fixture"] }),
  null,
  "an unrelated Stripe Payment Link must not enter the SMIRK rescue queue",
);

const stronglyIdentifiedSmirkPaymentLink: any = structuredClone(nativeSmirkPaid);
stronglyIdentifiedSmirkPaymentLink.id = "evt_live_strong_smirk_payment_link_exception_fixture";
stronglyIdentifiedSmirkPaymentLink.data.object.id = "cs_live_strong_smirk_payment_link_exception_fixture";
stronglyIdentifiedSmirkPaymentLink.data.object.payment_link = "plink_live_unconfigured_smirk_fixture";
assert.ok(
  extractPaidCheckoutException(stronglyIdentifiedSmirkPaymentLink),
  "strong SMIRK metadata must preserve rescue for an unconfigured SMIRK Payment Link",
);

for (const [label, mutate] of [
  ["test event", (value: any) => { value.livemode = false; }],
  ["unpaid Session", (value: any) => { value.data.object.payment_status = "unpaid"; }],
  ["open Session", (value: any) => { value.data.object.status = "open"; }],
  ["one-time payment", (value: any) => { value.data.object.mode = "payment"; }],
  ["unrelated event type", (value: any) => { value.type = "invoice.paid"; }],
] as const) {
  const changed = structuredClone(livePaid);
  mutate(changed);
  assert.equal(extractPaidCheckoutException(changed, { allowedPaymentLinkIds: ["plink_old_pro_fixture"] }), null, `${label} must not create a paid-checkout exception`);
}

console.log("OK paid checkout exceptions capture only identified SMIRK signed live paid subscription Sessions and preserve operator rescue facts");
