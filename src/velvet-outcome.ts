export const VELVET_OUTCOMES = [
  "interested",
  "not_interested",
  "callback",
  "booked",
  "no_answer",
  "voicemail",
] as const;

export type VelvetOutcome = (typeof VELVET_OUTCOMES)[number];

export type VelvetOutcomeConfig = {
  apiKey: string;
  baseUrl: string | null;
  workspaceId: number | null;
  missing: string[];
  configured: boolean;
};

export type DeliverVelvetOutcomeInput = {
  externalId: string;
  callId: string;
  outcome: VelvetOutcome;
  summary: string;
  callDuration: number | null;
  calledAt: Date | string | null;
};

type DeliverVelvetOutcomeOptions = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

const SECRET_NAME = /(?:KEY|TOKEN|SECRET)$/i;
const SECRET_PLACEHOLDER = /(?:generate|change.?me|replace.?me|placeholder|example|your.?key|32.?plus.?character)/i;

const SMIRK_TO_VELVET_OUTCOME: Record<string, VelvetOutcome | null> = {
  appointment_booked: "booked",
  appointment_rescheduled: "booked",
  appointment_cancelled: "not_interested",
  lead_captured: "interested",
  escalated: "interested",
  callback_needed: "callback",
  incomplete: "no_answer",
  do_not_call: "not_interested",
  voicemail: "voicemail",
  spam: "not_interested",
  resolved: "interested",
};

export function mapSmirkOutcomeToVelvet(smirkOutcome: string | null | undefined): VelvetOutcome | null {
  return SMIRK_TO_VELVET_OUTCOME[String(smirkOutcome || "").trim()] ?? null;
}

export function parseVelvetLeadId(externalId: string): number | null {
  const match = /^velvet-(\d+)-[A-Za-z0-9:_-]+$/.exec(String(externalId || ""));
  const leadId = Number(match?.[1]);
  return Number.isSafeInteger(leadId) && leadId > 0 ? leadId : null;
}

export function readVelvetOutcomeConfig(
  env: Record<string, string | undefined> = process.env,
): VelvetOutcomeConfig {
  const apiKey = String(env.VELVET_ALCHEMY_OUTCOME_KEY || "").trim();
  const rawBaseUrl = String(env.VELVET_ALCHEMY_BASE_URL || "").trim();
  const rawWorkspaceId = String(env.VELVET_ALCHEMY_WORKSPACE_ID || "").trim();
  const missing: string[] = [];
  const reservedSecrets = Object.entries(env)
    .filter(([name]) => name !== "VELVET_ALCHEMY_OUTCOME_KEY" && SECRET_NAME.test(name))
    .map(([, value]) => String(value || "").trim())
    .filter(Boolean);
  if (apiKey.length < 32 || new Set(apiKey).size < 12 || SECRET_PLACEHOLDER.test(apiKey)) {
    missing.push("VELVET_ALCHEMY_OUTCOME_KEY");
  }
  if (apiKey && reservedSecrets.includes(apiKey)) {
    missing.push("VELVET_ALCHEMY_OUTCOME_KEY_SEPARATION");
  }
  if (!rawBaseUrl) missing.push("VELVET_ALCHEMY_BASE_URL");

  let baseUrl: string | null = null;
  if (rawBaseUrl) {
    try {
      const parsed = new URL(rawBaseUrl);
      const localHttp = parsed.protocol === "http:"
        && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
      if (parsed.protocol === "https:" || localHttp) baseUrl = parsed.toString().replace(/\/$/, "");
      else missing.push("VELVET_ALCHEMY_BASE_URL");
    } catch {
      missing.push("VELVET_ALCHEMY_BASE_URL");
    }
  }

  const workspaceId = Number(rawWorkspaceId);
  const validWorkspaceId = Number.isSafeInteger(workspaceId) && workspaceId > 0 ? workspaceId : null;
  if (!validWorkspaceId) missing.push("VELVET_ALCHEMY_WORKSPACE_ID");

  const uniqueMissing = [...new Set(missing)];
  return {
    apiKey,
    baseUrl,
    workspaceId: validWorkspaceId,
    missing: uniqueMissing,
    configured: uniqueMissing.length === 0 && Boolean(baseUrl) && Boolean(validWorkspaceId),
  };
}

export async function deliverVelvetOutcome(
  input: DeliverVelvetOutcomeInput,
  options: DeliverVelvetOutcomeOptions = {},
): Promise<{ delivered: boolean; reason?: string }> {
  const config = readVelvetOutcomeConfig(options.env);
  if (!config.configured || !config.baseUrl || !config.workspaceId) {
    return { delivered: false, reason: `Velvet outcome callback not configured: ${config.missing.join(", ")}` };
  }

  const leadId = parseVelvetLeadId(input.externalId);
  if (!leadId) return { delivered: false, reason: "Handoff externalId does not contain a valid Velvet lead ID" };
  const callId = String(input.callId || "").trim();
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(callId)) {
    return { delivered: false, reason: "A stable call ID is required for idempotent outcome delivery" };
  }

  const response = await (options.fetchImpl ?? fetch)(`${config.baseUrl}/api/v1/leads/${leadId}/outcome`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "X-SMIRK-Idempotency-Key": `velvet-outcome:${input.externalId}:${callId}`,
    },
    body: JSON.stringify({
      outcome: input.outcome,
      summary: String(input.summary || "").slice(0, 8_000),
      workspaceId: config.workspaceId,
      callDuration: Math.max(0, Number(input.callDuration || 0)),
      calledAt: input.calledAt ? new Date(input.calledAt).toISOString() : new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Velvet outcome callback returned HTTP ${response.status}: ${body}`);
  }

  return { delivered: true };
}
