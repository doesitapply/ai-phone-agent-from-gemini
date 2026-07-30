import { createHash } from "node:crypto";
import { z } from "zod";
import { VELVET_LEAD_SOURCE_PRODUCTION_ORIGIN } from "./velvet-lead-source.js";

export const VELVET_DISCOVERY_REQUEST_CONTRACT =
  "smirk-velvet.discovery-request.v1" as const;
export const VELVET_DISCOVERY_PREPARED_CONTRACT =
  "velvet-smirk.discovery-response.v1" as const;
export const VELVET_DISCOVERY_STATUS_CONTRACT =
  "velvet-smirk.discovery-status.v1" as const;
export const VELVET_DISCOVERY_APPROVAL_CONFIRMATION =
  "approve-one-velvet-discovery-request-v1" as const;
export const VELVET_DISCOVERY_DISPATCH_CONFIRMATION =
  "dispatch-one-velvet-discovery-request-v1" as const;
export const VELVET_DISCOVERY_REFRESH_CONFIRMATION =
  "refresh-one-velvet-discovery-request-v1" as const;
export const VELVET_DISCOVERY_IMPORT_CONFIRMATION =
  "prepare-import-from-one-velvet-discovery-v1" as const;
export const VELVET_DISCOVERY_CANCEL_CONFIRMATION =
  "cancel-one-velvet-discovery-request-v1" as const;
export const VELVET_DISCOVERY_MAX_LEADS = 20;
export const VELVET_DISCOVERY_MAX_BUDGET_CENTS = 500;

const SAFE_EXTERNAL_ID = /^[A-Za-z0-9:_-]+$/;
const MINIMUM_SECRET_LENGTH = 32;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export const velvetDiscoveryCriteriaSchema = z
  .object({
    limit: z.number().int().min(1).max(VELVET_DISCOVERY_MAX_LEADS),
    category: z.string().trim().min(2).max(120).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    state: z.string().trim().min(2).max(80).optional(),
    learningMode: z.enum(["none", "latest_approved"]),
  })
  .strict()
  .superRefine((criteria, ctx) => {
    if (Boolean(criteria.city) !== Boolean(criteria.state)) {
      ctx.addIssue({
        code: "custom",
        message: "City and state must be supplied together.",
      });
    }
    if (
      criteria.learningMode === "latest_approved" &&
      Boolean(criteria.category) === Boolean(criteria.city && criteria.state)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Learned discovery requires exactly one complementary manual dimension: category or city/state.",
      });
    }
    if (
      criteria.learningMode === "none" &&
      (!criteria.category || !criteria.city || !criteria.state)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Manual discovery requires category, city, and state filters.",
      });
    }
  });

export const velvetDiscoveryRequestSchema = z
  .object({
    contractVersion: z.literal(VELVET_DISCOVERY_REQUEST_CONTRACT),
    requestId: z.string().min(20).max(160).regex(SAFE_EXTERNAL_ID),
    workspaceId: z.number().int().positive(),
    criteria: velvetDiscoveryCriteriaSchema,
    contactActionAllowed: z.literal(false),
    spendAuthorized: z.literal(false),
  })
  .strict();

export const velvetDiscoveryEffectiveCriteriaSchema = z
  .object({
    limit: z.number().int().min(1).max(VELVET_DISCOVERY_MAX_LEADS),
    category: z.string().trim().min(2).max(120),
    city: z.string().trim().min(1).max(120),
    state: z.string().trim().min(2).max(80),
  })
  .strict();

export const velvetDiscoveryQuoteSchema = z
  .object({
    provider: z.literal("google_maps_proxy"),
    maximumRequests: z
      .number()
      .int()
      .min(2)
      .max(VELVET_DISCOVERY_MAX_LEADS + 1),
    costCentsPerRequest: z.number().int().positive().max(10_000),
    maximumCostCents: z
      .number()
      .int()
      .positive()
      .max(VELVET_DISCOVERY_MAX_BUDGET_CENTS),
    quotedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const velvetDiscoveryStateSchema = z.enum([
  "PREPARED",
  "APPROVED",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "EMPTY",
  "PARTIAL",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
]);

const appliedLearningCandidateSchema = z
  .object({
    id: z.number().int().positive(),
    candidateKey: z.string().min(3).max(180),
    version: z.number().int().positive(),
    proposal: z
      .object({
        action: z.literal("prioritize_for_next_research_batch"),
        dimension: z.enum(["category", "metro"]),
        value: z.string().trim().min(2).max(160),
        maximumNextBatchSize: z
          .number()
          .int()
          .min(1)
          .max(VELVET_DISCOVERY_MAX_LEADS),
      })
      .strict(),
  })
  .strict();

export const velvetDiscoveryPreparedResponseSchema = z
  .object({
    ok: z.literal(true),
    contractVersion: z.literal(VELVET_DISCOVERY_PREPARED_CONTRACT),
    state: z.enum(["PREPARED", "DUPLICATE"]),
    originalState: z.literal("PREPARED"),
    currentState: velvetDiscoveryStateSchema,
    requestId: z.string().min(20).max(160).regex(SAFE_EXTERNAL_ID),
    requestPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    quotePayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    discoveryId: z.number().int().positive(),
    effectiveCriteria: velvetDiscoveryEffectiveCriteriaSchema,
    appliedLearningCandidate: appliedLearningCandidateSchema.nullable(),
    quote: velvetDiscoveryQuoteSchema,
    approvalRequired: z.boolean(),
    executionStarted: z.boolean(),
    contactActionAllowed: z.literal(false),
    spendAuthorized: z.literal(false),
    externalAction: z.enum(["discovery_approval_required", "none"]),
  })
  .strict();

export const velvetDiscoveryStatusResponseSchema = z
  .object({
    ok: z.literal(true),
    contractVersion: z.literal(VELVET_DISCOVERY_STATUS_CONTRACT),
    requestId: z.string().min(20).max(160).regex(SAFE_EXTERNAL_ID),
    requestPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    quotePayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    discoveryId: z.number().int().positive(),
    state: velvetDiscoveryStateSchema,
    effectiveCriteria: velvetDiscoveryEffectiveCriteriaSchema,
    appliedLearningCandidate: appliedLearningCandidateSchema.nullable(),
    quote: velvetDiscoveryQuoteSchema,
    createdLeadCount: z.number().int().nonnegative(),
    readyLeadCount: z.number().int().nonnegative(),
    skippedLeadCount: z.number().int().nonnegative(),
    failedLeadCount: z.number().int().nonnegative(),
    providerRequests: z
      .number()
      .int()
      .nonnegative()
      .max(VELVET_DISCOVERY_MAX_LEADS + 1),
    approvedMaxSpendCents: z.number().int().nonnegative().nullable(),
    error: z.string().max(2_000).nullable(),
    contactActionAllowed: z.literal(false),
    externalAction: z.literal("discovery_status_only"),
  })
  .strict();

export type VelvetDiscoveryCriteria = z.infer<
  typeof velvetDiscoveryCriteriaSchema
>;
export type VelvetDiscoveryRequest = z.infer<
  typeof velvetDiscoveryRequestSchema
>;
export type VelvetDiscoveryPreparedResponse = z.infer<
  typeof velvetDiscoveryPreparedResponseSchema
>;
export type VelvetDiscoveryStatusResponse = z.infer<
  typeof velvetDiscoveryStatusResponseSchema
>;

export type VelvetDiscoveryConfig = {
  enabled: boolean;
  configured: boolean;
  baseUrl: string;
  apiKey: string;
  workspaceId: number | null;
  missing: string[];
};

export type VelvetDiscoveryPreparedResult =
  | {
      success: true;
      httpStatus: 200 | 201;
      response: VelvetDiscoveryPreparedResponse;
      retryable: false;
    }
  | {
      success: false;
      httpStatus?: number;
      code: string;
      error: string;
      retryable: boolean;
    };

export type VelvetDiscoveryStatusResult =
  | {
      success: true;
      httpStatus: 200;
      response: VelvetDiscoveryStatusResponse;
      retryable: false;
    }
  | {
      success: false;
      httpStatus?: number;
      code: string;
      error: string;
      retryable: boolean;
    };

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export function hashVelvetDiscoveryValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildVelvetDiscoveryRequest(input: {
  requestId: string;
  workspaceId: number;
  criteria: VelvetDiscoveryCriteria;
}): VelvetDiscoveryRequest {
  return velvetDiscoveryRequestSchema.parse({
    contractVersion: VELVET_DISCOVERY_REQUEST_CONTRACT,
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    criteria: input.criteria,
    contactActionAllowed: false,
    spendAuthorized: false,
  });
}

export function readVelvetDiscoveryConfig(
  env: Record<string, string | undefined> = process.env
): VelvetDiscoveryConfig {
  const enabled =
    String(env.VELVET_DISCOVERY_ENABLED || "")
      .trim()
      .toLowerCase() === "true";
  const rawBaseUrl = String(
    env.VELVET_LEAD_SOURCE_BASE_URL || ""
  ).trim();
  const apiKey = String(env.VELVET_LEAD_SOURCE_API_KEY || "").trim();
  const nonDedicatedKeys = [
    String(env.VELVET_OUTCOME_API_KEY || "").trim(),
    String(env.DASHBOARD_API_KEY || "").trim(),
    String(env.DEMO_OPERATOR_API_KEY || "").trim(),
    String(env.VELVET_ALCHEMY_HANDOFF_API_KEY || "").trim(),
    String(env.VELVET_ALCHEMY_RESEARCH_API_KEY || "").trim(),
  ].filter(Boolean);
  const workspaceId = Number(
    String(env.VELVET_LEAD_SOURCE_WORKSPACE_ID || "").trim()
  );
  const validWorkspaceId =
    Number.isSafeInteger(workspaceId) && workspaceId > 0
      ? workspaceId
      : null;
  const missing: string[] = [];
  let baseUrl = "";

  try {
    const parsed = new URL(rawBaseUrl);
    if (
      parsed.origin !== VELVET_LEAD_SOURCE_PRODUCTION_ORIGIN ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("Unexpected Velvet origin.");
    }
    baseUrl = parsed.origin;
  } catch {
    missing.push("VELVET_LEAD_SOURCE_BASE_URL");
  }
  if (
    apiKey.length < MINIMUM_SECRET_LENGTH ||
    nonDedicatedKeys.includes(apiKey)
  ) {
    missing.push("VELVET_LEAD_SOURCE_API_KEY");
  }
  if (!validWorkspaceId) {
    missing.push("VELVET_LEAD_SOURCE_WORKSPACE_ID");
  }
  if (!enabled) {
    missing.push("VELVET_DISCOVERY_ENABLED");
  }

  return {
    enabled,
    configured: missing.length === 0,
    baseUrl,
    apiKey,
    workspaceId: validWorkspaceId,
    missing,
  };
}

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("Velvet discovery response exceeded the safe size limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(
        "Velvet discovery response exceeded the safe size limit."
      );
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function safeRemoteError(
  body: unknown,
  fallback: string,
  apiKey: string
): string {
  const message =
    body &&
    typeof body === "object" &&
    typeof (body as { error?: unknown }).error === "string"
      ? String((body as { error: string }).error)
      : fallback;
  return message.split(apiKey).join("[REDACTED]").slice(0, 2_000);
}

function validatePreparedResponse(input: {
  httpStatus: number;
  body: unknown;
  request: VelvetDiscoveryRequest;
}): VelvetDiscoveryPreparedResult {
  if (input.httpStatus !== 200 && input.httpStatus !== 201) {
    const body =
      input.body && typeof input.body === "object"
        ? (input.body as Record<string, unknown>)
        : {};
    const code =
      typeof body.code === "string"
        ? body.code
        : "VELVET_DISCOVERY_REMOTE_REJECTED";
    return {
      success: false,
      httpStatus: input.httpStatus,
      code,
      error:
        typeof body.error === "string"
          ? body.error
          : `Velvet rejected the discovery request (${input.httpStatus}).`,
      retryable: input.httpStatus >= 500,
    };
  }
  const parsed = velvetDiscoveryPreparedResponseSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      success: false,
      httpStatus: input.httpStatus,
      code: "VELVET_DISCOVERY_INVALID_RESPONSE",
      error: "Velvet returned an invalid discovery response.",
      retryable: false,
    };
  }
  if (
    parsed.data.requestId !== input.request.requestId ||
    parsed.data.requestPayloadHash !==
      hashVelvetDiscoveryValue(input.request) ||
    parsed.data.quotePayloadHash !==
      hashVelvetDiscoveryValue(parsed.data.quote) ||
    (input.httpStatus === 201 && parsed.data.state !== "PREPARED") ||
    (input.httpStatus === 200 && parsed.data.state !== "DUPLICATE")
  ) {
    return {
      success: false,
      httpStatus: input.httpStatus,
      code: "VELVET_DISCOVERY_RESPONSE_MISMATCH",
      error: "Velvet discovery proof does not match this request.",
      retryable: false,
    };
  }
  return {
    success: true,
    httpStatus: input.httpStatus,
    response: parsed.data,
    retryable: false,
  };
}

export function validateVelvetDiscoveryStatus(input: {
  body: unknown;
  request: VelvetDiscoveryRequest;
}): VelvetDiscoveryStatusResult {
  const parsed = velvetDiscoveryStatusResponseSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      success: false,
      httpStatus: 200,
      code: "VELVET_DISCOVERY_INVALID_STATUS",
      error: "Velvet returned an invalid discovery status.",
      retryable: false,
    };
  }
  if (
    parsed.data.requestId !== input.request.requestId ||
    parsed.data.requestPayloadHash !==
      hashVelvetDiscoveryValue(input.request) ||
    parsed.data.quotePayloadHash !==
      hashVelvetDiscoveryValue(parsed.data.quote)
  ) {
    return {
      success: false,
      httpStatus: 200,
      code: "VELVET_DISCOVERY_STATUS_MISMATCH",
      error: "Velvet discovery status proof does not match this request.",
      retryable: false,
    };
  }
  return {
    success: true,
    httpStatus: 200,
    response: parsed.data,
    retryable: false,
  };
}

export async function prepareVelvetDiscovery(
  request: VelvetDiscoveryRequest,
  config: VelvetDiscoveryConfig,
  fetchImpl: FetchLike = fetch
): Promise<VelvetDiscoveryPreparedResult> {
  if (!config.configured || !config.workspaceId) {
    return {
      success: false,
      code: "VELVET_DISCOVERY_NOT_CONFIGURED",
      error: `Velvet discovery is not configured: ${config.missing.join(", ")}`,
      retryable: false,
    };
  }
  if (request.workspaceId !== config.workspaceId) {
    return {
      success: false,
      code: "VELVET_DISCOVERY_WORKSPACE_MISMATCH",
      error: "The discovery request does not match the configured workspace.",
      retryable: false,
    };
  }
  const parsedRequest = velvetDiscoveryRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    return {
      success: false,
      code: "VELVET_DISCOVERY_INVALID_REQUEST",
      error: "The local Velvet discovery request is invalid.",
      retryable: false,
    };
  }

  try {
    const response = await fetchImpl(
      `${config.baseUrl}/api/v1/smirk/discovery-requests`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${config.apiKey}`,
          "Idempotency-Key": request.requestId,
        },
        body: JSON.stringify(parsedRequest.data),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      }
    );
    const responseText = await readBoundedResponse(response);
    let body: unknown = {};
    try {
      body = responseText ? JSON.parse(responseText) : {};
    } catch {
      return {
        success: false,
        httpStatus: response.status,
        code: "VELVET_DISCOVERY_NON_JSON_RESPONSE",
        error: "Velvet discovery response was not valid JSON.",
        retryable: false,
      };
    }
    const result = validatePreparedResponse({
      httpStatus: response.status,
      body,
      request: parsedRequest.data,
    });
    if (result.success === false) {
      return {
        ...result,
        error: safeRemoteError(body, result.error, config.apiKey),
      };
    }
    return result;
  } catch (error) {
    return {
      success: false,
      code: "VELVET_DISCOVERY_TRANSPORT_UNCERTAIN",
      error: safeRemoteError(
        {},
        error instanceof Error
          ? error.message
          : "Velvet discovery request failed.",
        config.apiKey
      ),
      retryable: true,
    };
  }
}

export async function getVelvetDiscoveryStatus(
  request: VelvetDiscoveryRequest,
  config: VelvetDiscoveryConfig,
  fetchImpl: FetchLike = fetch
): Promise<VelvetDiscoveryStatusResult> {
  if (!config.configured || !config.workspaceId) {
    return {
      success: false,
      code: "VELVET_DISCOVERY_NOT_CONFIGURED",
      error: `Velvet discovery is not configured: ${config.missing.join(", ")}`,
      retryable: false,
    };
  }
  if (request.workspaceId !== config.workspaceId) {
    return {
      success: false,
      code: "VELVET_DISCOVERY_WORKSPACE_MISMATCH",
      error: "The discovery status does not match the configured workspace.",
      retryable: false,
    };
  }

  try {
    const response = await fetchImpl(
      `${config.baseUrl}/api/v1/smirk/discovery-requests/${encodeURIComponent(
        request.requestId
      )}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      }
    );
    const responseText = await readBoundedResponse(response);
    let body: unknown = {};
    try {
      body = responseText ? JSON.parse(responseText) : {};
    } catch {
      return {
        success: false,
        httpStatus: response.status,
        code: "VELVET_DISCOVERY_NON_JSON_STATUS",
        error: "Velvet discovery status was not valid JSON.",
        retryable: false,
      };
    }
    if (response.status !== 200) {
      const record =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      return {
        success: false,
        httpStatus: response.status,
        code:
          typeof record.code === "string"
            ? record.code
            : "VELVET_DISCOVERY_STATUS_REJECTED",
        error: safeRemoteError(
          body,
          `Velvet rejected discovery status (${response.status}).`,
          config.apiKey
        ),
        retryable: response.status >= 500,
      };
    }
    return validateVelvetDiscoveryStatus({
      body,
      request,
    });
  } catch (error) {
    return {
      success: false,
      code: "VELVET_DISCOVERY_STATUS_TRANSPORT_UNCERTAIN",
      error: safeRemoteError(
        {},
        error instanceof Error
          ? error.message
          : "Velvet discovery status request failed.",
        config.apiKey
      ),
      retryable: true,
    };
  }
}
