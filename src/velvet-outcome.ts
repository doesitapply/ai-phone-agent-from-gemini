import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

export const VELVET_OUTCOME_CONTRACT_VERSION =
  "smirk-velvet.outcome.v1" as const;
export const VELVET_OUTCOME_DISPATCH_CONFIRMATION =
  "dispatch-one-velvet-outcome-v1" as const;
const VELVET_PRODUCTION_ORIGIN = "https://velvetalchemy.manus.space";
const MINIMUM_SECRET_LENGTH = 32;
const MAX_RESPONSE_BYTES = 32 * 1024;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

function redactVelvetSecrets(
  value: unknown,
  config: Pick<VelvetOutcomeDispatchConfig, "apiKey" | "signingSecret">
): string {
  let safe = String(value || "Velvet outcome request failed.");
  for (const secret of [config.apiKey, config.signingSecret]) {
    if (!secret) continue;
    safe = safe.replaceAll(secret, "[redacted]");
  }
  return safe.replace(/\s+/g, " ").trim().slice(0, 300);
}

export const velvetOutcomePayloadSchema = z
  .object({
    contractVersion: z.literal(VELVET_OUTCOME_CONTRACT_VERSION),
    workspaceId: z.number().int().positive(),
    externalProspectId: z
      .string()
      .min(12)
      .max(160)
      .regex(/^[A-Za-z0-9:_-]+$/),
    externalEventId: z
      .string()
      .min(12)
      .max(160)
      .regex(/^[A-Za-z0-9:_-]+$/),
    outreachApprovalId: z.string().uuid(),
    channel: z.enum(["email", "call"]),
    outcome: z.enum([
      "delivered",
      "bounced",
      "replied",
      "qualified",
      "demo_booked",
      "converted",
      "not_interested",
      "dnc",
      "call_connected",
      "voicemail",
      "no_answer",
      "failed",
    ]),
    occurredAt: z.string().datetime({ offset: true }),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    outreachPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    notes: z.string().trim().max(2_000).optional(),
  })
  .strict();

export type VelvetOutcomePayload = z.infer<
  typeof velvetOutcomePayloadSchema
>;

export function canonicalVelvetOutcomeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => canonicalVelvetOutcomeJson(item))
      .join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalVelvetOutcomeJson(object[key])}`
    )
    .join(",")}}`;
}

export function buildVelvetOutcomePayload(input: {
  workspaceId: number;
  externalProspectId: string;
  externalEventId: string;
  outreachApprovalId: string;
  channel: "email" | "call";
  outcome: VelvetOutcomePayload["outcome"];
  occurredAt: string;
  evidenceHash: string;
  outreachPayloadHash: string;
  notes?: string;
}): VelvetOutcomePayload {
  return velvetOutcomePayloadSchema.parse({
    contractVersion: VELVET_OUTCOME_CONTRACT_VERSION,
    ...input,
  });
}

export function hashVelvetOutcomePayload(
  payload: VelvetOutcomePayload
): string {
  return createHash("sha256")
    .update(canonicalVelvetOutcomeJson(payload))
    .digest("hex");
}

export function buildVelvetOutcomeIdempotencyKey(input: {
  outboxId: number;
  payloadHash: string;
}): string {
  if (
    !Number.isSafeInteger(input.outboxId) ||
    input.outboxId <= 0 ||
    !/^[a-f0-9]{64}$/.test(input.payloadHash)
  ) {
    throw new Error(
      "A valid outbox ID and payload hash are required for dispatch idempotency."
    );
  }
  return `smirk-velvet-outcome/${input.outboxId}/${input.payloadHash.slice(
    0,
    24
  )}`;
}

export function signVelvetOutcomePayload(
  payload: VelvetOutcomePayload,
  timestamp: string,
  secret: string
): string {
  if (secret.length < 32) {
    throw new Error("Velvet outcome signing requires a 32-character secret.");
  }
  return `sha256=${createHmac("sha256", secret)
    .update(`${timestamp}.${canonicalVelvetOutcomeJson(payload)}`)
    .digest("hex")}`;
}

export type VelvetOutcomeDispatchConfig = {
  baseUrl: string;
  apiKey: string;
  signingSecret: string;
  workspaceId: number | null;
  enabled: boolean;
  configured: boolean;
  missing: string[];
};

export function readVelvetOutcomeDispatchConfig(
  env: Record<string, string | undefined> = process.env
): VelvetOutcomeDispatchConfig {
  const rawBaseUrl = String(env.VELVET_BASE_URL || "").trim();
  const apiKey = String(env.VELVET_OUTCOME_API_KEY || "").trim();
  const signingSecret = String(
    env.VELVET_OUTCOME_SIGNING_SECRET || ""
  ).trim();
  const rawWorkspaceId = String(
    env.VELVET_OUTCOME_WORKSPACE_ID || ""
  ).trim();
  const parsedWorkspaceId = Number(rawWorkspaceId);
  const workspaceId =
    /^\d+$/.test(rawWorkspaceId) &&
    Number.isSafeInteger(parsedWorkspaceId) &&
    parsedWorkspaceId > 0
      ? parsedWorkspaceId
      : null;
  const enabled = env.VELVET_OUTCOME_DISPATCH_ENABLED === "true";
  const missing: string[] = [];
  let baseUrl = "";
  try {
    const url = new URL(rawBaseUrl);
    if (
      url.origin !== VELVET_PRODUCTION_ORIGIN ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Unexpected Velvet origin.");
    }
    baseUrl = url.origin;
  } catch {
    missing.push("VELVET_BASE_URL");
  }
  if (apiKey.length < MINIMUM_SECRET_LENGTH) {
    missing.push("VELVET_OUTCOME_API_KEY");
  }
  if (signingSecret.length < MINIMUM_SECRET_LENGTH) {
    missing.push("VELVET_OUTCOME_SIGNING_SECRET");
  }
  if (!workspaceId) missing.push("VELVET_OUTCOME_WORKSPACE_ID");
  return {
    baseUrl,
    apiKey,
    signingSecret,
    workspaceId,
    enabled,
    configured: missing.length === 0,
    missing,
  };
}

function velvetLeadId(externalProspectId: string): number {
  const match = externalProspectId.match(/-lead-(\d+)$/);
  const leadId = Number(match?.[1]);
  if (!Number.isSafeInteger(leadId) || leadId <= 0) {
    throw new Error("The Velvet external prospect ID has no valid lead ID.");
  }
  return leadId;
}

async function readBoundedVelvetResponse(
  response: Response
): Promise<string> {
  const contentLength = Number(
    response.headers.get("content-length") || 0
  );
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_RESPONSE_BYTES
  ) {
    throw new Error("VELVET_OUTCOME_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("VELVET_OUTCOME_RESPONSE_TOO_LARGE");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

export async function dispatchVelvetOutcome(
  payload: VelvetOutcomePayload,
  config: VelvetOutcomeDispatchConfig,
  fetchImpl: FetchLike = fetch,
  now = new Date()
): Promise<{
  success: boolean;
  state?: "RECORDED" | "DUPLICATE";
  eventId?: number;
  code?: string;
  error?: string;
  retryable?: boolean;
  outcomeUnknown?: boolean;
}> {
  if (!config.configured || !config.enabled) {
    return {
      success: false,
      code: config.enabled
        ? "VELVET_OUTCOME_NOT_CONFIGURED"
        : "VELVET_OUTCOME_DISPATCH_DISABLED",
      error: config.enabled
        ? `Velvet outcome dispatch is not configured: ${config.missing.join(", ")}`
        : "Velvet outcome dispatch is disabled.",
    };
  }
  const parsed = velvetOutcomePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      success: false,
      code: "VELVET_OUTCOME_INVALID_PAYLOAD",
      error: "Velvet outcome payload failed local validation.",
    };
  }
  if (parsed.data.workspaceId !== config.workspaceId) {
    return {
      success: false,
      code: "VELVET_OUTCOME_WORKSPACE_MISMATCH",
      error:
        "The outcome payload does not match the configured Velvet workspace.",
      retryable: false,
      outcomeUnknown: false,
    };
  }
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const signature = signVelvetOutcomePayload(
    parsed.data,
    timestamp,
    config.signingSecret
  );
  try {
    const response = await fetchImpl(
      `${config.baseUrl}/api/v1/leads/${velvetLeadId(parsed.data.externalProspectId)}/outcome`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${config.apiKey}`,
          "X-SMIRK-Timestamp": timestamp,
          "X-SMIRK-Signature": signature,
        },
        body: JSON.stringify(parsed.data),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      }
    );
    const rawBody = await readBoundedVelvetResponse(response);
    const body = (() => {
      try {
        const parsedBody = JSON.parse(rawBody);
        return parsedBody && typeof parsedBody === "object"
          ? parsedBody
          : {};
      } catch {
        return {};
      }
    })() as Record<string, any>;
    const state =
      response.status === 201 && body?.state === "RECORDED"
        ? "RECORDED"
        : response.status === 200 && body?.state === "DUPLICATE"
          ? "DUPLICATE"
          : null;
    if (
      state &&
      body?.success === true &&
      Number.isSafeInteger(Number(body.eventId)) &&
      Number(body.eventId) > 0 &&
      body?.externalAction === "none"
    ) {
      return {
        success: true,
        state,
        eventId: Number(body.eventId),
      };
    }
    const outcomeUnknown =
      response.ok ||
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;
    return {
      success: false,
      code:
        typeof body?.code === "string"
          ? body.code
          : "VELVET_OUTCOME_UNEXPECTED_RESPONSE",
      error:
        typeof body?.error === "string"
          ? redactVelvetSecrets(body.error, config)
          : `Unexpected Velvet outcome response (${response.status}).`,
      retryable: outcomeUnknown,
      outcomeUnknown,
    };
  } catch (error) {
    const tooLarge =
      error instanceof Error &&
      error.message === "VELVET_OUTCOME_RESPONSE_TOO_LARGE";
    return {
      success: false,
      code: tooLarge
        ? "VELVET_OUTCOME_RESPONSE_TOO_LARGE"
        : "VELVET_OUTCOME_REQUEST_FAILED",
      error: redactVelvetSecrets(
        tooLarge
          ? "Velvet outcome response exceeded the safe size limit."
          : error instanceof Error
            ? error.message
            : String(error),
        config
      ),
      retryable: true,
      outcomeUnknown: true,
    };
  }
}
