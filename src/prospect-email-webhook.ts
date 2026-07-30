import { createHash } from "node:crypto";
import { Resend, type WebhookEventPayload } from "resend";

const MAX_WEBHOOK_BYTES = 64 * 1024;
const webhookVerifier = new Resend("re_webhook_verification_only");

export type ProspectEmailWebhookConfig = {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  webhookSecret: string;
  workspaceId: number | null;
  fromAddress: string;
  replyToAddress: string;
};

export type ProspectEmailWebhookClassification =
  | {
      kind: "outbound_outcome";
      providerMessageId: string;
      outcome: "delivered" | "bounced" | "dnc" | "failed";
      occurredAt: string;
      suppressionReason?: "bounce" | "complaint" | "suppressed";
    }
  | {
      kind: "inbound_reply_candidate";
      sender: string;
      inboundMessageId: string;
      occurredAt: string;
    }
  | {
      kind: "suppression_added";
      email: string;
      reason: "bounce" | "complaint" | "manual";
      occurredAt: string;
    }
  | {
      kind: "ignored";
      reason: string;
      occurredAt: string;
    };

function positiveInteger(raw: string | undefined): number | null {
  if (!/^\d+$/.test(String(raw || ""))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function normalizeProspectEmailAddress(
  raw: unknown
): string | null {
  const value = String(raw || "").trim();
  const mailbox = value.match(/<([^<>\r\n]+)>$/)?.[1] || value;
  const email = mailbox.trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) &&
    email.length <= 320
    ? email
    : null;
}

export function readProspectEmailWebhookConfig(
  env: Record<string, string | undefined> = process.env
): ProspectEmailWebhookConfig {
  const enabled = env.PROSPECT_EMAIL_WEBHOOK_ENABLED === "true";
  const webhookSecret = String(
    env.PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET || ""
  ).trim();
  const workspaceId = positiveInteger(
    env.PROSPECT_EMAIL_WORKSPACE_ID
  );
  const fromAddress = normalizeProspectEmailAddress(
    env.PROSPECT_EMAIL_FROM
  );
  const replyToAddress = normalizeProspectEmailAddress(
    env.PROSPECT_EMAIL_REPLY_TO
  );
  const missing: string[] = [];
  if (!/^whsec_[A-Za-z0-9+/=_-]{16,}$/.test(webhookSecret)) {
    missing.push("PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET");
  }
  if (!workspaceId) missing.push("PROSPECT_EMAIL_WORKSPACE_ID");
  if (
    !fromAddress ||
    !(
      fromAddress.endsWith("@smirkcalls.com") ||
      fromAddress.split("@")[1]?.endsWith(".smirkcalls.com")
    )
  ) {
    missing.push("PROSPECT_EMAIL_FROM");
  }
  if (
    !replyToAddress ||
    !(
      replyToAddress.endsWith("@smirkcalls.com") ||
      replyToAddress.split("@")[1]?.endsWith(".smirkcalls.com")
    )
  ) {
    missing.push("PROSPECT_EMAIL_REPLY_TO");
  }
  return {
    enabled,
    configured: missing.length === 0,
    missing,
    webhookSecret,
    workspaceId,
    fromAddress: fromAddress || "",
    replyToAddress: replyToAddress || "",
  };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] || "" : raw || "";
}

export function verifyProspectEmailWebhook(input: {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  config: ProspectEmailWebhookConfig;
}): {
  eventId: string;
  event: WebhookEventPayload;
  payloadHash: string;
} {
  if (!input.config.enabled || !input.config.configured) {
    throw new Error("Prospect email webhook is disabled or not configured.");
  }
  if (
    !Buffer.isBuffer(input.rawBody) ||
    input.rawBody.length === 0 ||
    input.rawBody.length > MAX_WEBHOOK_BYTES
  ) {
    throw new Error("Prospect email webhook body is invalid.");
  }
  const eventId = headerValue(input.headers, "svix-id").trim();
  const timestamp = headerValue(input.headers, "svix-timestamp").trim();
  const signature = headerValue(input.headers, "svix-signature").trim();
  if (
    !/^[A-Za-z0-9_-]{8,200}$/.test(eventId) ||
    !/^\d{10,16}$/.test(timestamp) ||
    signature.length < 16 ||
    signature.length > 1_000
  ) {
    throw new Error("Prospect email webhook headers are invalid.");
  }
  const payload = input.rawBody.toString("utf8");
  const event = webhookVerifier.webhooks.verify({
    payload,
    headers: {
      id: eventId,
      timestamp,
      signature,
    },
    webhookSecret: input.config.webhookSecret,
  });
  return {
    eventId,
    event,
    payloadHash: createHash("sha256").update(input.rawBody).digest("hex"),
  };
}

function safeOccurredAt(raw: unknown): string {
  const parsed = new Date(String(raw || ""));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Prospect email webhook timestamp is invalid.");
  }
  return parsed.toISOString();
}

function safeProviderMessageId(raw: unknown): string {
  const value = String(raw || "").trim();
  if (!value || value.length > 200 || /[\s\r\n]/.test(value)) {
    throw new Error("Prospect email provider message ID is invalid.");
  }
  return value;
}

export function classifyProspectEmailWebhookEvent(
  event: WebhookEventPayload,
  expectedFromAddress: string,
  expectedReplyToAddress: string
): ProspectEmailWebhookClassification {
  const occurredAt = safeOccurredAt(event.created_at);
  if (
    event.type === "email.delivered" ||
    event.type === "email.bounced" ||
    event.type === "email.complained" ||
    event.type === "email.failed" ||
    event.type === "email.suppressed"
  ) {
    const from = normalizeProspectEmailAddress(event.data.from);
    if (from !== expectedFromAddress) {
      return {
        kind: "ignored",
        reason: "different_sender",
        occurredAt,
      };
    }
    const providerMessageId = safeProviderMessageId(
      event.data.email_id
    );
    if (event.type === "email.delivered") {
      return {
        kind: "outbound_outcome",
        providerMessageId,
        outcome: "delivered",
        occurredAt,
      };
    }
    if (event.type === "email.bounced") {
      return {
        kind: "outbound_outcome",
        providerMessageId,
        outcome: "bounced",
        occurredAt,
        suppressionReason: "bounce",
      };
    }
    if (event.type === "email.complained") {
      return {
        kind: "outbound_outcome",
        providerMessageId,
        outcome: "dnc",
        occurredAt,
        suppressionReason: "complaint",
      };
    }
    return {
      kind: "outbound_outcome",
      providerMessageId,
      outcome: "failed",
      occurredAt,
      suppressionReason:
        event.type === "email.suppressed" ? "suppressed" : undefined,
    };
  }

  if (event.type === "email.received") {
    const receivedFor = [
      ...event.data.to,
      ...event.data.received_for,
    ]
      .map(normalizeProspectEmailAddress)
      .filter(Boolean);
    if (!receivedFor.includes(expectedReplyToAddress)) {
      return {
        kind: "ignored",
        reason: "different_inbound_receiver",
        occurredAt,
      };
    }
    const sender = normalizeProspectEmailAddress(event.data.from);
    if (!sender) {
      return {
        kind: "ignored",
        reason: "invalid_inbound_sender",
        occurredAt,
      };
    }
    return {
      kind: "inbound_reply_candidate",
      sender,
      inboundMessageId: safeProviderMessageId(event.data.email_id),
      occurredAt,
    };
  }

  if (event.type === "suppression.added") {
    const email = normalizeProspectEmailAddress(event.data.email);
    if (!email) {
      throw new Error("Prospect email suppression address is invalid.");
    }
    return {
      kind: "suppression_added",
      email,
      reason: event.data.origin,
      occurredAt,
    };
  }

  return {
    kind: "ignored",
    reason: event.type.replaceAll(".", "_"),
    occurredAt,
  };
}
