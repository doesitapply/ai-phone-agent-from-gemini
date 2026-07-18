export const CHECKOUT_FULFILLMENT_LEASE_MS = 10 * 60 * 1000;

export type WorkspaceBillingStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "refunded"
  | "disputed"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused"
  | "none";

const PAYMENT_SUSPENSION_STATUSES = new Set<WorkspaceBillingStatus>(["refunded", "disputed"]);

export function checkoutFulfillmentLeaseCutoff(nowMs = Date.now()): string {
  return new Date(nowMs - CHECKOUT_FULFILLMENT_LEASE_MS).toISOString();
}

export function isCheckoutFulfillmentClaimReclaimable(
  status: unknown,
  updatedAt: string | number | Date,
  nowMs = Date.now(),
): boolean {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus === "failed") return true;
  if (normalizedStatus !== "processing") return false;
  const updatedAtMs = new Date(updatedAt).getTime();
  return Number.isFinite(updatedAtMs) && updatedAtMs < nowMs - CHECKOUT_FULFILLMENT_LEASE_MS;
}

export function normalizeStripeSubscriptionStatus(raw: unknown): WorkspaceBillingStatus {
  const status = String(raw || "").trim().toLowerCase();
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "canceled":
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
    case "paused":
      return status;
    default:
      return "none";
  }
}

export function stripeBillingEventCreatedSeconds(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function isRestrictiveWorkspaceBillingStatus(status: WorkspaceBillingStatus): boolean {
  return status !== "active" && status !== "trialing";
}

export function shouldReplaceStripeSubscriptionFact(input: {
  currentEventCreated?: number | null;
  currentEventId?: string | null;
  incomingEventCreated: number;
  incomingEventId: string;
  incomingStatus: WorkspaceBillingStatus;
}): boolean {
  if (!input.currentEventCreated) return true;
  if (input.incomingEventCreated > input.currentEventCreated) return true;
  if (input.incomingEventCreated < input.currentEventCreated) return false;
  return isRestrictiveWorkspaceBillingStatus(input.incomingStatus)
    && String(input.currentEventId || "") !== input.incomingEventId;
}

export function isPaymentSuspensionStatus(raw: unknown): boolean {
  return PAYMENT_SUSPENSION_STATUSES.has(String(raw || "").trim().toLowerCase() as WorkspaceBillingStatus);
}

export function matchesExactStripeWorkspaceBinding(
  workspace: { id?: unknown; stripe_customer_id?: unknown; stripe_subscription_id?: unknown } | null | undefined,
  binding: { workspace_id?: unknown; customer_id?: unknown; subscription_id?: unknown } | null | undefined,
): boolean {
  if (!workspace || !binding) return false;
  return Number(workspace.id) === Number(binding.workspace_id)
    && String(workspace.stripe_customer_id || "") === String(binding.customer_id || "")
    && String(workspace.stripe_subscription_id || "") === String(binding.subscription_id || "");
}

export function hasWorkspaceBillingEntitlement(plan: unknown, status: unknown): boolean {
  const normalizedPlan = String(plan || "").trim().toLowerCase();
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedPlan === "free") return normalizedStatus === "trialing" || normalizedStatus === "active";
  return normalizedStatus === "active";
}
