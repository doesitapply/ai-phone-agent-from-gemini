import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  velvetDiscoveryCriteriaSchema,
  type VelvetDiscoveryCriteria,
} from "./velvet-discovery.js";

export const PROSPECT_REVENUE_LOOP_PREPARER_PATH =
  "/api/prospecting/velvet-discovery/requests/prepare-next" as const;
export const PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION =
  "prepare-one-no-contact-discovery-review-v1" as const;
export const PROSPECT_REVENUE_LOOP_PREPARER_CONTRACT_VERSION =
  "smirk.prospect-revenue-loop-preparer.v1" as const;

export type ProspectRevenueLoopPreparerConfig = {
  enabled: boolean;
  configured: boolean;
  apiKey: string;
  workspaceId: number | null;
  criteria: VelvetDiscoveryCriteria | null;
  missing: string[];
};

export const prospectRevenueLoopPreparerActionSchema = z
  .object({
    confirmation: z.literal(
      PROSPECT_REVENUE_LOOP_PREPARER_CONFIRMATION
    ),
  })
  .strict();

export const prospectRevenueLoopPreparerReceiptSchema = z
  .object({
    ok: z.literal(true),
    contractVersion: z.literal(
      PROSPECT_REVENUE_LOOP_PREPARER_CONTRACT_VERSION
    ),
    outcome: z.enum(["PREPARED", "DUPLICATE"]),
    id: z.number().int().positive(),
    requestId: z.string().min(20).max(160),
    state: z.literal("PREPARED"),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    criteriaHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime({ offset: true }),
    controls: z
      .object({
        reviewOnly: z.literal(true),
        humanApprovalRequired: z.literal(true),
        contactAuthorized: z.literal(false),
        executionAuthorized: z.literal(false),
        spendAuthorized: z.literal(false),
        providerRequestAuthorized: z.literal(false),
        policyMutationAuthorized: z.literal(false),
        automatedSendingAuthorized: z.literal(false),
        automatedDialingAuthorized: z.literal(false),
      })
      .strict(),
    externalAction: z.literal("none"),
  })
  .strict();

export type ProspectRevenueLoopPreparerReceipt = z.infer<
  typeof prospectRevenueLoopPreparerReceiptSchema
>;

function positiveInteger(
  raw: string | undefined,
  minimum: number,
  maximum: number
): number | null {
  if (!/^\d+$/.test(String(raw || ""))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function clean(value: string | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function secretEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function hashProspectRevenueLoopPreparerValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function readProspectRevenueLoopPreparerConfig(
  env: Record<string, string | undefined>
): ProspectRevenueLoopPreparerConfig {
  const enabled = clean(env.PROSPECT_REVENUE_LOOP_PREPARER_ENABLED).toLowerCase() ===
    "true";
  const apiKey = clean(env.PROSPECT_REVENUE_LOOP_PREPARER_API_KEY);
  const workspaceId = positiveInteger(
    env.PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID,
    1,
    2_147_483_647
  );
  const limit = positiveInteger(
    env.PROSPECT_REVENUE_LOOP_DISCOVERY_LIMIT,
    1,
    20
  );
  const category = clean(env.PROSPECT_REVENUE_LOOP_DISCOVERY_CATEGORY);
  const city = clean(env.PROSPECT_REVENUE_LOOP_DISCOVERY_CITY);
  const state = clean(env.PROSPECT_REVENUE_LOOP_DISCOVERY_STATE);
  const parsedCriteria = velvetDiscoveryCriteriaSchema.safeParse({
    limit,
    category,
    city,
    state,
    learningMode: "none",
  });
  const missing: string[] = [];
  if (!enabled) missing.push("PROSPECT_REVENUE_LOOP_PREPARER_ENABLED");
  if (apiKey.length < 32) {
    missing.push("PROSPECT_REVENUE_LOOP_PREPARER_API_KEY");
  }
  const nonDedicatedKeys = [
    env.DASHBOARD_API_KEY,
    env.DEMO_OPERATOR_API_KEY,
    env.PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY,
    env.VELVET_LEAD_SOURCE_API_KEY,
    env.VELVET_OUTCOME_API_KEY,
    env.VELVET_OUTCOME_SIGNING_SECRET,
    env.VELVET_ALCHEMY_HANDOFF_API_KEY,
    env.VELVET_ALCHEMY_RESEARCH_API_KEY,
    env.PROSPECT_EMAIL_RESEND_API_KEY,
    env.PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET,
    env.PROSPECT_QC_OPENROUTER_API_KEY,
    env.RESEND_API_KEY,
    env.OPENROUTER_API_KEY,
    env.STRIPE_SECRET_KEY,
    env.TWILIO_AUTH_TOKEN,
    env.WORKSPACE_SECRET_ENCRYPTION_KEY,
  ]
    .map(clean)
    .filter(Boolean);
  if (apiKey.length >= 32 && nonDedicatedKeys.includes(apiKey)) {
    missing.push(
      "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY_SEPARATION"
    );
  }
  if (workspaceId === null) {
    missing.push("PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID");
  }
  if (limit === null) {
    missing.push("PROSPECT_REVENUE_LOOP_DISCOVERY_LIMIT");
  }
  if (!category) {
    missing.push("PROSPECT_REVENUE_LOOP_DISCOVERY_CATEGORY");
  }
  if (!city) missing.push("PROSPECT_REVENUE_LOOP_DISCOVERY_CITY");
  if (!state) missing.push("PROSPECT_REVENUE_LOOP_DISCOVERY_STATE");
  if (!parsedCriteria.success && limit !== null && category && city && state) {
    missing.push("PROSPECT_REVENUE_LOOP_DISCOVERY_CRITERIA");
  }
  return {
    enabled,
    configured: missing.length === 0,
    apiKey,
    workspaceId,
    criteria: parsedCriteria.success ? parsedCriteria.data : null,
    missing: [...new Set(missing)].sort(),
  };
}

export function authenticateProspectRevenueLoopPreparer(input: {
  method: string;
  path: string;
  providedApiKey: string | undefined;
  env: Record<string, string | undefined>;
}): number | null {
  if (
    input.method.toUpperCase() !== "POST" ||
    input.path !== PROSPECT_REVENUE_LOOP_PREPARER_PATH
  ) {
    return null;
  }
  const config = readProspectRevenueLoopPreparerConfig(input.env);
  if (!config.configured || config.workspaceId === null) return null;
  const provided = clean(input.providedApiKey);
  if (!provided || !secretEquals(provided, config.apiKey)) return null;
  return config.workspaceId;
}

export function buildProspectRevenueLoopPreparerRequestId(input: {
  workspaceId: number;
  criteria: VelvetDiscoveryCriteria;
  requestedAt: Date;
}): string {
  if (!Number.isFinite(input.requestedAt.getTime())) {
    throw new Error("The revenue-loop preparer clock is unavailable.");
  }
  const day = input.requestedAt.toISOString().slice(0, 10).replace(/-/g, "");
  const digest = hashProspectRevenueLoopPreparerValue({
    contractVersion: PROSPECT_REVENUE_LOOP_PREPARER_CONTRACT_VERSION,
    workspaceId: input.workspaceId,
    criteria: velvetDiscoveryCriteriaSchema.parse(input.criteria),
    day,
  }).slice(0, 24);
  return `smirk-auto-discovery-${day}-${digest}`;
}

export function buildProspectRevenueLoopPreparerControls() {
  return {
    reviewOnly: true as const,
    humanApprovalRequired: true as const,
    contactAuthorized: false as const,
    executionAuthorized: false as const,
    spendAuthorized: false as const,
    providerRequestAuthorized: false as const,
    policyMutationAuthorized: false as const,
    automatedSendingAuthorized: false as const,
    automatedDialingAuthorized: false as const,
  };
}
