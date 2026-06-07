export type ProvisioningAlertEvent =
  | "activation_manual_fallback"
  | "activation_workspace_created"
  | "provisioning_workspace_created"
  | "provisioning_failed"
  | "stripe_manual_fallback"
  | "stripe_workspace_created"
  | "stripe_existing_workspace_updated"
  | "stripe_missing_owner_email";

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
  error?: string | null;
}

export interface ProvisioningAlertResult {
  sent: boolean;
  recipientCount: number;
  skippedReason?: string;
  error?: string;
}

const PLACEHOLDER_EMAIL_RE = /owner@example\.com|example\.com|yourdomain\.com/i;

const cleanEmail = (value?: string | null): string | null => {
  const email = String(value || "").trim();
  if (!email || PLACEHOLDER_EMAIL_RE.test(email)) return null;
  return email;
};

const parseEmailList = (value?: string | null): string[] =>
  String(value || "")
    .split(/[;,]/)
    .map((item) => cleanEmail(item))
    .filter((item): item is string => Boolean(item));

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
  const source = String(input.source || "").toLowerCase();
  const ownerEmail = String(input.ownerEmail || "").toLowerCase();
  const businessName = String(input.businessName || "").toLowerCase();
  if (source.includes("smoke") || ownerEmail.includes("smoke+") || businessName.includes("smirk smoke")) {
    return "smoke test source";
  }
  return null;
};

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
  const fromEmail = String(process.env.FROM_EMAIL || "").trim();
  const recipients = getAlertRecipients();
  if (!resendKey) return { sent: false, recipientCount: recipients.length, skippedReason: "RESEND_API_KEY missing" };
  if (!fromEmail) return { sent: false, recipientCount: recipients.length, skippedReason: "FROM_EMAIL missing" };
  if (recipients.length === 0) return { sent: false, recipientCount: 0, skippedReason: "no operator alert recipients configured" };

  const appUrl = String(process.env.APP_URL || "https://smirkcalls.com").replace(/\/$/, "");
  const subjectPrefix = input.event.startsWith("stripe_") ? "Paid buyer" : "Activation";
  const subject = `SMIRK ${subjectPrefix}: ${eventLabel(input.event)} - ${input.businessName || input.ownerEmail || "unknown buyer"}`;
  const lines = [
    eventLabel(input.event),
    "",
    `Business: ${input.businessName || "(missing)"}`,
    `Owner email: ${input.ownerEmail || "(missing)"}`,
    input.ownerPhone ? `Owner phone: ${input.ownerPhone}` : null,
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

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: formatSenderEmail(fromEmail, process.env.FROM_NAME || "SMIRK"),
        to: recipients,
        subject,
        text: lines.join("\n"),
      }),
    });
    if (!response.ok) {
      return {
        sent: false,
        recipientCount: recipients.length,
        error: `Resend returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
      };
    }
    return { sent: true, recipientCount: recipients.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { sent: false, recipientCount: recipients.length, error: message };
  }
}
