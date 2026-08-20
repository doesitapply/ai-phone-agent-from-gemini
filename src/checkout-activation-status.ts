export type CheckoutProvisioningStatusAfterInvite =
  | "PENDING_MANUAL_TELEPHONY"
  | "workspace_created"
  | "manual_fallback_required";

export function checkoutProvisioningStatusAfterInviteDelivery(input: {
  delivered: boolean;
  twilioPhoneNumber?: string | null;
}): CheckoutProvisioningStatusAfterInvite {
  if (!input.delivered) return "manual_fallback_required";
  return String(input.twilioPhoneNumber || "").trim()
    ? "workspace_created"
    : "PENDING_MANUAL_TELEPHONY";
}
