import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PROSPECT_QC_MODEL_SYSTEM_PROMPT,
  PROSPECT_QC_RULE_VERSION,
  buildProspectQcModelReview,
  prospectQcModelReviewSchema,
  type ProspectQcModelReview,
} from "./prospect-qc.js";

export const PROSPECT_QC_MODEL_REVIEW_MODE =
  "single-draft-advisory-v1" as const;
export const PROSPECT_QC_MODEL_REVIEW_CONFIRMATION =
  "review-one-prospect-draft-with-advisory-model-v1" as const;
export const PROSPECT_QC_MODEL_PROVIDER_CONTRACT =
  "smirk.prospect-qc-model-provider.v1" as const;
export const PROSPECT_QC_MODEL_REVIEW_RECEIPT_CONTRACT =
  "smirk.prospect-qc-model-review-receipt.v1" as const;

const OPENROUTER_ENDPOINT =
  "https://openrouter.ai/api/v1/chat/completions";
const MAX_RESPONSE_BYTES = 32 * 1024;
const ALLOWED_MODELS = new Set([
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
]);

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type ProspectQcModelProviderConfig = {
  enabled: boolean;
  requiredForApproval: boolean;
  configured: boolean;
  missing: string[];
  mode: typeof PROSPECT_QC_MODEL_REVIEW_MODE | null;
  apiKey: string;
  model: string;
  workspaceId: number | null;
  dailyReviewCap: number | null;
  dailySpendCapCents: number | null;
  reservedCostCents: number | null;
  timeoutMs: number | null;
};

export type ProspectQcModelProviderInput = {
  workspaceId: number;
  approvalId: string;
  payloadHash: string;
  draftHash: string;
  evidenceHash: string;
  channel: "email" | "call";
  variantKey: string;
  subject?: string;
  content: string;
  prospect: {
    businessName: string;
    industry: string;
    contactName: string;
    city: string;
    state: string;
    website: string | null;
    evidence: Array<{
      kind: string;
      basis: string;
      observation: string;
      url: string | null;
    }>;
  };
};

export type ProspectQcModelProviderResult =
  | {
      status: "accepted";
      provider: "openrouter";
      model: string;
      review: ProspectQcModelReview;
      responseHash: string;
      providerRequestId: string | null;
      providerReportedCostUsd: number | null;
      totalTokens: number | null;
    }
  | {
      status:
        | "blocked"
        | "definitive_failure"
        | "outcome_unknown";
      provider: "openrouter";
      code: string;
      error: string;
      retryable: false;
      httpStatus?: number;
    };

export const prospectQcModelReviewActionSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(
      PROSPECT_QC_MODEL_REVIEW_CONFIRMATION
    ),
  })
  .strict();

export const prospectQcModelReviewReceiptSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_QC_MODEL_REVIEW_RECEIPT_CONTRACT
    ),
    reviewId: z.string().uuid(),
    workspaceId: z.number().int().positive(),
    approvalId: z.string().uuid(),
    outreachJobId: z.number().int().positive(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    draftHash: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    provider: z.literal("openrouter"),
    model: z.enum([
      "google/gemini-2.5-flash",
      "google/gemini-2.5-flash-lite",
    ]),
    review: prospectQcModelReviewSchema,
    reservedCostCents: z.number().int().min(1).max(10),
    providerReportedCostUsd: z.number().nonnegative().max(100).nullable(),
    totalTokens: z.number().int().nonnegative().max(1_000_000).nullable(),
    providerRequestId: z.string().trim().min(1).max(200).nullable(),
    responseHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedAt: z.string().datetime({ offset: true }),
    humanApprovalRequired: z.literal(true),
    contactAuthorized: z.literal(false),
    executionAuthorized: z.literal(false),
    automatedSendingAuthorized: z.literal(false),
    automatedDialingAuthorized: z.literal(false),
  })
  .strict();

export type ProspectQcModelReviewReceipt = z.infer<
  typeof prospectQcModelReviewReceiptSchema
>;

export function hashProspectQcModelReviewReceipt(
  receipt: ProspectQcModelReviewReceipt
): string {
  return sha256(
    JSON.stringify(
      prospectQcModelReviewReceiptSchema.parse(receipt)
    )
  );
}

export function buildProspectQcModelReviewReceipt(input: {
  reviewId: string;
  workspaceId: number;
  approvalId: string;
  outreachJobId: number;
  requestHash: string;
  payloadHash: string;
  draftHash: string;
  evidenceHash: string;
  result: Extract<
    ProspectQcModelProviderResult,
    { status: "accepted" }
  >;
  reservedCostCents: number;
  reviewedAt: string;
}): {
  receipt: ProspectQcModelReviewReceipt;
  receiptHash: string;
} {
  const receipt = prospectQcModelReviewReceiptSchema.parse({
    contractVersion:
      PROSPECT_QC_MODEL_REVIEW_RECEIPT_CONTRACT,
    reviewId: input.reviewId,
    workspaceId: input.workspaceId,
    approvalId: input.approvalId,
    outreachJobId: input.outreachJobId,
    requestHash: input.requestHash,
    payloadHash: input.payloadHash,
    draftHash: input.draftHash,
    evidenceHash: input.evidenceHash,
    provider: input.result.provider,
    model: input.result.model,
    review: input.result.review,
    reservedCostCents: input.reservedCostCents,
    providerReportedCostUsd:
      input.result.providerReportedCostUsd,
    totalTokens: input.result.totalTokens,
    providerRequestId: input.result.providerRequestId,
    responseHash: input.result.responseHash,
    reviewedAt: new Date(input.reviewedAt).toISOString(),
    humanApprovalRequired: true,
    contactAuthorized: false,
    executionAuthorized: false,
    automatedSendingAuthorized: false,
    automatedDialingAuthorized: false,
  });
  return {
    receipt,
    receiptHash: hashProspectQcModelReviewReceipt(receipt),
  };
}

const providerResponseSchema = z
  .object({
    id: z.string().trim().min(1).max(200).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.string().trim().min(2).max(16_000),
              })
              .passthrough(),
          })
          .passthrough()
      )
      .min(1)
      .max(4),
    usage: z
      .object({
        cost: z.number().nonnegative().max(100).optional(),
        total_tokens: z
          .number()
          .int()
          .nonnegative()
          .max(1_000_000)
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function positiveInteger(
  raw: string | undefined,
  minimum: number,
  maximum: number
): number | null {
  if (!/^\d+$/.test(String(raw || ""))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function cleanText(
  value: unknown,
  maximumLength: number
): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function readProspectQcModelProviderConfig(
  env: Record<string, string | undefined> = process.env
): ProspectQcModelProviderConfig {
  const enabled =
    env.PROSPECT_QC_MODEL_REVIEW_ENABLED === "true";
  const requiredForApproval =
    env.PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL ===
    "true";
  const mode =
    env.PROSPECT_QC_MODEL_REVIEW_MODE ===
    PROSPECT_QC_MODEL_REVIEW_MODE
      ? PROSPECT_QC_MODEL_REVIEW_MODE
      : null;
  const apiKey = String(
    env.PROSPECT_QC_OPENROUTER_API_KEY || ""
  ).trim();
  const model = String(
    env.PROSPECT_QC_OPENROUTER_MODEL ||
      "google/gemini-2.5-flash"
  ).trim();
  const workspaceId = positiveInteger(
    env.PROSPECT_QC_MODEL_WORKSPACE_ID,
    1,
    Number.MAX_SAFE_INTEGER
  );
  const dailyReviewCap = positiveInteger(
    env.PROSPECT_QC_MODEL_DAILY_REVIEW_CAP,
    1,
    20
  );
  const dailySpendCapCents = positiveInteger(
    env.PROSPECT_QC_MODEL_DAILY_SPEND_CAP_CENTS,
    1,
    100
  );
  const reservedCostCents = positiveInteger(
    env.PROSPECT_QC_MODEL_RESERVED_COST_CENTS,
    1,
    10
  );
  const timeoutMs = positiveInteger(
    env.PROSPECT_QC_MODEL_TIMEOUT_MS || "10000",
    1_000,
    20_000
  );
  const missing = [
    ...(mode ? [] : ["PROSPECT_QC_MODEL_REVIEW_MODE"]),
    ...(/^sk-or-[A-Za-z0-9_-]{16,}$/.test(apiKey)
      ? []
      : ["PROSPECT_QC_OPENROUTER_API_KEY"]),
    ...(apiKey &&
    apiKey !== String(env.OPENROUTER_API_KEY || "").trim()
      ? []
      : ["PROSPECT_QC_OPENROUTER_API_KEY_SEPARATION"]),
    ...(ALLOWED_MODELS.has(model)
      ? []
      : ["PROSPECT_QC_OPENROUTER_MODEL"]),
    ...(workspaceId ? [] : ["PROSPECT_QC_MODEL_WORKSPACE_ID"]),
    ...(dailyReviewCap
      ? []
      : ["PROSPECT_QC_MODEL_DAILY_REVIEW_CAP"]),
    ...(dailySpendCapCents
      ? []
      : ["PROSPECT_QC_MODEL_DAILY_SPEND_CAP_CENTS"]),
    ...(reservedCostCents
      ? []
      : ["PROSPECT_QC_MODEL_RESERVED_COST_CENTS"]),
    ...(dailySpendCapCents &&
    reservedCostCents &&
    dailySpendCapCents >= reservedCostCents
      ? []
      : ["PROSPECT_QC_MODEL_DAILY_SPEND_CAP_CENTS"]),
    ...(timeoutMs ? [] : ["PROSPECT_QC_MODEL_TIMEOUT_MS"]),
  ];
  return {
    enabled,
    requiredForApproval,
    configured: missing.length === 0,
    missing: [...new Set(missing)].sort(),
    mode,
    apiKey,
    model,
    workspaceId,
    dailyReviewCap,
    dailySpendCapCents,
    reservedCostCents,
    timeoutMs,
  };
}

export function publicProspectQcModelProviderConfig(
  config: ProspectQcModelProviderConfig,
  workspaceId: number
) {
  return {
    contractVersion: PROSPECT_QC_MODEL_PROVIDER_CONTRACT,
    enabled: config.enabled,
    configured: config.configured,
    requiredForApproval: config.requiredForApproval,
    availableForWorkspace:
      config.enabled &&
      config.configured &&
      config.workspaceId === workspaceId,
    model: ALLOWED_MODELS.has(config.model)
      ? config.model
      : null,
    dailyReviewCap: config.dailyReviewCap,
    dailySpendCapCents: config.dailySpendCapCents,
    reservedCostCents: config.reservedCostCents,
    missing: config.missing,
    contactAuthorized: false,
    executionAuthorized: false,
    externalAction: "none" as const,
  };
}

export function hashProspectQcModelRequest(
  input: ProspectQcModelProviderInput,
  config: ProspectQcModelProviderConfig
): string {
  return sha256(
    JSON.stringify({
      contractVersion: PROSPECT_QC_MODEL_PROVIDER_CONTRACT,
      ruleVersion: PROSPECT_QC_RULE_VERSION,
      workspaceId: input.workspaceId,
      approvalId: input.approvalId,
      payloadHash: input.payloadHash,
      draftHash: input.draftHash,
      evidenceHash: input.evidenceHash,
      provider: "openrouter",
      model: config.model,
    })
  );
}

function buildReviewPrompt(
  input: ProspectQcModelProviderInput
): string {
  return JSON.stringify({
    prospect: {
      business_name: cleanText(
        input.prospect.businessName,
        160
      ),
      industry: cleanText(input.prospect.industry, 80),
      contact_name: cleanText(
        input.prospect.contactName,
        160
      ),
      city: cleanText(input.prospect.city, 120),
      state: cleanText(input.prospect.state, 80),
      website: input.prospect.website
        ? cleanText(input.prospect.website, 500)
        : null,
      evidence: input.prospect.evidence
        .slice(0, 20)
        .map(item => ({
          kind: cleanText(item.kind, 80),
          basis: cleanText(item.basis, 40),
          observation: cleanText(item.observation, 500),
          url: item.url
            ? cleanText(item.url, 500)
            : null,
        })),
    },
    draft: {
      channel: input.channel,
      variant_key: input.variantKey,
      subject: input.subject || null,
      content: input.content,
    },
    checklist: [
      "Every factual claim must be supported by prospect.evidence.",
      "No unresolved placeholders or deceptive customer impersonation.",
      "No spam-heavy, aggressive, or unsupported revenue language.",
      "The call to action must be concise and low pressure.",
    ],
  });
}

function safeError(raw: unknown): string {
  return String(raw || "Advisory QC provider request failed.")
    .replace(/sk-or-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

async function readBoundedResponse(
  response: Response
): Promise<string> {
  const contentLength = Number(
    response.headers.get("content-length") || 0
  );
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      "Advisory QC provider response exceeded the safe size limit."
    );
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
      throw new Error(
        "Advisory QC provider response exceeded the safe size limit."
      );
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function definitiveHttpFailure(status: number): boolean {
  return [400, 401, 403, 404, 405, 413, 415, 422].includes(
    status
  );
}

export async function requestProspectQcModelReview(input: {
  config: ProspectQcModelProviderConfig;
  payload: ProspectQcModelProviderInput;
  fetchImpl?: FetchLike;
}): Promise<ProspectQcModelProviderResult> {
  const { config, payload } = input;
  if (!config.enabled) {
    return {
      status: "blocked",
      provider: "openrouter",
      code: "PROSPECT_QC_MODEL_DISABLED",
      error: "Advisory model review is disabled.",
      retryable: false,
    };
  }
  if (
    !config.configured ||
    !config.workspaceId ||
    !config.timeoutMs ||
    config.workspaceId !== payload.workspaceId
  ) {
    return {
      status: "blocked",
      provider: "openrouter",
      code: "PROSPECT_QC_MODEL_NOT_CONFIGURED",
      error:
        "Advisory model review is not configured for this workspace.",
      retryable: false,
    };
  }

  const requestBody = {
    model: config.model,
    messages: [
      {
        role: "system",
        content: PROSPECT_QC_MODEL_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildReviewPrompt(payload),
      },
    ],
    temperature: 0,
    max_tokens: 300,
    provider: {
      require_parameters: true,
    },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "smirk_prospect_qc_review",
        strict: true,
        schema: {
          type: "object",
          properties: {
            pass: { type: "boolean" },
            confidence_score: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
            failure_reasons: {
              type: "array",
              items: {
                type: "string",
                minLength: 1,
                maxLength: 500,
              },
              maxItems: 20,
            },
          },
          required: [
            "pass",
            "confidence_score",
            "failure_reasons",
          ],
          additionalProperties: false,
        },
      },
    },
  };
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs
  );
  const startedAt = Date.now();
  try {
    const response = await (input.fetchImpl || fetch)(
      OPENROUTER_ENDPOINT,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "http-referer": "https://smirkcalls.com",
          "x-title": "SMIRK Prospect QC",
        },
        body: JSON.stringify(requestBody),
        redirect: "manual",
        signal: controller.signal,
      }
    );
    const raw = await readBoundedResponse(response);
    if (response.status !== 200) {
      return {
        status: definitiveHttpFailure(response.status)
          ? "definitive_failure"
          : "outcome_unknown",
        provider: "openrouter",
        code: definitiveHttpFailure(response.status)
          ? "PROSPECT_QC_MODEL_PROVIDER_REJECTED"
          : "PROSPECT_QC_MODEL_PROVIDER_UNCERTAIN",
        error: safeError(
          `OpenRouter returned HTTP ${response.status}.`
        ),
        retryable: false,
        httpStatus: response.status,
      };
    }
    const parsed = providerResponseSchema.safeParse(
      raw ? JSON.parse(raw) : {}
    );
    if (!parsed.success) {
      return {
        status: "outcome_unknown",
        provider: "openrouter",
        code: "PROSPECT_QC_MODEL_RESPONSE_INVALID",
        error:
          "Advisory QC provider returned an invalid response.",
        retryable: false,
        httpStatus: response.status,
      };
    }
    let rawModelOutput: unknown;
    try {
      rawModelOutput = JSON.parse(
        parsed.data.choices[0].message.content
      );
    } catch {
      rawModelOutput = null;
    }
    return {
      status: "accepted",
      provider: "openrouter",
      model: config.model,
      review: buildProspectQcModelReview({
        rawOutput: rawModelOutput,
        provider: "openrouter",
        model: config.model,
        latencyMs: Date.now() - startedAt,
        estimatedCostCents: config.reservedCostCents || 0,
      }),
      responseHash: sha256(raw),
      providerRequestId: parsed.data.id || null,
      providerReportedCostUsd:
        parsed.data.usage?.cost ?? null,
      totalTokens:
        parsed.data.usage?.total_tokens ?? null,
    };
  } catch (error) {
    return {
      status: "outcome_unknown",
      provider: "openrouter",
      code: "PROSPECT_QC_MODEL_PROVIDER_UNCERTAIN",
      error: safeError(
        error instanceof Error ? error.message : error
      ),
      retryable: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}
