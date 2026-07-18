import assert from "node:assert/strict";
import {
  createWorkspaceBillingPortalSession,
  evaluateBillingPortalConfiguration,
  verifyBillingPortalConfiguration,
} from "../src/stripe-billing-portal.js";

const key = "rk_live_fixture_portal_123";
const revenueKey = "rk_live_fixture_revenue_123";
const configurationId = "bpc_fixture_live_123";
const policyBinding = {
  termsUrl: "https://smirkcalls.com/terms-fixture",
  privacyUrl: "https://smirkcalls.com/privacy-fixture",
  cancellationMode: "at_period_end",
  cancellationProrationBehavior: "none",
};
const validConfiguration = {
  id: configurationId,
  livemode: true,
  active: true,
  business_profile: {
    terms_of_service_url: policyBinding.termsUrl,
    privacy_policy_url: policyBinding.privacyUrl,
  },
  features: {
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: {
      enabled: true,
      mode: policyBinding.cancellationMode,
      proration_behavior: policyBinding.cancellationProrationBehavior,
    },
  },
};

assert.deepEqual(evaluateBillingPortalConfiguration(validConfiguration, configurationId, policyBinding), { ready: true, blockers: [] });
for (const [field, mutation, expected] of [
  ["test mode", (value: any) => { value.livemode = false; }, "portal-configuration-not-live"],
  ["inactive", (value: any) => { value.active = false; }, "portal-configuration-not-active"],
  ["invoice history", (value: any) => { value.features.invoice_history.enabled = false; }, "portal-invoice-history-disabled"],
  ["payment update", (value: any) => { value.features.payment_method_update.enabled = false; }, "portal-payment-method-update-disabled"],
  ["cancellation", (value: any) => { value.features.subscription_cancel.enabled = false; }, "portal-subscription-cancellation-disabled"],
  ["Terms URL", (value: any) => { value.business_profile.terms_of_service_url = "https://example.invalid/terms"; }, "portal-terms-url-mismatch"],
  ["Privacy URL", (value: any) => { value.business_profile.privacy_policy_url = "https://example.invalid/privacy"; }, "portal-privacy-url-mismatch"],
  ["cancellation mode", (value: any) => { value.features.subscription_cancel.mode = "immediately"; }, "portal-cancellation-mode-mismatch"],
  ["cancellation proration", (value: any) => { value.features.subscription_cancel.proration_behavior = "create_prorations"; }, "portal-cancellation-proration-mismatch"],
] as const) {
  const candidate = structuredClone(validConfiguration);
  mutation(candidate);
  const result = evaluateBillingPortalConfiguration(candidate, configurationId, policyBinding);
  assert.equal(result.ready, false, `${field} drift must fail closed`);
  assert.equal(result.blockers.includes(expected), true);
}

const wrongKey = await verifyBillingPortalConfiguration({
  restrictedKey: "sk_live_broad_secret_is_forbidden",
  revenueRestrictedKey: revenueKey,
  configurationId,
  policyBinding,
  retrieveConfiguration: async () => validConfiguration,
});
assert.equal(wrongKey.ready, false, "a broad Stripe secret must not replace the dedicated restricted portal key");

const exactRead = await verifyBillingPortalConfiguration({
  restrictedKey: key,
  revenueRestrictedKey: revenueKey,
  configurationId,
  policyBinding,
  retrieveConfiguration: async (id) => {
    assert.equal(id, configurationId);
    return validConfiguration;
  },
});
assert.equal(exactRead.ready, true);

const sameKey = await verifyBillingPortalConfiguration({
  restrictedKey: key,
  revenueRestrictedKey: key,
  configurationId,
  policyBinding,
  retrieveConfiguration: async () => { throw new Error("must-not-run"); },
});
assert.deepEqual(sameKey.blockers, ["portal-restricted-key-not-distinct"], "portal and revenue reads require separate restricted keys");

const createCalls: any[] = [];
const created = await createWorkspaceBillingPortalSession({
  workspace: { id: 42, stripe_customer_id: "cus_exact_workspace_42" },
  trustedAppOrigin: "https://smirkcalls.com",
  restrictedKey: key,
  configurationId,
  createSession: async (params) => {
    createCalls.push(params);
    return {
      id: "bps_fixture_session_123",
      url: "https://billing.stripe.com/p/session/fixture_123",
      livemode: true,
      customer: params.customer,
      configuration: params.configuration,
    };
  },
});
assert.equal(created.url, "https://billing.stripe.com/p/session/fixture_123");
assert.deepEqual(createCalls, [{
  customer: "cus_exact_workspace_42",
  configuration: configurationId,
  return_url: "https://smirkcalls.com/?billing=portal_return",
}], "portal creation must use only the authenticated workspace customer and exact trusted return/configuration");

await assert.rejects(() => createWorkspaceBillingPortalSession({
  workspace: { id: 42, stripe_customer_id: "cus_exact_workspace_42" },
  trustedAppOrigin: "https://attacker.example/return",
  restrictedKey: key,
  configurationId,
  createSession: async () => { throw new Error("must-not-run"); },
}), /portal-return-origin-untrusted/);

await assert.rejects(() => createWorkspaceBillingPortalSession({
  workspace: { id: 42, stripe_customer_id: null },
  trustedAppOrigin: "https://smirkcalls.com",
  restrictedKey: key,
  configurationId,
  createSession: async () => { throw new Error("must-not-run"); },
}), /workspace-stripe-customer-id-invalid/);

console.log("OK billing portal fixtures enforce live configuration features, exact tenant customer binding, restricted credentials, and trusted returns");
