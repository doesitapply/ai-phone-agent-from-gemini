import assert from "node:assert/strict";
import {
  createWorkspaceBillingPortalSession,
  evaluateBillingPortalConfiguration,
  verifyBillingPortalConfiguration,
} from "../src/stripe-billing-portal.js";

const key = "rk_live_fixture_portal_123";
const configurationId = "bpc_fixture_live_123";
const validConfiguration = {
  id: configurationId,
  livemode: true,
  active: true,
  features: {
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true },
  },
};

assert.deepEqual(evaluateBillingPortalConfiguration(validConfiguration, configurationId), { ready: true, blockers: [] });
for (const [field, mutation, expected] of [
  ["test mode", (value: any) => { value.livemode = false; }, "portal-configuration-not-live"],
  ["inactive", (value: any) => { value.active = false; }, "portal-configuration-not-active"],
  ["invoice history", (value: any) => { value.features.invoice_history.enabled = false; }, "portal-invoice-history-disabled"],
  ["payment update", (value: any) => { value.features.payment_method_update.enabled = false; }, "portal-payment-method-update-disabled"],
  ["cancellation", (value: any) => { value.features.subscription_cancel.enabled = false; }, "portal-subscription-cancellation-disabled"],
] as const) {
  const candidate = structuredClone(validConfiguration);
  mutation(candidate);
  const result = evaluateBillingPortalConfiguration(candidate, configurationId);
  assert.equal(result.ready, false, `${field} drift must fail closed`);
  assert.equal(result.blockers.includes(expected), true);
}

const wrongKey = await verifyBillingPortalConfiguration({
  restrictedKey: "sk_live_broad_secret_is_forbidden",
  configurationId,
  retrieveConfiguration: async () => validConfiguration,
});
assert.equal(wrongKey.ready, false, "a broad Stripe secret must not replace the dedicated restricted portal key");

const exactRead = await verifyBillingPortalConfiguration({
  restrictedKey: key,
  configurationId,
  retrieveConfiguration: async (id) => {
    assert.equal(id, configurationId);
    return validConfiguration;
  },
});
assert.equal(exactRead.ready, true);

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
