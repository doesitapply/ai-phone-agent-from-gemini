import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const VELVET_HANDOFF_SOURCE = "velvet_alchemy";
export const VELVET_SYNTHETIC_HANDOFF_MODE =
  "synthetic-fixture-only-v1";
export const VELVET_SYNTHETIC_HANDOFF_EXTERNAL_ID_PREFIX =
  "velvet-manus-fake-";
export const VELVET_SYNTHETIC_HANDOFF_PHONE = "+12025550124";

const E164_PHONE = /^\+[1-9]\d{7,14}$/;
const EXTERNAL_ID = /^[A-Za-z0-9:_-]+$/;
const SYNTHETIC_LABEL = /\b(?:synthetic|test)\b/i;

export const velvetHandoffPayloadSchema = z.object({
  workspaceId: z.coerce.number().int().positive(),
  externalId: z.string().trim().min(12).max(160).regex(EXTERNAL_ID),
  caller: z.object({
    phone: z.string().trim().regex(E164_PHONE, "caller.phone must be an E.164 phone number."),
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(320).optional(),
  }).strict(),
  companyName: z.string().trim().min(1).max(240).optional(),
  reason: z.string().trim().min(4).max(500),
  urgency: z.enum(["low", "normal", "high", "emergency"]).default("normal"),
  transcriptSnippet: z.string().trim().min(1).max(4_000).optional(),
  recommendedAction: z.string().trim().min(1).max(1_000).optional(),
  notes: z.string().trim().min(1).max(2_000).optional(),
}).strict();

export type VelvetHandoffPayload = z.infer<typeof velvetHandoffPayloadSchema>;

export type VelvetHandoffConfig = {
  apiKey: string;
  mode: typeof VELVET_SYNTHETIC_HANDOFF_MODE | null;
  workspaceId: number | null;
  missing: string[];
  configured: boolean;
};

export function readVelvetHandoffConfig(env: Record<string, string | undefined> = process.env): VelvetHandoffConfig {
  const apiKey = String(env.VELVET_ALCHEMY_HANDOFF_API_KEY || "").trim();
  const rawMode = String(env.VELVET_ALCHEMY_HANDOFF_MODE || "").trim();
  const rawWorkspaceId = String(env.VELVET_ALCHEMY_WORKSPACE_ID || "").trim();
  const workspaceId = Number(rawWorkspaceId);
  const validWorkspaceId = Number.isSafeInteger(workspaceId) && workspaceId > 0 ? workspaceId : null;
  const mode =
    rawMode === VELVET_SYNTHETIC_HANDOFF_MODE
      ? VELVET_SYNTHETIC_HANDOFF_MODE
      : null;
  const separatedSecrets = [
    env.DASHBOARD_API_KEY,
    env.DEMO_OPERATOR_API_KEY,
    env.VELVET_ALCHEMY_RESEARCH_API_KEY,
  ]
    .map(value => String(value || "").trim())
    .filter(Boolean);
  const missing: string[] = [];
  if (apiKey.length < 32) {
    missing.push("VELVET_ALCHEMY_HANDOFF_API_KEY");
  }
  if (apiKey && separatedSecrets.includes(apiKey)) {
    missing.push("VELVET_ALCHEMY_HANDOFF_API_KEY_SEPARATION");
  }
  if (!mode) missing.push("VELVET_ALCHEMY_HANDOFF_MODE");
  if (!validWorkspaceId) missing.push("VELVET_ALCHEMY_WORKSPACE_ID");
  return {
    apiKey,
    mode,
    workspaceId: validWorkspaceId,
    missing,
    configured: missing.length === 0,
  };
}

function isReservedFixtureEmail(value: string): boolean {
  const domain = value.toLowerCase().split("@").at(-1) || "";
  return (
    ["example.com", "example.net", "example.org"].includes(domain) ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".test")
  );
}

export function validateSyntheticVelvetHandoffPayload(
  payload: VelvetHandoffPayload
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (
    !payload.externalId.startsWith(
      VELVET_SYNTHETIC_HANDOFF_EXTERNAL_ID_PREFIX
    ) ||
    payload.externalId.length <=
      VELVET_SYNTHETIC_HANDOFF_EXTERNAL_ID_PREFIX.length
  ) {
    violations.push("external_id_not_reserved_fixture");
  }
  if (payload.caller.phone !== VELVET_SYNTHETIC_HANDOFF_PHONE) {
    violations.push("caller_phone_not_reserved_fixture");
  }
  if (payload.urgency !== "low") {
    violations.push("fixture_urgency_must_be_low");
  }
  if (!SYNTHETIC_LABEL.test(payload.reason)) {
    violations.push("reason_not_marked_synthetic");
  }
  if (payload.caller.name && !SYNTHETIC_LABEL.test(payload.caller.name)) {
    violations.push("caller_name_not_marked_synthetic");
  }
  if (payload.companyName && !SYNTHETIC_LABEL.test(payload.companyName)) {
    violations.push("company_name_not_marked_synthetic");
  }
  if (
    payload.caller.email &&
    !isReservedFixtureEmail(payload.caller.email)
  ) {
    violations.push("caller_email_not_reserved_fixture");
  }
  for (const [field, value] of [
    ["transcript", payload.transcriptSnippet],
    ["recommended_action", payload.recommendedAction],
    ["notes", payload.notes],
  ] as const) {
    if (value && !SYNTHETIC_LABEL.test(value)) {
      violations.push(`${field}_not_marked_synthetic`);
    }
  }
  return { ok: violations.length === 0, violations };
}

export function readBearerToken(header: unknown): string {
  const authorization = String(header || "");
  return authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
}

export function constantTimeSecretEquals(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (!providedBytes.length || providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

export function buildVelvetHandoffPayloadHash(payload: VelvetHandoffPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildVelvetHandoffCallSid(workspaceId: number, externalId: string): string {
  const digest = createHash("sha256")
    .update(`${VELVET_HANDOFF_SOURCE}:${workspaceId}:${externalId}`)
    .digest("hex");
  return `velvet_${digest.slice(0, 40)}`;
}
