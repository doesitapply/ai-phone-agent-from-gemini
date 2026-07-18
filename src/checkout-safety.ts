export type SmirkPaidPlan = "starter" | "pro" | "enterprise";

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

export function shouldProvisionPublicRequest(input: { promoApplied: boolean; isSmokeTestProvisioning: boolean }): boolean {
  return input.promoApplied && !input.isSmokeTestProvisioning;
}

export function classifySmirkCheckoutForFulfillment(
  event: any,
  paymentLinkIds: Partial<Record<SmirkPaidPlan, string>> = {},
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
  const approvedSyntheticSmoke = Boolean(
    event?.livemode === false
    && String(event?.id || "").startsWith("evt_smirk_paid_handoff_")
    && checkoutSessionId.startsWith("cs_test_smirk_paid_handoff_")
    && metadata.source === "gate3-stripe-webhook-smoke"
    && String(metadata.owner_email || session.customer_details?.email || session.customer_email || "").startsWith("smoke+stripe-")
  );
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

  const nativePlan = metadata.smirk_product === "missed_call_recovery" && metadata.smirk_checkout_version === "1"
    ? strictSmirkPaidPlan(metadata.plan)
    : null;
  const paymentLinkId = objectId(session.payment_link);
  const paymentLinkPlan = (Object.entries(paymentLinkIds) as Array<[SmirkPaidPlan, string | undefined]>)
    .find(([, id]) => /^plink_[A-Za-z0-9_]+$/.test(String(id || "")) && id === paymentLinkId)?.[0] || null;
  const plan = nativePlan || paymentLinkPlan;
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
    && Number(session?.amount_total || 0) >= SMIRK_CHECKOUT_AMOUNTS[plan]
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
