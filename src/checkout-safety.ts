import { evaluateStarterPaymentLinkFulfillmentIds } from "./payment-link-fulfillment-ids.js";

export type SmirkPaidPlan = "starter" | "pro" | "enterprise";
export type SmirkPaymentLinkFulfillmentIds = Partial<Record<SmirkPaidPlan, string | readonly string[]>>;

export const SMIRK_CHECKOUT_AMOUNTS: Record<SmirkPaidPlan, number> = {
  starter: 19700,
  pro: 39700,
  enterprise: 69700,
};

export function strictSmirkPaidPlan(raw: unknown): SmirkPaidPlan | null {
  const value = String(raw || "").trim().toLowerCase();
  if (["starter", "basic"].includes(value)) return "starter";
  if (value === "pro") return "pro";
  if (["enterprise", "agency"].includes(value)) return "enterprise";
  return null;
}

function objectId(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object" && "id" in raw) return String((raw as { id?: unknown }).id || "").trim();
  return "";
}

function validProviderIdentity(session: any): boolean {
  const details = session?.customer_details || {};
  const businessName = String(details.business_name || "").trim();
  const email = String(details.email || "").trim();
  const phone = String(details.phone || "").trim();
  const phoneDigits = phone.replace(/\D/g, "");
  return businessName.length >= 2
    && businessName.length <= 160
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && email.length <= 254
    && phone.length <= 40
    && phoneDigits.length >= 7
    && phoneDigits.length <= 15
    && !/[\r\n]/.test(`${businessName}${email}${phone}`);
}

export function isApprovedSyntheticPaidHandoffSmoke(event: any): boolean {
  const session = event?.data?.object || {};
  const metadata = session.metadata || {};
  const checkoutSessionId = objectId(session.id);
  return Boolean(
    ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(String(event?.type || ""))
    && event?.livemode === false
    && session?.livemode === false
    && session?.object === "checkout.session"
    && session?.mode === "subscription"
    && session?.status === "complete"
    && session?.payment_status === "paid"
    && String(event?.id || "").startsWith("evt_smirk_paid_handoff_")
    && checkoutSessionId.startsWith("cs_test_smirk_paid_handoff_")
    && metadata.source === "gate3-stripe-webhook-smoke"
    && metadata.plan === "starter"
    && String(metadata.owner_email || session.customer_details?.email || session.customer_email || "").startsWith("smoke+stripe-")
  );
}

export function hasSmirkNativeCheckoutIdentity(session: any): boolean {
  const metadata = session?.metadata || {};
  return metadata.smirk_product === "missed_call_recovery"
    && metadata.smirk_checkout_version === "1"
    && strictSmirkPaidPlan(metadata.plan) !== null
    && /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(String(metadata.smirk_customer_policy_version || "").trim());
}

export function shouldProvisionPublicRequest(input: { promoApplied: boolean; isSmokeTestProvisioning: boolean }): boolean {
  return input.promoApplied && !input.isSmokeTestProvisioning;
}

export function paymentLinkFulfillmentBindingsFromEnv(
  env: Record<string, string | undefined> = process.env,
): SmirkPaymentLinkFulfillmentIds {
  const starter = evaluateStarterPaymentLinkFulfillmentIds({
    currentId: env.STRIPE_PAYMENT_LINK_STARTER_ID,
    rawIds: env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS,
  });
  const exactId = (value: unknown) => /^plink_[A-Za-z0-9_]+$/.test(String(value || "").trim())
    ? String(value).trim()
    : "";
  return {
    starter: starter.ready ? starter.ids : [],
    pro: exactId(env.STRIPE_PAYMENT_LINK_PRO_ID),
    enterprise: exactId(env.STRIPE_PAYMENT_LINK_ENTERPRISE_ID),
  };
}

export function classifySmirkCheckoutForFulfillment(
  event: any,
  paymentLinkIds: SmirkPaymentLinkFulfillmentIds = {},
  approvedCustomerPolicyVersion = "",
  { allowNativeCheckout = false }: { allowNativeCheckout?: boolean } = {},
): {
  approved: boolean;
  approvedSyntheticSmoke: boolean;
  livePaidCheckout: boolean;
  plan: SmirkPaidPlan | null;
  session: any;
  checkoutSessionId: string;
  reason: string;
} {
  const session = event?.data?.object || {};
  const metadata = session.metadata || {};
  const checkoutSessionId = objectId(session.id);
  const approvedSyntheticSmoke = isApprovedSyntheticPaidHandoffSmoke(event);
  if (approvedSyntheticSmoke) {
    return {
      approved: true,
      approvedSyntheticSmoke: true,
      livePaidCheckout: false,
      plan: strictSmirkPaidPlan(metadata.plan) || "starter",
      session,
      checkoutSessionId,
      reason: "approved-synthetic-smoke",
    };
  }

  const policyVersionMatches = /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(approvedCustomerPolicyVersion)
    && metadata.smirk_customer_policy_version === approvedCustomerPolicyVersion;
  const paymentLinkId = objectId(session.payment_link);
  const nativePlan = allowNativeCheckout && !paymentLinkId
    && policyVersionMatches
    && metadata.smirk_product === "missed_call_recovery"
    && metadata.smirk_checkout_version === "1"
    ? strictSmirkPaidPlan(metadata.plan)
    : null;
  const paymentLinkPlanMatches = paymentLinkId && policyVersionMatches
    ? (Object.entries(paymentLinkIds) as Array<[SmirkPaidPlan, string | readonly string[] | undefined]>)
      .filter(([, configured]) => {
        const ids = Array.isArray(configured) ? configured : [configured];
        return ids.some((id) => /^plink_[A-Za-z0-9_]+$/.test(String(id || "")) && id === paymentLinkId);
      })
      .map(([candidatePlan]) => candidatePlan)
    : [];
  const paymentLinkPlan = paymentLinkPlanMatches.length === 1 ? paymentLinkPlanMatches[0] : null;
  // Payment Link sessions must always use the exact allowlisted plink_ lane.
  // Native metadata is dormant during the hosted-only first-dollar launch and
  // becomes authoritative only in a separately reviewed caller that opts in.
  const plan = paymentLinkId ? paymentLinkPlan : nativePlan;
  const livePaidCheckout = Boolean(
    event?.livemode === true
    && session?.livemode === true
    && session?.mode === "subscription"
    && session?.status === "complete"
    && session?.payment_status === "paid"
    && session?.currency === "usd"
    && objectId(session?.customer)
    && objectId(session?.subscription)
    && plan
    && plan === "starter"
    && Number(session?.amount_subtotal || 0) === SMIRK_CHECKOUT_AMOUNTS[plan]
    && Number(session?.amount_total || 0) >= Number(session?.amount_subtotal || 0)
    && validProviderIdentity(session)
    && session?.consent?.terms_of_service === "accepted"
  );
  return {
    approved: livePaidCheckout,
    approvedSyntheticSmoke: false,
    livePaidCheckout,
    plan,
    session,
    checkoutSessionId,
    reason: livePaidCheckout ? "verified-live-smirk-checkout" : "unverified-or-unrelated-checkout",
  };
}
