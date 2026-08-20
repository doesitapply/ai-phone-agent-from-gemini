import { createHash } from "node:crypto";
import { z } from "zod";
import { velvetResearchPayloadSchema } from "./velvet-research.js";
import {
  assignmentMatchesVelvetSourceBinding,
  velvetAcquisitionSourcingAssignmentBindingSchema,
  velvetAcquisitionSourcingAssignmentSchema,
  type VelvetAcquisitionSourcingAssignmentBinding,
} from "./velvet-acquisition-experiment.js";

export const VELVET_LEAD_SOURCE_REQUEST_CONTRACT =
  "smirk-velvet.lead-batch-request.v1" as const;
export const VELVET_LEAD_SOURCE_RESPONSE_CONTRACT =
  "velvet-smirk.lead-batch-response.v1" as const;
export const VELVET_LEAD_SOURCE_APPROVAL_CONFIRMATION =
  "approve-one-velvet-source-request-v1" as const;
export const VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION =
  "dispatch-one-velvet-source-request-v1" as const;
export const VELVET_LEAD_SOURCE_CANCEL_CONFIRMATION =
  "cancel-one-velvet-source-request-v1" as const;
export const VELVET_LEAD_SOURCE_PRODUCTION_ORIGIN =
  "https://velvetalchemy.manus.space" as const;
export const VELVET_LEAD_SOURCE_MAX_BATCH_SIZE = 20;

const SAFE_EXTERNAL_ID = /^[A-Za-z0-9:_-]+$/;
const MINIMUM_SECRET_LENGTH = 32;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export const velvetLeadSourceCriteriaSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(VELVET_LEAD_SOURCE_MAX_BATCH_SIZE),
    category: z.string().trim().min(2).max(120).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    state: z.string().trim().min(2).max(80).optional(),
    learningMode: z.enum([
      "none",
      "latest_released",
      "latest_approved",
    ]),
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
      criteria.learningMode !== "none" &&
      (criteria.category || criteria.city || criteria.state)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "A learned segment and manual segment filters cannot be combined.",
      });
    }
  });

export const velvetLeadSourceRequestSchema = z
  .object({
    contractVersion: z.literal(VELVET_LEAD_SOURCE_REQUEST_CONTRACT),
    requestId: z.string().min(20).max(160).regex(SAFE_EXTERNAL_ID),
    workspaceId: z.number().int().positive(),
    sourceDiscoveryRequestId: z
      .string()
      .min(20)
      .max(160)
      .regex(SAFE_EXTERNAL_ID)
      .optional(),
    sourceAcquisitionExperimentAssignment:
      velvetAcquisitionSourcingAssignmentBindingSchema.optional(),
    criteria: velvetLeadSourceCriteriaSchema,
    contactActionAllowed: z.literal(false),
    maxSpendCents: z.literal(0),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      request.sourceDiscoveryRequestId &&
      (request.criteria.learningMode !== "none" ||
        !request.criteria.category ||
        !request.criteria.city ||
        !request.criteria.state)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "A discovery-bound pull requires the exact manual category, city, and state returned by that discovery.",
      });
    }
    if (
      request.sourceAcquisitionExperimentAssignment &&
      request.sourceAcquisitionExperimentAssignment.sourceDiscoveryRequestId !==
        request.sourceDiscoveryRequestId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceAcquisitionExperimentAssignment"],
        message:
          "The experiment assignment binding must match the source discovery request.",
      });
    }
  });

const appliedLearningCandidateSchema = z
  .object({
    id: z.number().int().positive(),
    candidateKey: z.string().min(3).max(180),
    version: z.number().int().positive(),
    policyReleaseId: z.string().uuid(),
    policyReleaseReceiptHash: z.string().regex(/^[a-f0-9]{64}$/),
    proposal: z
      .object({
        action: z.literal("prioritize_for_next_research_batch"),
        dimension: z.enum(["category", "metro"]),
        value: z.string().trim().min(2).max(160),
        maximumNextBatchSize: z
          .number()
          .int()
          .min(1)
          .max(VELVET_LEAD_SOURCE_MAX_BATCH_SIZE),
      })
      .strict(),
  })
  .strict();

export const velvetLeadSourceResponseSchema = z
  .object({
    ok: z.literal(true),
    contractVersion: z.literal(VELVET_LEAD_SOURCE_RESPONSE_CONTRACT),
    state: z.enum(["EXPORTED", "EMPTY", "DUPLICATE"]),
    originalState: z.enum(["EXPORTED", "EMPTY"]),
    requestId: z.string().min(20).max(160).regex(SAFE_EXTERNAL_ID),
    requestPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    batchId: z.number().int().positive(),
    prospectsHash: z.string().regex(/^[a-f0-9]{64}$/),
    prospects: z
      .array(velvetResearchPayloadSchema)
      .max(VELVET_LEAD_SOURCE_MAX_BATCH_SIZE),
    appliedLearningCandidate: appliedLearningCandidateSchema.nullable(),
    acquisitionExperimentAssignment: velvetAcquisitionSourcingAssignmentSchema
      .nullable()
      .default(null),
    sourceDiscoveryRequestId: z
      .string()
      .min(20)
      .max(160)
      .regex(SAFE_EXTERNAL_ID)
      .nullable()
      .default(null),
    contactActionAllowed: z.literal(false),
    spendAuthorized: z.literal(false),
    externalAction: z.literal("research_export_only"),
  })
  .strict()
  .superRefine((response, ctx) => {
    if (
      (response.originalState === "EMPTY") !==
      (response.prospects.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "EMPTY state must exactly match an empty prospect list.",
      });
    }
    const externalIds = new Set<string>();
    for (let index = 0; index < response.prospects.length; index += 1) {
      const prospect = response.prospects[index];
      if (externalIds.has(prospect.externalId)) {
        ctx.addIssue({
          code: "custom",
          path: ["prospects", index, "externalId"],
          message: "Prospect external IDs must be unique within a batch.",
        });
      }
      externalIds.add(prospect.externalId);
    }
  });

export type VelvetLeadSourceCriteria = z.infer<
  typeof velvetLeadSourceCriteriaSchema
>;
export type VelvetLeadSourceRequest = z.infer<
  typeof velvetLeadSourceRequestSchema
>;
export type VelvetLeadSourceResponse = z.infer<
  typeof velvetLeadSourceResponseSchema
>;

export type VelvetLeadSourceConfig = {
  enabled: boolean;
  configured: boolean;
  baseUrl: string;
  apiKey: string;
  workspaceId: number | null;
  missing: string[];
};

export type VelvetLeadSourceResult =
  | {
      success: true;
      httpStatus: 200 | 201;
      response: VelvetLeadSourceResponse;
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

export function hashVelvetLeadSourceValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildVelvetLeadSourceRequest(input: {
  requestId: string;
  workspaceId: number;
  criteria: VelvetLeadSourceCriteria;
  sourceDiscoveryRequestId?: string;
  sourceAcquisitionExperimentAssignment?: VelvetAcquisitionSourcingAssignmentBinding;
}): VelvetLeadSourceRequest {
  return velvetLeadSourceRequestSchema.parse({
    contractVersion: VELVET_LEAD_SOURCE_REQUEST_CONTRACT,
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    sourceDiscoveryRequestId: input.sourceDiscoveryRequestId,
    ...(input.sourceAcquisitionExperimentAssignment
      ? {
          sourceAcquisitionExperimentAssignment:
            input.sourceAcquisitionExperimentAssignment,
        }
      : {}),
    criteria: input.criteria,
    contactActionAllowed: false,
    maxSpendCents: 0,
  });
}

export function readVelvetLeadSourceConfig(
  env: Record<string, string | undefined> = process.env
): VelvetLeadSourceConfig {
  const enabled =
    String(env.VELVET_LEAD_SOURCE_ENABLED || "")
      .trim()
      .toLowerCase() === "true";
  const rawBaseUrl = String(
    env.VELVET_LEAD_SOURCE_BASE_URL || ""
  ).trim();
  const apiKey = String(env.VELVET_LEAD_SOURCE_API_KEY || "").trim();
  const outcomeApiKey = String(env.VELVET_OUTCOME_API_KEY || "").trim();
  const nonDedicatedKeys = [
    outcomeApiKey,
    String(env.DASHBOARD_API_KEY || "").trim(),
    String(env.DEMO_OPERATOR_API_KEY || "").trim(),
    String(env.VELVET_ALCHEMY_HANDOFF_API_KEY || "").trim(),
    String(env.VELVET_ALCHEMY_RESEARCH_API_KEY || "").trim(),
  ].filter(Boolean);
  const rawWorkspaceId = String(
    env.VELVET_LEAD_SOURCE_WORKSPACE_ID || ""
  ).trim();
  const workspaceId = Number(rawWorkspaceId);
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
    missing.push("VELVET_LEAD_SOURCE_ENABLED");
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
    throw new Error("Velvet lead batch response exceeded the safe size limit.");
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
        "Velvet lead batch response exceeded the safe size limit."
      );
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

export function validateVelvetLeadSourceResponse(input: {
  httpStatus: number;
  body: unknown;
  request: VelvetLeadSourceRequest;
}): VelvetLeadSourceResult {
  if (input.httpStatus !== 200 && input.httpStatus !== 201) {
    const body =
      input.body && typeof input.body === "object"
        ? (input.body as Record<string, unknown>)
        : {};
    const code =
      typeof body.code === "string"
        ? body.code
        : "VELVET_LEAD_SOURCE_REMOTE_REJECTED";
    return {
      success: false,
      httpStatus: input.httpStatus,
      code,
      error:
        typeof body.error === "string"
          ? body.error
          : `Velvet rejected the lead batch (${input.httpStatus}).`,
      retryable:
        input.httpStatus >= 500 ||
        (input.httpStatus === 409 &&
          code === "SMIRK_LEAD_BATCH_IN_PROGRESS"),
    };
  }
  const parsed = velvetLeadSourceResponseSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      success: false,
      httpStatus: input.httpStatus,
      code: "VELVET_LEAD_SOURCE_INVALID_RESPONSE",
      error: "Velvet returned an invalid lead batch response.",
      retryable: false,
    };
  }
  const expectedRequestHash = hashVelvetLeadSourceValue(input.request);
  if (
    parsed.data.requestId !== input.request.requestId ||
    parsed.data.requestPayloadHash !== expectedRequestHash ||
    parsed.data.sourceDiscoveryRequestId !==
      (input.request.sourceDiscoveryRequestId || null) ||
    !assignmentMatchesVelvetSourceBinding({
      assignment: parsed.data.acquisitionExperimentAssignment,
      binding: input.request.sourceAcquisitionExperimentAssignment,
    }) ||
    parsed.data.prospectsHash !==
      hashVelvetLeadSourceValue(parsed.data.prospects) ||
    parsed.data.prospects.some(
      prospect => prospect.workspaceId !== input.request.workspaceId
    )
  ) {
    return {
      success: false,
      httpStatus: input.httpStatus,
      code: "VELVET_LEAD_SOURCE_RESPONSE_MISMATCH",
      error: "Velvet response proof does not match this request.",
      retryable: false,
    };
  }
  const expectedStates =
    input.httpStatus === 200
      ? ["DUPLICATE"]
      : [parsed.data.originalState];
  if (!expectedStates.includes(parsed.data.state)) {
    return {
      success: false,
      httpStatus: input.httpStatus,
      code: "VELVET_LEAD_SOURCE_RESPONSE_STATE_MISMATCH",
      error: "Velvet response state does not match its HTTP status.",
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

export async function requestVelvetLeadBatch(
  request: VelvetLeadSourceRequest,
  config: VelvetLeadSourceConfig,
  fetchImpl: FetchLike = fetch
): Promise<VelvetLeadSourceResult> {
  if (!config.configured || !config.workspaceId) {
    return {
      success: false,
      code: "VELVET_LEAD_SOURCE_NOT_CONFIGURED",
      error: `Velvet lead sourcing is not configured: ${config.missing.join(", ")}`,
      retryable: false,
    };
  }
  if (request.workspaceId !== config.workspaceId) {
    return {
      success: false,
      code: "VELVET_LEAD_SOURCE_WORKSPACE_MISMATCH",
      error: "The request does not match the configured workspace.",
      retryable: false,
    };
  }
  const parsedRequest = velvetLeadSourceRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    return {
      success: false,
      code: "VELVET_LEAD_SOURCE_INVALID_REQUEST",
      error: "The local Velvet lead request is invalid.",
      retryable: false,
    };
  }

  try {
    const response = await fetchImpl(
      `${config.baseUrl}/api/v1/smirk/lead-batches`,
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
    let responseBody: unknown = {};
    try {
      responseBody = responseText ? JSON.parse(responseText) : {};
    } catch {
      return {
        success: false,
        httpStatus: response.status,
        code: "VELVET_LEAD_SOURCE_NON_JSON_RESPONSE",
        error: "Velvet lead batch response was not valid JSON.",
        retryable: false,
      };
    }
    return validateVelvetLeadSourceResponse({
      httpStatus: response.status,
      body: responseBody,
      request: parsedRequest.data,
    });
  } catch (error) {
    return {
      success: false,
      code: "VELVET_LEAD_SOURCE_TRANSPORT_UNCERTAIN",
      error:
        error instanceof Error
          ? error.message
          : "Velvet lead batch request failed.",
      retryable: true,
    };
  }
}
