import { hasSmirkNativeCheckoutIdentity, strictSmirkPaidPlan, type SmirkPaidPlan } from "./checkout-safety.js";

const objectId = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "id" in value) {
    return String((value as { id?: unknown }).id || "").trim();
  }
  return "";
};

const cleanSingleLine = (value: unknown, maxLength: number): string => (
  String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength)
);

const amountPlan = (amountSubtotal: number): SmirkPaidPlan | null => {
  if (amountSubtotal === 19700) return "starter";
  if (amountSubtotal === 39700) return "pro";
  if (amountSubtotal === 69700) return "enterprise";
  return null;
};

export type PaidCheckoutExceptionFact = {
  checkoutSessionId: string;
  stripeEventId: string;
  paymentLinkId: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  buyerEmail: string;
  businessName: string;
  ownerPhone: string | null;
  plan: SmirkPaidPlan | "unknown";
  amountSubtotal: number;
  amountTotal: number;
  currency: string;
  reason: string;
};

export function extractPaidCheckoutException(
  event: any,
  input: {
    reason?: string | null;
    plan?: SmirkPaidPlan | null;
    allowedPaymentLinkIds?: readonly string[];
  } = {},
): PaidCheckoutExceptionFact | null {
  const type = String(event?.type || "");
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(type)) return null;
  const session = event?.data?.object || {};
  const checkoutSessionId = objectId(session.id);
  const stripeEventId = objectId(event?.id);
  const paidLiveSubscription = event?.livemode === true
    && session?.livemode === true
    && session?.mode === "subscription"
    && session?.status === "complete"
    && session?.payment_status === "paid"
    && /^cs_live_[A-Za-z0-9_]+$/.test(checkoutSessionId)
    && /^evt_[A-Za-z0-9_]+$/.test(stripeEventId);
  if (!paidLiveSubscription) return null;
  const paymentLinkId = objectId(session?.payment_link);
  const allowedPaymentLinkIds = new Set(
    (input.allowedPaymentLinkIds || [])
      .map((value) => String(value || "").trim())
      .filter((value) => /^plink_[A-Za-z0-9_]+$/.test(value)),
  );
  const strongSmirkIdentity = hasSmirkNativeCheckoutIdentity(session);
  if (paymentLinkId ? !allowedPaymentLinkIds.has(paymentLinkId) && !strongSmirkIdentity : !strongSmirkIdentity) return null;

  const details = session?.customer_details || {};
  const metadata = session?.metadata || {};
  const buyerEmail = cleanSingleLine(details.email || session?.customer_email || metadata.owner_email || "unknown", 254).toLowerCase();
  const businessName = cleanSingleLine(
    details.business_name || details.name || metadata.business_name || buyerEmail || "Unknown Stripe buyer",
    160,
  ) || "Unknown Stripe buyer";
  const ownerPhone = cleanSingleLine(details.phone || metadata.owner_phone || "", 40) || null;
  const amountSubtotal = Number.isSafeInteger(Number(session?.amount_subtotal)) ? Number(session.amount_subtotal) : 0;
  const amountTotal = Number.isSafeInteger(Number(session?.amount_total)) ? Number(session.amount_total) : 0;
  const plan = input.plan
    || strictSmirkPaidPlan(metadata.plan)
    || amountPlan(amountSubtotal)
    || "unknown";
  return {
    checkoutSessionId,
    stripeEventId,
    paymentLinkId: paymentLinkId || null,
    stripeCustomerId: objectId(session?.customer) || null,
    stripeSubscriptionId: objectId(session?.subscription) || null,
    buyerEmail: buyerEmail || "unknown",
    businessName,
    ownerPhone,
    plan,
    amountSubtotal,
    amountTotal,
    currency: cleanSingleLine(session?.currency, 12).toLowerCase() || "unknown",
    reason: cleanSingleLine(input.reason || "checkout fulfillment verification failed", 500),
  };
}
