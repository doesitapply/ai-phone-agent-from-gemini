import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const VELVET_HANDOFF_SOURCE = "velvet_alchemy";

const E164_PHONE = /^\+[1-9]\d{7,14}$/;
const EXTERNAL_ID = /^[A-Za-z0-9:_-]+$/;

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
  workspaceId: number | null;
  missing: string[];
  configured: boolean;
};

export function readVelvetHandoffConfig(env: Record<string, string | undefined> = process.env): VelvetHandoffConfig {
  const apiKey = String(env.VELVET_ALCHEMY_HANDOFF_API_KEY || "").trim();
  const rawWorkspaceId = String(env.VELVET_ALCHEMY_WORKSPACE_ID || "").trim();
  const workspaceId = Number(rawWorkspaceId);
  const validWorkspaceId = Number.isSafeInteger(workspaceId) && workspaceId > 0 ? workspaceId : null;
  const missing: string[] = [];
  if (!apiKey) missing.push("VELVET_ALCHEMY_HANDOFF_API_KEY");
  if (!validWorkspaceId) missing.push("VELVET_ALCHEMY_WORKSPACE_ID");
  return {
    apiKey,
    workspaceId: validWorkspaceId,
    missing,
    configured: missing.length === 0,
  };
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
