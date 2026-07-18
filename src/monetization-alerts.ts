import { createHash } from "crypto";
import { normalizePublicHttpsUrl, normalizeTrustedProductionAppUrl, resolveTrustedProductionAppOrigin } from "./public-url-safety.js";
import { normalizeStrictMailbox, parseStrictMailboxList } from "./email-safety.js";

export type ProvisioningAlertEvent =
  | "activation_manual_fallback"
  | "activation_workspace_created"
  | "provisioning_workspace_created"
  | "provisioning_failed"
  | "stripe_manual_fallback"
  | "stripe_workspace_created"
  | "stripe_existing_workspace_updated"
  | "stripe_missing_owner_email"
  | "stripe_payment_failed"
  | "stripe_subscription_canceled"
  | "stripe_refund_recorded"
  | "stripe_dispute_recorded";

export interface ProvisioningAlertInput {
  event: ProvisioningAlertEvent;
  businessName: string;
  ownerEmail: string;
  plan: string;
  mode?: string | null;
  source?: string | null;
  status: string;
  provisioningRequestId?: number | null;
  workspaceId?: number | null;
  inviteLink?: string | null;
  ownerPhone?: string | null;
  intakeNotes?: string | null;
  error?: string | null;
  deliveryScope?: string | null;
  approvedSyntheticSmoke?: boolean;
}

export interface ProvisioningAlertResult {
  sent: boolean;
  recipientCount: number;
  skippedReason?: string;
  error?: string;
  retryable?: boolean;
}

export interface BuyerActivationEmailInput {
  checkoutSessionId: string;
  businessName: string;
  ownerEmail: string;
  plan: string;
  inviteLink: string;
  inviteExpiresAt: string;
  source?: string | null;
  approvedSyntheticSmoke?: boolean;
}

export interface PromoActivationEmailInput {
  provisioningRequestId: number;
  businessName: string;
  ownerEmail: string;
  inviteLink: string;
  inviteExpiresAt: string;
  promoExpiresAt: string;
}

export interface ManualSetupReceiptInput {
  deliveryScope: string;
  businessName: string;
  ownerEmail: string;
  ownerPhone?: string | null;
  intakeNotes?: string | null;
  bookingLink?: string | null;
}

export interface BuyerActivationEmailResult extends ProvisioningAlertResult {
  providerMessageId?: string;
  retryable?: boolean;
}

const RESEND_REQUEST_TIMEOUT_MS = 15_000;

const cleanEmail = (value?: string | null): string | null => {
  return normalizeStrictMailbox(value);
};

const parseEmailList = (value?: string | null): string[] => parseStrictMailboxList(value);

const formatSenderEmail = (fromEmail: string, fromName = "SMIRK"): string => {
  const trimmed = String(fromEmail || "").trim();
  if (!trimmed) return "";
  return /<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>/i.test(trimmed) ? trimmed : `${fromName} <${trimmed}>`;
};

const getAlertRecipients = (): string[] => {
  const recipients = new Set<string>();
  for (const key of ["NOTIFICATION_EMAIL", "OWNER_ALERT_EMAIL", "OWNER_EMAIL", "OPERATOR_EMAIL"]) {
    for (const email of parseEmailList(process.env[key])) recipients.add(email);
  }
  return Array.from(recipients);
};

const shouldSkipAlert = (input: ProvisioningAlertInput): string | null => {
  return input.approvedSyntheticSmoke === true ? "approved synthetic smoke" : null;
};

const shouldSkipBuyerActivation = (input: BuyerActivationEmailInput): string | null => {
  if (input.approvedSyntheticSmoke === true) return "approved synthetic smoke";
  return validateBuyerRecipientAndInvite(input.ownerEmail, input.inviteLink);
};

const validateBuyerRecipientAndInvite = (ownerEmail: string, inviteLink: string): string | null => {
  if (!cleanEmail(ownerEmail)) return "valid buyer email missing";
  const trustedInviteUrl = normalizeTrustedProductionAppUrl(inviteLink);
  if (!trustedInviteUrl) return "valid trusted HTTPS invite link missing";
  const parsedInvite = new URL(trustedInviteUrl);
  if (parsedInvite.search || parsedInvite.hash || !/^\/invite\/(?:[a-f0-9]{64}|[A-Za-z0-9]{48})$/i.test(parsedInvite.pathname)) {
    return "valid trusted HTTPS invite link missing";
  }
  return null;
};

const isRetryableResendResponse = (status: number, responseText: string): boolean => (
  [400, 401, 403, 408, 425, 429].includes(status)
  || status >= 500
  || (status === 409 && /concurrent_idempotent_requests/i.test(responseText))
);

const eventLabel = (event: ProvisioningAlertEvent): string => {
  switch (event) {
    case "activation_workspace_created":
    case "provisioning_workspace_created":
      return "Workspace created";
    case "stripe_workspace_created":
      return "Paid checkout workspace created";
    case "stripe_existing_workspace_updated":
      return "Paid checkout matched existing workspace";
    case "stripe_missing_owner_email":
      return "Paid checkout needs manual rescue";
    case "stripe_payment_failed":
      return "Payment failed";
    case "stripe_subscription_canceled":
      return "Subscription canceled";
    case "stripe_refund_recorded":
      return "Refund recorded";
    case "stripe_dispute_recorded":
      return "Payment dispute recorded";
    case "provisioning_failed":
    case "activation_manual_fallback":
    case "stripe_manual_fallback":
      return "Manual activation required";
  }
};

export async function sendProvisioningAlert(input: ProvisioningAlertInput): Promise<ProvisioningAlertResult> {
  const skippedReason = shouldSkipAlert(input);
  if (skippedReason) return { sent: false, recipientCount: 0, skippedReason };

  const resendKey = String(process.env.RESEND_API_KEY || "").trim();
  const fromEmail = cleanEmail(process.env.FROM_EMAIL);
  const recipients = getAlertRecipients();
  if (!resendKey) return { sent: false, recipientCount: recipients.length, skippedReason: "RESEND_API_KEY missing", retryable: true };
  if (!fromEmail) return { sent: false, recipientCount: recipients.length, skippedReason: "valid FROM_EMAIL missing", retryable: true };
  if (recipients.length === 0) return { sent: false, recipientCount: 0, skippedReason: "no valid operator alert recipients configured", retryable: true };

  const appUrl = resolveTrustedProductionAppOrigin(process.env.APP_URL);
  const subjectPrefix = input.event.startsWith("stripe_") ? "Paid buyer" : "Activation";
  const subject = `SMIRK ${subjectPrefix}: ${eventLabel(input.event)} - ${input.businessName || input.ownerEmail || "unknown buyer"}`;
  const lines = [
    eventLabel(input.event),
    "",
    `Business: ${input.businessName || "(missing)"}`,
    `Owner email: ${input.ownerEmail || "(missing)"}`,
    input.ownerPhone ? `Owner phone: ${input.ownerPhone}` : null,
    input.intakeNotes ? `Setup notes:\n${input.intakeNotes}` : null,
    `Plan: ${input.plan || "(missing)"}`,
    input.mode ? `Mode: ${input.mode}` : null,
    input.source ? `Source: ${input.source}` : null,
    `Status: ${input.status}`,
    input.provisioningRequestId ? `Provisioning request: ${input.provisioningRequestId}` : null,
    input.workspaceId ? `Workspace: ${input.workspaceId}` : null,
    input.inviteLink ? `Invite: ${input.inviteLink}` : null,
    input.error ? `Error: ${input.error}` : null,
    "",
    `Operator queue: ${appUrl}/dashboard`,
  ].filter((line): line is string => line !== null);
  const alertIdentity = input.deliveryScope
    ? { event: input.event, deliveryScope: input.deliveryScope || null }
    : {
        event: input.event,
        provisioningRequestId: input.provisioningRequestId || null,
        workspaceId: input.workspaceId || null,
        businessName: input.businessName || null,
        ownerEmail: input.ownerEmail || null,
        source: input.source || null,
        status: input.status,
        error: input.error || null,
      };
  const alertVersion = createHash("sha256").update(JSON.stringify(alertIdentity)).digest("hex").slice(0, 32);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `smirk_operator_alert_${alertVersion}`,
      },
      body: JSON.stringify({
        from: formatSenderEmail(fromEmail, process.env.FROM_NAME || "SMIRK"),
        to: recipients,
        subject,
        text: lines.join("\n"),
      }),
    });
    if (!response.ok) {
      const responseText = (await response.text()).slice(0, 500);
      return {
        sent: false,
        recipientCount: recipients.length,
        retryable: isRetryableResendResponse(response.status, responseText),
        error: `Resend returned ${response.status}: ${responseText}`,
      };
    }
    return { sent: true, recipientCount: recipients.length, retryable: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { sent: false, recipientCount: recipients.length, retryable: true, error: message };
  }
}

async function sendTransactionalBuyerEmail(input: {
  ownerEmail: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}): Promise<BuyerActivationEmailResult> {
  const resendKey = String(process.env.RESEND_API_KEY || "").trim();
  const fromEmail = cleanEmail(process.env.FROM_EMAIL);
  const buyerEmail = cleanEmail(input.ownerEmail)!;
  if (!resendKey) return { sent: false, recipientCount: 1, skippedReason: "RESEND_API_KEY missing", retryable: true };
  if (!fromEmail) return { sent: false, recipientCount: 1, skippedReason: "valid FROM_EMAIL missing", retryable: true };

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({
        from: formatSenderEmail(fromEmail, process.env.FROM_NAME || "SMIRK"),
        to: [buyerEmail],
        subject: input.subject,
        text: input.text,
      }),
    });
    if (!response.ok) {
      const responseText = (await response.text()).slice(0, 500);
      return {
        sent: false,
        recipientCount: 1,
        retryable: isRetryableResendResponse(response.status, responseText),
        error: `Resend returned ${response.status}: ${responseText}`,
      };
    }
    const body = await response.json().catch(() => ({})) as { id?: unknown };
    return {
      sent: true,
      recipientCount: 1,
      providerMessageId: typeof body.id === "string" ? body.id : undefined,
      retryable: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { sent: false, recipientCount: 1, retryable: true, error: message };
  }
}

export async function sendBuyerActivationEmail(input: BuyerActivationEmailInput): Promise<BuyerActivationEmailResult> {
  const skippedReason = shouldSkipBuyerActivation(input);
  if (skippedReason) return {
    sent: false,
    recipientCount: 0,
    skippedReason,
    retryable: skippedReason === "valid trusted HTTPS invite link missing",
  };

  const appUrl = resolveTrustedProductionAppOrigin(process.env.APP_URL);
  const subject = `Your SMIRK workspace is ready — ${input.businessName || "welcome"}`;
  const parsedInviteExpiry = new Date(input.inviteExpiresAt);
  const inviteExpiryLabel = Number.isFinite(parsedInviteExpiry.getTime())
    ? parsedInviteExpiry.toISOString()
    : "7 days after it was issued";
  const recoveryUrl = `${appUrl}/success?session_id=${encodeURIComponent(input.checkoutSessionId)}`;
  const text = [
    `Your SMIRK ${input.plan || "workspace"} workspace for ${input.businessName || "your business"} is ready.`,
    "",
    "Accept your secure owner invitation:",
    input.inviteLink,
    `This invitation expires at ${inviteExpiryLabel}. If it expires, use the secure Checkout success page to request a fresh owner email.`,
    "Save this secure activation and recovery page:",
    recoveryUrl,
    "",
    "After accepting, finish the business profile and request the guarded proof call from the activation checklist.",
    "If you did not purchase SMIRK, do not use this link and contact support.",
    "",
    `Setup help: ${appUrl}/book`,
  ].join("\n");
  const inviteVersion = createHash("sha256").update(input.inviteLink).digest("hex").slice(0, 24);
  return sendTransactionalBuyerEmail({
    ownerEmail: input.ownerEmail,
    subject,
    text,
    idempotencyKey: `smirk_buyer_activation_${input.checkoutSessionId}_${inviteVersion}`,
  });
}

export async function sendPromoActivationEmail(input: PromoActivationEmailInput): Promise<BuyerActivationEmailResult> {
  const skippedReason = validateBuyerRecipientAndInvite(input.ownerEmail, input.inviteLink);
  if (skippedReason) return {
    sent: false,
    recipientCount: 0,
    skippedReason,
    retryable: skippedReason === "valid trusted HTTPS invite link missing",
  };

  const appUrl = resolveTrustedProductionAppOrigin(process.env.APP_URL);
  const parsedInviteExpiry = new Date(input.inviteExpiresAt);
  const parsedPromoExpiry = new Date(input.promoExpiresAt);
  const inviteExpiryLabel = Number.isFinite(parsedInviteExpiry.getTime()) ? parsedInviteExpiry.toISOString() : "7 days after it was issued";
  const promoExpiryLabel = Number.isFinite(parsedPromoExpiry.getTime()) ? parsedPromoExpiry.toISOString() : "24 hours after activation";
  const subject = `Your SMIRK24 workspace is ready — ${input.businessName || "welcome"}`;
  const text = [
    `Your 24-hour SMIRK workspace for ${input.businessName || "your business"} is ready.`,
    `The promo access window ends at ${promoExpiryLabel}.`,
    "",
    "Accept your secure owner invitation:",
    input.inviteLink,
    `This invitation expires at ${inviteExpiryLabel}.`,
    "",
    "After accepting, finish the business profile and use the activation checklist. No payment was collected for this promo workspace.",
    "If you did not request SMIRK24, do not use this link and contact support.",
    "",
    `Setup help: ${appUrl}/book`,
  ].join("\n");
  const inviteVersion = createHash("sha256").update(input.inviteLink).digest("hex").slice(0, 24);
  return sendTransactionalBuyerEmail({
    ownerEmail: input.ownerEmail,
    subject,
    text,
    idempotencyKey: `smirk_promo_activation_${input.provisioningRequestId}_${inviteVersion}`,
  });
}

export async function sendManualSetupReceipt(input: ManualSetupReceiptInput): Promise<BuyerActivationEmailResult> {
  if (!cleanEmail(input.ownerEmail)) {
    return { sent: false, recipientCount: 0, skippedReason: "valid buyer email missing", retryable: false };
  }
  const bookingLink = normalizePublicHttpsUrl(input.bookingLink);
  const subject = `SMIRK setup request received — ${input.businessName || "your business"}`;
  const text = [
    `We received the SMIRK setup request for ${input.businessName || "your business"}.`,
    input.ownerPhone ? `Business phone: ${input.ownerPhone}` : null,
    input.intakeNotes ? "Your setup notes were saved with the request." : null,
    "This request did not create a charge or an active workspace.",
    "The setup team will review the request and send the next activation step when it is ready.",
    bookingLink ? `For immediate setup help: ${bookingLink}` : null,
    "If you did not submit this request, you can ignore this email.",
  ].filter((line): line is string => Boolean(line)).join("\n\n");
  const deliveryVersion = createHash("sha256").update(JSON.stringify({
    deliveryScope: input.deliveryScope,
    businessName: input.businessName,
    ownerEmail: cleanEmail(input.ownerEmail),
    ownerPhone: input.ownerPhone || null,
    intakeNotes: input.intakeNotes || null,
  })).digest("hex").slice(0, 32);
  return sendTransactionalBuyerEmail({
    ownerEmail: input.ownerEmail,
    subject,
    text,
    idempotencyKey: `smirk_manual_setup_receipt_${deliveryVersion}`,
  });
}
