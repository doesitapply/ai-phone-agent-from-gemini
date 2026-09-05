import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const VELVET_ACQUISITION_SOURCE = "velvet_alchemy";
export const VELVET_SYNTHETIC_ACQUISITION_MODE = "synthetic-fixture-only-v1";
export const VELVET_EVIDENCE_INBOX_MODE = "evidence-inbox-v1";
export const VELVET_SYNTHETIC_EXTERNAL_ID_PREFIX = "velvet-manus-fake-";
export const VELVET_SYNTHETIC_PHONE = "+12025550124";

const E164_PHONE = /^\+[1-9]\d{7,14}$/;
const EXTERNAL_ID = /^[A-Za-z0-9:_-]+$/;
const SYNTHETIC_LABEL = /\b(?:synthetic|test|fixture|dummy|sample)\b/i;
const REAL_FIXTURE_TEXT_MARKER = /\b(?:synthetic|fixture|dummy|fake)\b/i;
const FIXTURE_ID_MARKER = /(?:^|[-_:])(?:synthetic|test|fixture|fake|dummy|sample)(?:[-_:]|$)/i;
const SECRET_NAME = /(?:KEY|TOKEN|SECRET)$/i;
const SECRET_PLACEHOLDER = /(?:generate|change.?me|replace.?me|placeholder|example|your.?key|32.?plus.?character)/i;

export const velvetAcquisitionPayloadSchema = z.object({
  workspaceId: z.coerce.number().int().positive(),
  recordKind: z.enum(["real", "synthetic"]),
  sourceRecordId: z.string().trim().min(12).max(160).regex(EXTERNAL_ID),
  sourceEventId: z.string().trim().min(12).max(160).regex(EXTERNAL_ID),
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
  occurredAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type VelvetAcquisitionPayload = z.infer<typeof velvetAcquisitionPayloadSchema>;

export type VelvetAcquisitionConfig = {
  apiKey: string;
  mode: typeof VELVET_SYNTHETIC_ACQUISITION_MODE | typeof VELVET_EVIDENCE_INBOX_MODE | null;
  workspaceId: number | null;
  missing: string[];
  configured: boolean;
};

export function readVelvetAcquisitionConfig(
  env: Record<string, string | undefined> = process.env,
): VelvetAcquisitionConfig {
  const acquisitionApiKey = String(env.VELVET_ALCHEMY_ACQUISITION_API_KEY || "").trim();
  const legacyApiKey = String(env.VELVET_ALCHEMY_HANDOFF_API_KEY || "").trim();
  const apiKey = acquisitionApiKey || legacyApiKey;
  const rawMode = String(
    env.VELVET_ALCHEMY_ACQUISITION_MODE
      || env.VELVET_ALCHEMY_HANDOFF_MODE
      || "",
  ).trim();
  const workspaceId = Number(String(env.VELVET_ALCHEMY_WORKSPACE_ID || "").trim());
  const validWorkspaceId = Number.isSafeInteger(workspaceId) && workspaceId > 0 ? workspaceId : null;
  const mode = rawMode === VELVET_SYNTHETIC_ACQUISITION_MODE
    ? VELVET_SYNTHETIC_ACQUISITION_MODE
    : rawMode === VELVET_EVIDENCE_INBOX_MODE
      ? VELVET_EVIDENCE_INBOX_MODE
      : null;
  const reservedSecrets = Object.entries(env)
    .filter(([name]) => name !== "VELVET_ALCHEMY_ACQUISITION_API_KEY"
      && name !== "VELVET_ALCHEMY_HANDOFF_API_KEY"
      && SECRET_NAME.test(name))
    .map(([, value]) => String(value || "").trim())
    .filter(Boolean);
  const missing: string[] = [];
  const distinctCharacters = new Set(apiKey).size;
  if (apiKey.length < 32 || distinctCharacters < 12 || SECRET_PLACEHOLDER.test(apiKey)) {
    missing.push("VELVET_ALCHEMY_ACQUISITION_API_KEY");
  }
  if (acquisitionApiKey && legacyApiKey && acquisitionApiKey !== legacyApiKey) {
    missing.push("VELVET_ALCHEMY_ACQUISITION_API_KEY_CONFLICT");
  }
  if (apiKey && reservedSecrets.includes(apiKey)) {
    missing.push("VELVET_ALCHEMY_ACQUISITION_API_KEY_SEPARATION");
  }
  if (!mode) missing.push("VELVET_ALCHEMY_ACQUISITION_MODE");
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
  return ["example.com", "example.net", "example.org"].includes(domain)
    || domain.endsWith(".invalid")
    || domain.endsWith(".test");
}

export function validateSyntheticVelvetAcquisition(
  payload: VelvetAcquisitionPayload,
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (payload.recordKind !== "synthetic") violations.push("record_kind_not_synthetic");
  if (!payload.sourceRecordId.startsWith(VELVET_SYNTHETIC_EXTERNAL_ID_PREFIX)
    || payload.sourceRecordId.length <= VELVET_SYNTHETIC_EXTERNAL_ID_PREFIX.length) {
    violations.push("source_record_id_not_reserved_fixture");
  }
  if (!payload.sourceEventId.startsWith(VELVET_SYNTHETIC_EXTERNAL_ID_PREFIX)
    || payload.sourceEventId.length <= VELVET_SYNTHETIC_EXTERNAL_ID_PREFIX.length) {
    violations.push("source_event_id_not_reserved_fixture");
  }
  if (payload.caller.phone !== VELVET_SYNTHETIC_PHONE) {
    violations.push("caller_phone_not_reserved_fixture");
  }
  if (payload.urgency !== "low") violations.push("fixture_urgency_must_be_low");
  if (!SYNTHETIC_LABEL.test(payload.reason)) violations.push("reason_not_marked_synthetic");
  if (payload.caller.name && !SYNTHETIC_LABEL.test(payload.caller.name)) {
    violations.push("caller_name_not_marked_synthetic");
  }
  if (payload.companyName && !SYNTHETIC_LABEL.test(payload.companyName)) {
    violations.push("company_name_not_marked_synthetic");
  }
  if (payload.caller.email && !isReservedFixtureEmail(payload.caller.email)) {
    violations.push("caller_email_not_reserved_fixture");
  }
  for (const [field, value] of [
    ["transcript", payload.transcriptSnippet],
    ["recommended_action", payload.recommendedAction],
    ["notes", payload.notes],
  ] as const) {
    if (value && !SYNTHETIC_LABEL.test(value)) violations.push(`${field}_not_marked_synthetic`);
  }
  return { ok: violations.length === 0, violations };
}

export function validateRealVelvetAcquisition(
  payload: VelvetAcquisitionPayload,
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (payload.recordKind !== "real") violations.push("record_kind_not_real");
  if (payload.sourceRecordId.startsWith(VELVET_SYNTHETIC_EXTERNAL_ID_PREFIX)) {
    violations.push("source_record_id_reserved_for_fixture");
  }
  if (payload.sourceEventId.startsWith(VELVET_SYNTHETIC_EXTERNAL_ID_PREFIX)) {
    violations.push("source_event_id_reserved_for_fixture");
  }
  if (payload.caller.phone === VELVET_SYNTHETIC_PHONE) {
    violations.push("caller_phone_reserved_for_fixture");
  }
  if (FIXTURE_ID_MARKER.test(payload.sourceRecordId)) {
    violations.push("source_record_id_looks_like_fixture");
  }
  if (FIXTURE_ID_MARKER.test(payload.sourceEventId)) {
    violations.push("source_event_id_looks_like_fixture");
  }
  if (payload.caller.email && isReservedFixtureEmail(payload.caller.email)) {
    violations.push("caller_email_looks_like_fixture");
  }
  for (const [field, value] of [
    ["caller_name", payload.caller.name],
    ["company_name", payload.companyName],
    ["reason", payload.reason],
    ["transcript", payload.transcriptSnippet],
    ["recommended_action", payload.recommendedAction],
    ["notes", payload.notes],
  ] as const) {
    if (value && REAL_FIXTURE_TEXT_MARKER.test(value)) violations.push(`${field}_looks_like_fixture`);
  }
  return { ok: violations.length === 0, violations };
}

export function validateVelvetAcquisitionEvidence(
  payload: VelvetAcquisitionPayload,
): { ok: boolean; violations: string[] } {
  return payload.recordKind === "synthetic"
    ? validateSyntheticVelvetAcquisition(payload)
    : validateRealVelvetAcquisition(payload);
}

export function readBearerToken(header: unknown): string {
  const authorization = String(header || "");
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
}

export function constantTimeSecretEquals(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (!providedBytes.length || providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

export function buildVelvetAcquisitionPayloadHash(payload: VelvetAcquisitionPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildVelvetAcquisitionId(workspaceId: number, sourceRecordId: string): string {
  const digest = createHash("sha256")
    .update(`${VELVET_ACQUISITION_SOURCE}:${workspaceId}:${sourceRecordId}`)
    .digest("hex");
  return `acq_${digest.slice(0, 40)}`;
}

export function buildVelvetAcquisitionReceiptId(workspaceId: number, sourceEventId: string): string {
  const digest = createHash("sha256")
    .update(`${VELVET_ACQUISITION_SOURCE}:${workspaceId}:event:${sourceEventId}`)
    .digest("hex");
  return `ace_${digest.slice(0, 40)}`;
}

export function buildInitialAcquisitionReviewId(
  acquisitionId: string,
  recordKind: VelvetAcquisitionPayload["recordKind"],
): string {
  const digest = createHash("sha256")
    .update(`${acquisitionId}:${recordKind}:initial-safety-review-v1`)
    .digest("hex");
  return `acr_${digest.slice(0, 40)}`;
}
