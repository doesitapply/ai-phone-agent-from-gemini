import type { Workspace } from "./saas.js";
import { normalizeTrustedProductionAppUrl } from "./public-url-safety.js";

export type BillingPortalReadiness = {
  ready: boolean;
  blockers: string[];
};

type PortalConfiguration = {
  id?: string;
  active?: boolean;
  livemode?: boolean;
  business_profile?: {
    terms_of_service_url?: string | null;
    privacy_policy_url?: string | null;
  };
  features?: {
    invoice_history?: { enabled?: boolean };
    payment_method_update?: { enabled?: boolean };
    subscription_cancel?: {
      enabled?: boolean;
      mode?: string;
      proration_behavior?: string;
    };
  };
};

export type BillingPortalPolicyBinding = {
  termsUrl: string;
  privacyUrl: string;
  cancellationMode: string;
  cancellationProrationBehavior: string;
};

type PortalSession = {
  id?: string;
  url?: string | null;
  livemode?: boolean;
  customer?: string | { id?: string } | null;
  configuration?: string | { id?: string } | null;
};

export const validBillingPortalRestrictedKey = (value: unknown): boolean => (
  /^rk_live_[A-Za-z0-9_]+$/.test(String(value || "").trim())
);

export const validBillingPortalConfigurationId = (value: unknown): boolean => (
  /^bpc_[A-Za-z0-9_]+$/.test(String(value || "").trim())
);

export function evaluateBillingPortalConfiguration(
  configuration: PortalConfiguration | null | undefined,
  expectedConfigurationId: string,
  expectedPolicy: BillingPortalPolicyBinding,
): BillingPortalReadiness {
  const blockers: string[] = [];
  if (!configuration || configuration.id !== expectedConfigurationId) blockers.push("portal-configuration-id-mismatch");
  if (configuration?.livemode !== true) blockers.push("portal-configuration-not-live");
  if (configuration?.active !== true) blockers.push("portal-configuration-not-active");
  if (configuration?.features?.invoice_history?.enabled !== true) blockers.push("portal-invoice-history-disabled");
  if (configuration?.features?.payment_method_update?.enabled !== true) blockers.push("portal-payment-method-update-disabled");
  if (configuration?.features?.subscription_cancel?.enabled !== true) blockers.push("portal-subscription-cancellation-disabled");
  if (!expectedPolicy?.termsUrl || configuration?.business_profile?.terms_of_service_url !== expectedPolicy.termsUrl) {
    blockers.push("portal-terms-url-mismatch");
  }
  if (!expectedPolicy?.privacyUrl || configuration?.business_profile?.privacy_policy_url !== expectedPolicy.privacyUrl) {
    blockers.push("portal-privacy-url-mismatch");
  }
  if (!expectedPolicy?.cancellationMode || configuration?.features?.subscription_cancel?.mode !== expectedPolicy.cancellationMode) {
    blockers.push("portal-cancellation-mode-mismatch");
  }
  if (
    !expectedPolicy?.cancellationProrationBehavior
    || configuration?.features?.subscription_cancel?.proration_behavior !== expectedPolicy.cancellationProrationBehavior
  ) {
    blockers.push("portal-cancellation-proration-mismatch");
  }
  return { ready: blockers.length === 0, blockers };
}

export async function verifyBillingPortalConfiguration(input: {
  restrictedKey: string;
  revenueRestrictedKey: string;
  configurationId: string;
  policyBinding: BillingPortalPolicyBinding;
  retrieveConfiguration: (configurationId: string) => Promise<PortalConfiguration>;
}): Promise<BillingPortalReadiness> {
  if (!validBillingPortalRestrictedKey(input.restrictedKey)) {
    return { ready: false, blockers: ["portal-dedicated-live-restricted-key-invalid"] };
  }
  if (!validBillingPortalRestrictedKey(input.revenueRestrictedKey)) {
    return { ready: false, blockers: ["portal-revenue-live-restricted-key-invalid"] };
  }
  if (input.restrictedKey === String(input.revenueRestrictedKey || "").trim()) {
    return { ready: false, blockers: ["portal-restricted-key-not-distinct"] };
  }
  if (!validBillingPortalConfigurationId(input.configurationId)) {
    return { ready: false, blockers: ["portal-configuration-id-invalid"] };
  }
  try {
    const configuration = await input.retrieveConfiguration(input.configurationId);
    return evaluateBillingPortalConfiguration(configuration, input.configurationId, input.policyBinding);
  } catch {
    return { ready: false, blockers: ["portal-configuration-provider-read-failed"] };
  }
}

const exactStripeObjectId = (value: unknown): string => {
  if (typeof value === "string") return value;
  return String((value as { id?: unknown } | null)?.id || "");
};

export async function createWorkspaceBillingPortalSession(input: {
  workspace: Pick<Workspace, "id" | "stripe_customer_id">;
  trustedAppOrigin: string;
  restrictedKey: string;
  configurationId: string;
  createSession: (params: {
    customer: string;
    configuration: string;
    return_url: string;
  }) => Promise<PortalSession>;
}): Promise<{ id: string; url: string; returnUrl: string }> {
  if (!Number.isSafeInteger(Number(input.workspace?.id)) || Number(input.workspace.id) <= 0) {
    throw new Error("workspace-billing-identity-invalid");
  }
  const customerId = String(input.workspace?.stripe_customer_id || "").trim();
  if (!/^cus_[A-Za-z0-9_]+$/.test(customerId)) throw new Error("workspace-stripe-customer-id-invalid");
  if (!validBillingPortalRestrictedKey(input.restrictedKey)) throw new Error("portal-dedicated-live-restricted-key-invalid");
  if (!validBillingPortalConfigurationId(input.configurationId)) throw new Error("portal-configuration-id-invalid");
  const trustedOrigin = normalizeTrustedProductionAppUrl(input.trustedAppOrigin);
  if (!trustedOrigin) throw new Error("portal-return-origin-untrusted");
  const returnUrl = new URL("/?billing=portal_return", trustedOrigin).href;
  const session = await input.createSession({
    customer: customerId,
    configuration: input.configurationId,
    return_url: returnUrl,
  });
  const url = String(session?.url || "").trim();
  let portalUrl: URL;
  try {
    portalUrl = new URL(url);
  } catch {
    throw new Error("portal-session-url-invalid");
  }
  if (portalUrl.origin !== "https://billing.stripe.com" || !portalUrl.pathname.startsWith("/p/session/")) {
    throw new Error("portal-session-url-untrusted");
  }
  if (session?.livemode !== true) throw new Error("portal-session-not-live");
  if (exactStripeObjectId(session?.customer) !== customerId) throw new Error("portal-session-customer-mismatch");
  if (exactStripeObjectId(session?.configuration) !== input.configurationId) throw new Error("portal-session-configuration-mismatch");
  const sessionId = String(session?.id || "").trim();
  if (!/^bps_[A-Za-z0-9_]+$/.test(sessionId)) throw new Error("portal-session-id-invalid");
  return { id: sessionId, url: portalUrl.href, returnUrl };
}
