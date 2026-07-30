import { createHash } from "node:crypto";
import { z } from "zod";

export const VELVET_RESEARCH_SOURCE = "velvet_alchemy_research";

const MINIMUM_API_KEY_LENGTH = 32;
const E164_PHONE = /^\+[1-9]\d{7,14}$/;
const EXTERNAL_ID = /^[A-Za-z0-9:_-]+$/;

const evidenceSchema = z.object({
  url: z.string().trim().url().max(2_000),
  observation: z.string().trim().min(1).max(1_000),
}).strict();

export const velvetResearchPayloadSchema = z.object({
  workspaceId: z.coerce.number().int().positive(),
  externalId: z.string().trim().min(12).max(160).regex(EXTERNAL_ID),
  batch: z.object({
    externalId: z.string().trim().min(8).max(160).regex(EXTERNAL_ID),
    name: z.string().trim().min(2).max(160),
    targetIndustry: z.string().trim().min(2).max(120).optional(),
    targetLocation: z.string().trim().min(2).max(160).optional(),
  }).strict(),
  prospect: z.object({
    companyName: z.string().trim().min(2).max(240),
    phone: z.string().trim().regex(E164_PHONE, "prospect.phone must be an E.164 phone number.").optional(),
    email: z.string().trim().email().max(320).optional(),
    website: z.string().trim().url().max(2_000).optional(),
    industry: z.string().trim().min(2).max(120).optional(),
    address: z.string().trim().min(2).max(500).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    state: z.string().trim().min(2).max(80).optional(),
    contactName: z.string().trim().min(1).max(120).optional(),
    contactTitle: z.string().trim().min(1).max(120).optional(),
    score: z.number().int().min(0).max(100).optional(),
    evidence: z.array(evidenceSchema).max(10).default([]),
    notes: z.string().trim().min(1).max(2_000).optional(),
  }).strict().superRefine((prospect, ctx) => {
    if (!prospect.phone && !prospect.email && !prospect.website && prospect.evidence.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "A prospect must include a phone, email, website, or evidence URL.",
      });
    }
  }),
}).strict();

export type VelvetResearchPayload = z.infer<typeof velvetResearchPayloadSchema>;

export type VelvetResearchConfig = {
  apiKey: string;
  workspaceId: number | null;
  missing: string[];
  configured: boolean;
};

export function readVelvetResearchConfig(
  env: Record<string, string | undefined> = process.env,
): VelvetResearchConfig {
  const apiKey = String(env.VELVET_ALCHEMY_RESEARCH_API_KEY || "").trim();
  const rawWorkspaceId = String(env.VELVET_ALCHEMY_RESEARCH_WORKSPACE_ID || "").trim();
  const workspaceId = Number(rawWorkspaceId);
  const validWorkspaceId = Number.isSafeInteger(workspaceId) && workspaceId > 0 ? workspaceId : null;
  const missing: string[] = [];
  if (apiKey.length < MINIMUM_API_KEY_LENGTH) missing.push("VELVET_ALCHEMY_RESEARCH_API_KEY");
  if (!validWorkspaceId) missing.push("VELVET_ALCHEMY_RESEARCH_WORKSPACE_ID");
  return {
    apiKey,
    workspaceId: validWorkspaceId,
    missing,
    configured: missing.length === 0,
  };
}

export function buildVelvetResearchPayloadHash(payload: VelvetResearchPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
