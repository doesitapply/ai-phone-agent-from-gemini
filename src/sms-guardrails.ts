import type { Sql } from "postgres";
import { addToDNC, checkOutboundCompliance, getConsentStatus, recordConsent } from "./compliance.js";
import { HELP_KEYWORDS, START_KEYWORDS, STOP_KEYWORDS, normalizeSmsKeyword, storeSms } from "./sms.js";

export const SMS_LIVE_CONFIRMATION = "send guarded sms";

type SmsGuardrailConfig = {
  enabled: boolean;
  liveMode: boolean;
  a2pApproved: boolean;
  allowNonAllowlisted: boolean;
  maxPerRecipientPerDay: number;
  maxPerWorkspacePerDay: number;
  minSecondsBetweenRecipient: number;
  dailySpendCapCents: number;
  estimatedCentsPerMessage: number;
  maxBodyLength: number;
  allowedNumbers: string[];
};

type SendGuardedSmsInput = {
  sql: Sql;
  twilioClient: any;
  workspaceId: number;
  from: string;
  to: string;
  body: string;
  appUrl: string;
  purpose?: string;
  contactId?: number | null;
  businessId?: number | null;
  confirmedLive?: boolean;
};

export type GuardedSmsResult = {
  ok: boolean;
  mode: "blocked" | "dry_run" | "sent";
  reasons: string[];
  to: string;
  from: string;
  messageSid?: string;
  estimatedSpendCents?: number;
};

const truthy = (value: unknown): boolean => /^(1|true|yes|on)$/i.test(String(value || "").trim());

export function normalizeSmsPhone(phone: string): string {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (String(phone || "").trim().startsWith("+")) return String(phone).trim();
  return "";
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readSmsGuardrailConfig(): SmsGuardrailConfig {
  return {
    enabled: truthy(process.env.SMS_ENABLED),
    liveMode: String(process.env.SMS_SEND_MODE || "dry_run").toLowerCase() === "live",
    a2pApproved: truthy(process.env.SMS_A2P_CAMPAIGN_APPROVED),
    allowNonAllowlisted: truthy(process.env.SMS_ALLOW_NON_ALLOWLISTED),
    maxPerRecipientPerDay: readPositiveInt("SMS_MAX_PER_RECIPIENT_PER_DAY", 2),
    maxPerWorkspacePerDay: readPositiveInt("SMS_MAX_PER_WORKSPACE_PER_DAY", 20),
    minSecondsBetweenRecipient: readPositiveInt("SMS_MIN_SECONDS_BETWEEN_RECIPIENT", 300),
    dailySpendCapCents: readPositiveInt("SMS_DAILY_SPEND_CAP_CENTS", 200),
    estimatedCentsPerMessage: readPositiveInt("SMS_ESTIMATED_CENTS_PER_MESSAGE", 2),
    maxBodyLength: readPositiveInt("SMS_MAX_BODY_LENGTH", 480),
    allowedNumbers: [
      ...(process.env.SMS_ALLOWED_NUMBERS || "").split(","),
      ...(process.env.COMPLIANCE_ALWAYS_ALLOW_NUMBERS || "").split(","),
    ].map((phone) => normalizeSmsPhone(phone)).filter(Boolean),
  };
}

function hasOptOutLanguage(body: string): boolean {
  return /\bSTOP\b/i.test(body) && /\bHELP\b/i.test(body);
}

async function countRecentSms(sql: Sql, workspaceId: number, to: string) {
  const [workspaceRows, recipientRows, lastRows] = await Promise.all([
    sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count
      FROM sms_messages
      WHERE workspace_id = ${workspaceId}
        AND direction = 'outbound'
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND COALESCE(status, '') NOT IN ('blocked', 'dry_run')
    `,
    sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count
      FROM sms_messages
      WHERE workspace_id = ${workspaceId}
        AND direction = 'outbound'
        AND to_number = ${to}
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND COALESCE(status, '') NOT IN ('blocked', 'dry_run')
    `,
    sql<{ created_at: string }[]>`
      SELECT created_at
      FROM sms_messages
      WHERE workspace_id = ${workspaceId}
        AND direction = 'outbound'
        AND to_number = ${to}
        AND COALESCE(status, '') NOT IN ('blocked', 'dry_run')
      ORDER BY created_at DESC
      LIMIT 1
    `,
  ]);

  return {
    workspaceCount: Number(workspaceRows[0]?.count || 0),
    recipientCount: Number(recipientRows[0]?.count || 0),
    lastRecipientSentAt: lastRows[0]?.created_at ? new Date(lastRows[0].created_at) : null,
  };
}

async function recordOutboundSms(sql: Sql, input: SendGuardedSmsInput, status: string, messageSid?: string | null, errorMessage?: string) {
  await storeSms(sql, {
    messageSid,
    direction: "outbound",
    from: input.from,
    to: input.to,
    body: input.body,
    status,
    errorMessage,
    contactId: input.contactId,
    businessId: input.businessId,
    workspaceId: input.workspaceId,
  });
}

export async function sendGuardedSms(input: SendGuardedSmsInput): Promise<GuardedSmsResult> {
  const config = readSmsGuardrailConfig();
  const to = normalizeSmsPhone(input.to);
  const from = normalizeSmsPhone(input.from);
  const body = String(input.body || "").trim();
  const reasons: string[] = [];
  const allowlisted = config.allowedNumbers.includes(to);

  if (!to) reasons.push("Recipient must be a valid E.164 phone number.");
  if (!from) reasons.push("Sender must be a valid E.164 phone number.");
  if (!body) reasons.push("Message body is required.");
  if (body.length > config.maxBodyLength) reasons.push(`Message exceeds ${config.maxBodyLength} characters.`);
  if (!hasOptOutLanguage(body)) reasons.push("Message must include STOP and HELP instructions.");

  if (to && !allowlisted) {
    const consent = await getConsentStatus(to);
    if (!consent || consent.revoked || !["express_written", "verbal"].includes(String(consent.consent_type || ""))) {
      reasons.push("Recipient does not have active SMS consent on record.");
    }
  }

  if (to && !allowlisted) {
    const compliance = await checkOutboundCompliance(to);
    if (!compliance.allowed) reasons.push(compliance.reason || "Outbound compliance check blocked this number.");
  }

  if (to) {
    const counts = await countRecentSms(input.sql, input.workspaceId, to);
    if (counts.workspaceCount >= config.maxPerWorkspacePerDay) {
      reasons.push(`Workspace daily SMS cap reached (${config.maxPerWorkspacePerDay}).`);
    }
    if (counts.recipientCount >= config.maxPerRecipientPerDay) {
      reasons.push(`Recipient daily SMS cap reached (${config.maxPerRecipientPerDay}).`);
    }
    if (counts.lastRecipientSentAt) {
      const elapsedSeconds = Math.floor((Date.now() - counts.lastRecipientSentAt.getTime()) / 1000);
      if (elapsedSeconds < config.minSecondsBetweenRecipient) {
        reasons.push(`Recipient cooldown active for ${config.minSecondsBetweenRecipient - elapsedSeconds}s.`);
      }
    }
    const estimatedSpendCents = (counts.workspaceCount + 1) * config.estimatedCentsPerMessage;
    if (estimatedSpendCents > config.dailySpendCapCents) {
      reasons.push(`Estimated daily SMS spend cap would be exceeded (${config.dailySpendCapCents} cents).`);
    }
  }

  if (reasons.length > 0) {
    await recordOutboundSms(input.sql, { ...input, to, from, body }, "blocked", null, reasons.join("; "));
    return { ok: false, mode: "blocked", reasons, to, from };
  }

  const liveBlockedReasons: string[] = [];
  if (!config.enabled) liveBlockedReasons.push("SMS_ENABLED is not true.");
  if (!config.liveMode) liveBlockedReasons.push("SMS_SEND_MODE is not live.");
  if (!config.a2pApproved) liveBlockedReasons.push("SMS_A2P_CAMPAIGN_APPROVED is not true.");
  if (!input.confirmedLive) liveBlockedReasons.push(`Request confirmation must be '${SMS_LIVE_CONFIRMATION}'.`);
  if (!allowlisted && !config.allowNonAllowlisted) liveBlockedReasons.push("Recipient is not in SMS_ALLOWED_NUMBERS.");
  if (!input.twilioClient) liveBlockedReasons.push("Twilio client is not configured.");

  if (liveBlockedReasons.length > 0) {
    await recordOutboundSms(input.sql, { ...input, to, from, body }, "dry_run", null, liveBlockedReasons.join("; "));
    return { ok: true, mode: "dry_run", reasons: liveBlockedReasons, to, from };
  }

  const statusCallback = `${input.appUrl.replace(/\/$/, "")}/api/sms/status`;
  const message = await input.twilioClient.messages.create({
    to,
    from,
    body,
    statusCallback,
  });
  await recordOutboundSms(input.sql, { ...input, to, from, body }, message.status || "queued", message.sid);
  return { ok: true, mode: "sent", reasons: [], to, from, messageSid: message.sid };
}

export async function handleIncomingSms(sql: Sql, input: {
  from: string;
  to: string;
  body: string;
  messageSid?: string | null;
  workspaceId?: number | null;
}) {
  const from = normalizeSmsPhone(input.from);
  const to = normalizeSmsPhone(input.to);
  const body = String(input.body || "").trim();
  const keyword = normalizeSmsKeyword(body);

  await storeSms(sql, {
    messageSid: input.messageSid,
    direction: "inbound",
    from,
    to,
    body,
    status: "received",
    workspaceId: input.workspaceId || 1,
  });

  if (STOP_KEYWORDS.has(keyword)) {
    await addToDNC(from, "sms_stop", "sms_keyword", "system");
    await sql`
      UPDATE consent_records
      SET revoked = TRUE, revoked_at = NOW()
      WHERE phone = ${from}
    `;
    return "SMIRK: You are opted out. Reply START to opt back in or HELP for help.";
  }

  if (START_KEYWORDS.has(keyword)) {
    await recordConsent(from, "express_written", "sms_start_keyword");
    return "SMIRK: You are opted in. Reply STOP to opt out or HELP for help.";
  }

  if (HELP_KEYWORDS.has(keyword)) {
    return "SMIRK: Reply STOP to opt out. Contact the business directly for support.";
  }

  return "";
}

export function getSmsSafetyConfigForDisplay() {
  const config = readSmsGuardrailConfig();
  return {
    enabled: config.enabled,
    liveMode: config.liveMode,
    a2pApproved: config.a2pApproved,
    allowNonAllowlisted: config.allowNonAllowlisted,
    maxPerRecipientPerDay: config.maxPerRecipientPerDay,
    maxPerWorkspacePerDay: config.maxPerWorkspacePerDay,
    minSecondsBetweenRecipient: config.minSecondsBetweenRecipient,
    dailySpendCapCents: config.dailySpendCapCents,
    estimatedCentsPerMessage: config.estimatedCentsPerMessage,
    maxBodyLength: config.maxBodyLength,
    allowedNumbersCount: config.allowedNumbers.length,
    liveConfirmation: SMS_LIVE_CONFIRMATION,
  };
}
