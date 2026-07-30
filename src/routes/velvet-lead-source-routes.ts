import { randomUUID } from "node:crypto";
import type {
  Express,
  Request,
  RequestHandler,
  Response,
} from "express";
import { z } from "zod";
import {
  VELVET_LEAD_SOURCE_APPROVAL_CONFIRMATION,
  VELVET_LEAD_SOURCE_CANCEL_CONFIRMATION,
  VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION,
  buildVelvetLeadSourceRequest,
  hashVelvetLeadSourceValue,
  readVelvetLeadSourceConfig,
  requestVelvetLeadBatch,
  validateVelvetLeadSourceResponse,
  velvetLeadSourceCriteriaSchema,
  velvetLeadSourceRequestSchema,
  velvetLeadSourceResponseSchema,
  type VelvetLeadSourceRequest,
  type VelvetLeadSourceResponse,
} from "../velvet-lead-source.js";
import { buildVelvetResearchPayloadHash } from "../velvet-research.js";
import type { VelvetResearchStore } from "./velvet-research-routes.js";

type SqlClient = any;
const VELVET_LEAD_SOURCE_DISPATCH_LEASE_MS = 2 * 60_000;

type VelvetLeadSourceRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  requireFullOperator: RequestHandler;
  sql: SqlClient;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  store: VelvetResearchStore;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

type SourceRequestRow = {
  id: number;
  request_id: string;
  workspace_id: number;
  state:
    | "PREPARED"
    | "APPROVED"
    | "SENDING"
    | "PARTIAL"
    | "COMPLETED"
    | "EMPTY"
    | "FAILED"
    | "CANCELLED"
    | "EXPIRED";
  criteria: unknown;
  request_payload: unknown;
  request_payload_hash: string;
  prepared_by: string;
  approved_by: string | null;
  approved_at: string | null;
  approval_attestations: unknown;
  expires_at: string;
  attempts: number;
  remote_batch_id: number | null;
  remote_original_state: string | null;
  remote_response: unknown;
  remote_response_hash: string | null;
  applied_learning_candidate: unknown;
  imported_count: number;
  failed_count: number;
  last_error: string | null;
  dispatch_requested_by: string | null;
  dispatch_requested_at: string | null;
  dispatch_response_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

class VelvetLeadSourceRouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
  }
}

const prepareSchema = z
  .object({
    criteria: velvetLeadSourceCriteriaSchema,
  })
  .strict();

const approveSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(VELVET_LEAD_SOURCE_APPROVAL_CONFIRMATION),
    attestations: z
      .object({
        noContactAuthorized: z.literal(true),
        zeroSpendAuthorized: z.literal(true),
      })
      .strict(),
  })
  .strict();

const dispatchSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(VELVET_LEAD_SOURCE_DISPATCH_CONFIRMATION),
  })
  .strict();

const cancelSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(VELVET_LEAD_SOURCE_CANCEL_CONFIRMATION),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

function actorForRequest(req: Request): string {
  return (req as any).authMode === "operator"
    ? "dashboard_full_operator"
    : "unknown_operator";
}

function parsePositiveId(raw: string): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function checkedTime(value: unknown, label: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(parsed.getTime())) {
    throw new VelvetLeadSourceRouteError(
      `${label} is invalid.`,
      409,
      "VELVET_LEAD_SOURCE_STORED_TIME_INVALID"
    );
  }
  return parsed;
}

function safeFailureCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return String((error as { code: string }).code).slice(0, 160);
  }
  return "VELVET_LEAD_SOURCE_IMPORT_FAILED";
}

async function writeEvent(
  tx: SqlClient,
  input: {
    workspaceId: number;
    requestRowId: number;
    fromState: string | null;
    toState: string;
    actor: string;
    payloadHash: string;
    details?: Record<string, unknown>;
  }
) {
  await tx`
    INSERT INTO velvet_lead_source_request_events (
      event_id, workspace_id, request_row_id, from_state, to_state,
      actor, payload_hash, details
    ) VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.requestRowId},
      ${input.fromState}, ${input.toState}, ${input.actor},
      ${input.payloadHash}, ${tx.json(input.details || {})}
    )
  `;
}

function assertStoredRequest(
  row: SourceRequestRow,
  expectedHash: string
): VelvetLeadSourceRequest {
  if (row.request_payload_hash !== expectedHash) {
    throw new VelvetLeadSourceRouteError(
      "The request payload hash does not match.",
      409,
      "VELVET_LEAD_SOURCE_PAYLOAD_MISMATCH"
    );
  }
  let storedPayload: unknown;
  try {
    storedPayload = safeJson(row.request_payload);
  } catch {
    throw new VelvetLeadSourceRouteError(
      "The stored Velvet request is not readable.",
      409,
      "VELVET_LEAD_SOURCE_STORED_REQUEST_INVALID"
    );
  }
  const parsed = velvetLeadSourceRequestSchema.safeParse(storedPayload);
  if (
    !parsed.success ||
    hashVelvetLeadSourceValue(parsed.data) !== row.request_payload_hash ||
    parsed.data.workspaceId !== row.workspace_id ||
    parsed.data.requestId !== row.request_id
  ) {
    throw new VelvetLeadSourceRouteError(
      "The stored Velvet request failed its integrity check.",
      409,
      "VELVET_LEAD_SOURCE_STORED_REQUEST_INVALID"
    );
  }
  return parsed.data;
}

async function loadRequest(
  tx: SqlClient,
  requestRowId: number,
  workspaceId: number
): Promise<SourceRequestRow> {
  const rows = await tx<SourceRequestRow[]>`
    SELECT *
    FROM velvet_lead_source_requests
    WHERE id = ${requestRowId}
      AND workspace_id = ${workspaceId}
    LIMIT 1
    FOR UPDATE
  `;
  if (!rows[0]) {
    throw new VelvetLeadSourceRouteError(
      "Velvet source request not found.",
      404,
      "VELVET_LEAD_SOURCE_REQUEST_NOT_FOUND"
    );
  }
  return rows[0];
}

export function registerVelvetLeadSourceRoutes(
  app: Express,
  deps: VelvetLeadSourceRouteDeps
): void {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || (() => new Date());

  app.get(
    "/api/prospecting/velvet-source/status",
    deps.dashboardAuth,
    deps.requireOperator,
    (req: Request, res: Response) => {
      const workspaceId = deps.getWorkspaceId(req);
      const config = readVelvetLeadSourceConfig(env);
      return res.json({
        enabled: config.enabled,
        configured: config.configured,
        availableForWorkspace:
          deps.dbEnabled &&
          config.configured &&
          config.workspaceId === workspaceId,
        workspaceId,
        missing: config.missing,
        maximumBatchSize: 20,
        contactActionAllowed: false,
        spendAuthorized: false,
        externalAction: "none",
      });
    }
  );

  app.get(
    "/api/prospecting/velvet-source/requests",
    deps.dashboardAuth,
    deps.requireOperator,
    async (req: Request, res: Response) => {
      if (!deps.dbEnabled) {
        return res.json({ requests: [], externalAction: "none" });
      }
      const workspaceId = deps.getWorkspaceId(req);
      const rows = await deps.sql<SourceRequestRow[]>`
        SELECT id, request_id, workspace_id, state, criteria,
               request_payload_hash, prepared_by, approved_by, approved_at,
               expires_at, attempts, remote_batch_id, remote_original_state,
               applied_learning_candidate, imported_count, failed_count,
               last_error, dispatch_requested_at, dispatch_response_at,
               completed_at, created_at, updated_at
        FROM velvet_lead_source_requests
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return res.json({
        requests: rows,
        externalAction: "none",
      });
    }
  );

  app.post(
    "/api/prospecting/velvet-source/requests",
    deps.dashboardAuth,
    deps.requireOperator,
    deps.requireFullOperator,
    async (req: Request, res: Response) => {
      if (!deps.dbEnabled) {
        return res.status(503).json({
          error: "Durable storage is required.",
          code: "VELVET_LEAD_SOURCE_STORAGE_REQUIRED",
        });
      }
      const parsed = prepareSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid Velvet source request.",
          code: "VELVET_LEAD_SOURCE_PREPARE_INVALID",
        });
      }
      const workspaceId = deps.getWorkspaceId(req);
      const requestedAt = now();
      if (!Number.isFinite(requestedAt.getTime())) {
        return res.status(503).json({
          error: "The request clock is unavailable.",
          code: "VELVET_LEAD_SOURCE_CLOCK_INVALID",
        });
      }
      const requestId = `smirk-source-${randomUUID()}`;
      const payload = buildVelvetLeadSourceRequest({
        requestId,
        workspaceId,
        criteria: parsed.data.criteria,
      });
      const payloadHash = hashVelvetLeadSourceValue(payload);
      const expiresAt = new Date(
        requestedAt.getTime() + 24 * 60 * 60_000
      ).toISOString();
      const actor = actorForRequest(req);

      try {
        const rows = await deps.sql.begin(async (tx: SqlClient) => {
          const inserted = await tx<{ id: number }[]>`
            INSERT INTO velvet_lead_source_requests (
              request_id, workspace_id, state, criteria, request_payload,
              request_payload_hash, prepared_by, expires_at
            ) VALUES (
              ${requestId}, ${workspaceId}, 'PREPARED',
              ${tx.json(parsed.data.criteria)}, ${tx.json(payload)},
              ${payloadHash}, ${actor}, ${expiresAt}
            )
            RETURNING id
          `;
          const id = Number(inserted[0]?.id || 0);
          if (!id) {
            throw new VelvetLeadSourceRouteError(
              "The request receipt was not created.",
              500,
              "VELVET_LEAD_SOURCE_PREPARE_FAILED"
            );
          }
          await writeEvent(tx, {
            workspaceId,
            requestRowId: id,
            fromState: null,
            toState: "PREPARED",
            actor,
            payloadHash,
            details: {
              contactActionAllowed: false,
              maxSpendCents: 0,
            },
          });
          return [{ id }];
        });
        return res.status(201).json({
          id: rows[0].id,
          requestId,
          state: "PREPARED",
          payloadHash,
          expiresAt,
          contactActionAllowed: false,
          spendAuthorized: false,
          externalAction: "none",
        });
      } catch (error) {
        const routed =
          error instanceof VelvetLeadSourceRouteError ? error : null;
        return res.status(routed?.status || 500).json({
          error:
            routed?.message ||
            "The Velvet source request could not be prepared.",
          code: routed?.code || "VELVET_LEAD_SOURCE_PREPARE_FAILED",
        });
      }
    }
  );

  app.post(
    "/api/prospecting/velvet-source/requests/:id/approve",
    deps.dashboardAuth,
    deps.requireOperator,
    deps.requireFullOperator,
    async (req: Request, res: Response) => {
      const requestRowId = parsePositiveId(req.params.id);
      const parsed = approveSchema.safeParse(req.body);
      if (!requestRowId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid Velvet source approval.",
          code: "VELVET_LEAD_SOURCE_APPROVAL_INVALID",
        });
      }
      if (!deps.dbEnabled) {
        return res.status(503).json({
          error: "Durable storage is required.",
          code: "VELVET_LEAD_SOURCE_STORAGE_REQUIRED",
        });
      }
      const workspaceId = deps.getWorkspaceId(req);
      const actor = actorForRequest(req);
      const approvedAt = now();
      if (!Number.isFinite(approvedAt.getTime())) {
        return res.status(503).json({
          error: "The approval clock is unavailable.",
          code: "VELVET_LEAD_SOURCE_CLOCK_INVALID",
        });
      }

      try {
        const result = await deps.sql.begin(async (tx: SqlClient) => {
          const row = await loadRequest(tx, requestRowId, workspaceId);
          assertStoredRequest(row, parsed.data.payloadHash);
          if (row.state === "APPROVED") {
            return { state: "APPROVED" as const, replay: true };
          }
          if (row.state !== "PREPARED") {
            throw new VelvetLeadSourceRouteError(
              `A ${row.state} request cannot be approved.`,
              409,
              "VELVET_LEAD_SOURCE_APPROVAL_STATE_CONFLICT"
            );
          }
          if (
            checkedTime(
              row.expires_at,
              "The stored request expiration"
            ).getTime() <= approvedAt.getTime()
          ) {
            const expired = await tx<{ id: number }[]>`
              UPDATE velvet_lead_source_requests
              SET state = 'EXPIRED', updated_at = NOW()
              WHERE id = ${row.id}
                AND workspace_id = ${workspaceId}
                AND state = 'PREPARED'
              RETURNING id
            `;
            if (!expired[0]) {
              throw new VelvetLeadSourceRouteError(
                "The request changed before expiration.",
                409,
                "VELVET_LEAD_SOURCE_APPROVAL_RACE"
              );
            }
            await writeEvent(tx, {
              workspaceId,
              requestRowId: row.id,
              fromState: "PREPARED",
              toState: "EXPIRED",
              actor,
              payloadHash: row.request_payload_hash,
            });
            return { state: "EXPIRED" as const, replay: false };
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE velvet_lead_source_requests
            SET state = 'APPROVED', approved_by = ${actor},
                approved_at = ${approvedAt.toISOString()},
                approval_attestations = ${tx.json(parsed.data.attestations)},
                updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = 'PREPARED'
            RETURNING id
          `;
          if (!updated[0]) {
            throw new VelvetLeadSourceRouteError(
              "The request changed before approval.",
              409,
              "VELVET_LEAD_SOURCE_APPROVAL_RACE"
            );
          }
          await writeEvent(tx, {
            workspaceId,
            requestRowId: row.id,
            fromState: "PREPARED",
            toState: "APPROVED",
            actor,
            payloadHash: row.request_payload_hash,
            details: parsed.data.attestations,
          });
          return { state: "APPROVED" as const, replay: false };
        });
        if (result.state === "EXPIRED") {
          return res.status(409).json({
            id: requestRowId,
            state: "EXPIRED",
            error: "The request expired before approval.",
            code: "VELVET_LEAD_SOURCE_REQUEST_EXPIRED",
            externalAction: "none",
          });
        }
        return res.json({
          id: requestRowId,
          ...result,
          externalAction: "none",
        });
      } catch (error) {
        const routed =
          error instanceof VelvetLeadSourceRouteError ? error : null;
        return res.status(routed?.status || 500).json({
          error: routed?.message || "The request could not be approved.",
          code: routed?.code || "VELVET_LEAD_SOURCE_APPROVAL_FAILED",
        });
      }
    }
  );

  app.post(
    "/api/prospecting/velvet-source/requests/:id/cancel",
    deps.dashboardAuth,
    deps.requireOperator,
    deps.requireFullOperator,
    async (req: Request, res: Response) => {
      const requestRowId = parsePositiveId(req.params.id);
      const parsed = cancelSchema.safeParse(req.body);
      if (!requestRowId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid Velvet source cancellation.",
          code: "VELVET_LEAD_SOURCE_CANCEL_INVALID",
        });
      }
      if (!deps.dbEnabled) {
        return res.status(503).json({
          error: "Durable storage is required.",
          code: "VELVET_LEAD_SOURCE_STORAGE_REQUIRED",
        });
      }
      const workspaceId = deps.getWorkspaceId(req);
      const actor = actorForRequest(req);
      try {
        await deps.sql.begin(async (tx: SqlClient) => {
          const row = await loadRequest(tx, requestRowId, workspaceId);
          assertStoredRequest(row, parsed.data.payloadHash);
          if (row.state === "CANCELLED") return;
          if (!["PREPARED", "APPROVED"].includes(row.state)) {
            throw new VelvetLeadSourceRouteError(
              `A ${row.state} request cannot be cancelled safely.`,
              409,
              "VELVET_LEAD_SOURCE_CANCEL_STATE_CONFLICT"
            );
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE velvet_lead_source_requests
            SET state = 'CANCELLED', last_error = ${parsed.data.reason},
                updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = ${row.state}
            RETURNING id
          `;
          if (!updated[0]) {
            throw new VelvetLeadSourceRouteError(
              "The request changed before cancellation.",
              409,
              "VELVET_LEAD_SOURCE_CANCEL_RACE"
            );
          }
          await writeEvent(tx, {
            workspaceId,
            requestRowId: row.id,
            fromState: row.state,
            toState: "CANCELLED",
            actor,
            payloadHash: row.request_payload_hash,
            details: { reason: parsed.data.reason },
          });
        });
        return res.json({
          id: requestRowId,
          state: "CANCELLED",
          externalAction: "none",
        });
      } catch (error) {
        const routed =
          error instanceof VelvetLeadSourceRouteError ? error : null;
        return res.status(routed?.status || 500).json({
          error: routed?.message || "The request could not be cancelled.",
          code: routed?.code || "VELVET_LEAD_SOURCE_CANCEL_FAILED",
        });
      }
    }
  );

  app.post(
    "/api/prospecting/velvet-source/requests/:id/dispatch",
    deps.dashboardAuth,
    deps.requireOperator,
    deps.requireFullOperator,
    async (req: Request, res: Response) => {
      const requestRowId = parsePositiveId(req.params.id);
      const parsed = dispatchSchema.safeParse(req.body);
      if (!requestRowId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid Velvet source dispatch.",
          code: "VELVET_LEAD_SOURCE_DISPATCH_INVALID",
        });
      }
      if (!deps.dbEnabled) {
        return res.status(503).json({
          error: "Durable storage is required.",
          code: "VELVET_LEAD_SOURCE_STORAGE_REQUIRED",
        });
      }
      const workspaceId = deps.getWorkspaceId(req);
      const config = readVelvetLeadSourceConfig(env);
      if (!config.configured) {
        return res.status(503).json({
          error: `Velvet lead sourcing is not configured: ${config.missing.join(", ")}`,
          code: "VELVET_LEAD_SOURCE_NOT_CONFIGURED",
        });
      }
      if (config.workspaceId !== workspaceId) {
        return res.status(403).json({
          error: "Velvet lead sourcing is locked to another workspace.",
          code: "VELVET_LEAD_SOURCE_WORKSPACE_LOCKED",
        });
      }
      const actor = actorForRequest(req);
      const requestedAt = now();
      if (!Number.isFinite(requestedAt.getTime())) {
        return res.status(503).json({
          error: "The dispatch clock is unavailable.",
          code: "VELVET_LEAD_SOURCE_CLOCK_INVALID",
        });
      }

      try {
        const claim = await deps.sql.begin(async (tx: SqlClient) => {
          await tx`
            SELECT pg_advisory_xact_lock(1447842642, ${workspaceId})
          `;
          const row = await loadRequest(tx, requestRowId, workspaceId);
          const requestPayload = assertStoredRequest(
            row,
            parsed.data.payloadHash
          );
          if (row.state === "COMPLETED" || row.state === "EMPTY") {
            return {
              row,
              requestPayload,
              completedReplay: true as const,
            };
          }
          if (
            !["APPROVED", "SENDING", "PARTIAL"].includes(row.state)
          ) {
            throw new VelvetLeadSourceRouteError(
              `A ${row.state} request cannot be dispatched.`,
              409,
              "VELVET_LEAD_SOURCE_DISPATCH_STATE_CONFLICT"
            );
          }
          if (
            row.state === "APPROVED" &&
            checkedTime(
              row.expires_at,
              "The stored request expiration"
            ).getTime() <= requestedAt.getTime()
          ) {
            const expired = await tx<{ id: number }[]>`
              UPDATE velvet_lead_source_requests
              SET state = 'EXPIRED', updated_at = NOW()
              WHERE id = ${row.id}
                AND workspace_id = ${workspaceId}
                AND state = 'APPROVED'
              RETURNING id
            `;
            if (!expired[0]) {
              throw new VelvetLeadSourceRouteError(
                "The request changed before expiration.",
                409,
                "VELVET_LEAD_SOURCE_DISPATCH_RACE"
              );
            }
            await writeEvent(tx, {
              workspaceId,
              requestRowId: row.id,
              fromState: "APPROVED",
              toState: "EXPIRED",
              actor,
              payloadHash: row.request_payload_hash,
            });
            return {
              row: { ...row, state: "EXPIRED" as const },
              requestPayload,
              completedReplay: false as const,
              expired: true as const,
            };
          }
          if (row.state === "APPROVED") {
            const updated = await tx<{ id: number }[]>`
              UPDATE velvet_lead_source_requests
              SET state = 'SENDING', attempts = attempts + 1,
                  dispatch_requested_by = ${actor},
                  dispatch_requested_at = ${requestedAt.toISOString()},
                  dispatch_response_at = NULL, last_error = NULL,
                  updated_at = NOW()
              WHERE id = ${row.id}
                AND workspace_id = ${workspaceId}
                AND state = 'APPROVED'
              RETURNING id
            `;
            if (!updated[0]) {
              throw new VelvetLeadSourceRouteError(
                "The request changed before dispatch.",
                409,
                "VELVET_LEAD_SOURCE_DISPATCH_RACE"
              );
            }
            await writeEvent(tx, {
              workspaceId,
              requestRowId: row.id,
              fromState: "APPROVED",
              toState: "SENDING",
              actor,
              payloadHash: row.request_payload_hash,
              details: { attempt: row.attempts + 1 },
            });
            row.state = "SENDING";
            row.attempts += 1;
          } else {
            if (
              row.state === "SENDING" &&
              !row.last_error &&
              row.dispatch_requested_at &&
              requestedAt.getTime() <
                checkedTime(
                  row.dispatch_requested_at,
                  "The stored dispatch lease"
                ).getTime() + VELVET_LEAD_SOURCE_DISPATCH_LEASE_MS
            ) {
              throw new VelvetLeadSourceRouteError(
                "This exact Velvet request is already being dispatched.",
                409,
                "VELVET_LEAD_SOURCE_DISPATCH_IN_PROGRESS"
              );
            }
            const fromState = row.state;
            const updated = await tx<{ id: number }[]>`
              UPDATE velvet_lead_source_requests
              SET state = 'SENDING', attempts = attempts + 1,
                  dispatch_requested_by = ${actor},
                  dispatch_requested_at = ${requestedAt.toISOString()},
                  last_error = NULL, updated_at = NOW()
              WHERE id = ${row.id}
                AND workspace_id = ${workspaceId}
                AND state = ${fromState}
              RETURNING id
            `;
            if (!updated[0]) {
              throw new VelvetLeadSourceRouteError(
                "The request changed before retry.",
                409,
                "VELVET_LEAD_SOURCE_DISPATCH_RACE"
              );
            }
            if (fromState === "PARTIAL") {
              await writeEvent(tx, {
                workspaceId,
                requestRowId: row.id,
                fromState,
                toState: "SENDING",
                actor,
                payloadHash: row.request_payload_hash,
                details: {
                  attempt: row.attempts + 1,
                  storedResponse: Boolean(row.remote_response),
                },
              });
            }
            row.state = "SENDING";
            row.attempts += 1;
          }
          return {
            row,
            requestPayload,
            completedReplay: false as const,
            expired: false as const,
          };
        });

        if ("expired" in claim && claim.expired) {
          return res.status(409).json({
            id: claim.row.id,
            state: "EXPIRED",
            error: "The request expired before dispatch.",
            code: "VELVET_LEAD_SOURCE_REQUEST_EXPIRED",
            externalAction: "none",
          });
        }
        if (claim.completedReplay) {
          return res.json({
            id: claim.row.id,
            state: claim.row.state,
            importedCount: claim.row.imported_count,
            failedCount: claim.row.failed_count,
            replay: true,
            externalAction: "research_import_only",
          });
        }

        let remoteResponse: VelvetLeadSourceResponse | null = null;
        if (claim.row.remote_response) {
          const parsedResponse = velvetLeadSourceResponseSchema.safeParse(
            safeJson(claim.row.remote_response)
          );
          const storedValidation = parsedResponse.success
            ? validateVelvetLeadSourceResponse({
                httpStatus:
                  parsedResponse.data.state === "DUPLICATE" ? 200 : 201,
                body: parsedResponse.data,
                request: claim.requestPayload,
              })
            : null;
          if (
            !parsedResponse.success ||
            !claim.row.remote_response_hash ||
            hashVelvetLeadSourceValue(parsedResponse.data) !==
              claim.row.remote_response_hash ||
            storedValidation?.success !== true
          ) {
            throw new VelvetLeadSourceRouteError(
              "The stored Velvet response failed validation.",
              409,
              "VELVET_LEAD_SOURCE_STORED_RESPONSE_INVALID"
            );
          }
          remoteResponse = parsedResponse.data;
        } else {
          const remoteResult = await requestVelvetLeadBatch(
            claim.requestPayload,
            config,
            fetchImpl
          );
          if (remoteResult.success === false) {
            const nextState = remoteResult.retryable ? "SENDING" : "FAILED";
            await deps.sql.begin(async (tx: SqlClient) => {
              const updated = await tx<{ id: number }[]>`
                UPDATE velvet_lead_source_requests
                SET state = ${nextState},
                    last_error = ${`${remoteResult.code}: ${remoteResult.error}`.slice(0, 2_000)},
                    dispatch_response_at = ${
                      remoteResult.httpStatus
                        ? requestedAt.toISOString()
                        : null
                    },
                    updated_at = NOW()
                WHERE id = ${claim.row.id}
                  AND workspace_id = ${workspaceId}
                  AND state IN ('SENDING', 'PARTIAL')
                RETURNING id
              `;
              if (!updated[0]) {
                throw new VelvetLeadSourceRouteError(
                  "The request changed before the failure receipt was stored.",
                  409,
                  "VELVET_LEAD_SOURCE_DISPATCH_RACE"
                );
              }
              if (nextState === "FAILED") {
                await writeEvent(tx, {
                  workspaceId,
                  requestRowId: claim.row.id,
                  fromState: claim.row.state,
                  toState: "FAILED",
                  actor,
                  payloadHash: claim.row.request_payload_hash,
                  details: {
                    code: remoteResult.code,
                    httpStatus: remoteResult.httpStatus,
                  },
                });
              }
            });
            return res.status(remoteResult.retryable ? 503 : 502).json({
              id: claim.row.id,
              state: nextState,
              code: remoteResult.code,
              error: remoteResult.error,
              retryable: remoteResult.retryable,
              externalAction: remoteResult.retryable
                ? "velvet_source_unknown"
                : "blocked",
            });
          }
          remoteResponse = remoteResult.response;
          const storedResponseRows = await deps.sql<{ id: number }[]>`
            UPDATE velvet_lead_source_requests
            SET remote_batch_id = ${remoteResponse.batchId},
                remote_original_state = ${remoteResponse.originalState},
                remote_response = ${deps.sql.json(remoteResponse)},
                remote_response_hash = ${hashVelvetLeadSourceValue(remoteResponse)},
                applied_learning_candidate = ${
                  remoteResponse.appliedLearningCandidate
                    ? deps.sql.json(
                        remoteResponse.appliedLearningCandidate
                      )
                    : null
                },
                dispatch_response_at = ${requestedAt.toISOString()},
                last_error = NULL, updated_at = NOW()
            WHERE id = ${claim.row.id}
              AND workspace_id = ${workspaceId}
              AND state IN ('SENDING', 'PARTIAL')
            RETURNING id
          `;
          if (!storedResponseRows[0]) {
            throw new VelvetLeadSourceRouteError(
              "The request changed before the Velvet response was stored.",
              409,
              "VELVET_LEAD_SOURCE_DISPATCH_RACE"
            );
          }
        }

        let failedCount = 0;
        for (const prospect of remoteResponse.prospects) {
          const existingItems = await deps.sql<{
            import_state: string;
          }[]>`
            SELECT import_state
            FROM velvet_lead_source_request_items
            WHERE request_row_id = ${claim.row.id}
              AND workspace_id = ${workspaceId}
              AND external_id = ${prospect.externalId}
            LIMIT 1
          `;
          if (
            ["IMPORTED", "DUPLICATE"].includes(
              existingItems[0]?.import_state || ""
            )
          ) {
            continue;
          }
          const prospectPayloadHash =
            buildVelvetResearchPayloadHash(prospect);
          try {
            const imported = await deps.store.receive({
              ...prospect,
              payloadHash: prospectPayloadHash,
            });
            const importState =
              imported.outcome === "created" ? "IMPORTED" : "DUPLICATE";
            await deps.sql`
              INSERT INTO velvet_lead_source_request_items (
                request_row_id, workspace_id, external_id,
                prospect_payload_hash, import_state, campaign_id, prospect_id
              ) VALUES (
                ${claim.row.id}, ${workspaceId}, ${prospect.externalId},
                ${prospectPayloadHash}, ${importState},
                ${imported.campaignId}, ${imported.prospectId}
              )
              ON CONFLICT (request_row_id, external_id)
              DO UPDATE SET
                prospect_payload_hash = EXCLUDED.prospect_payload_hash,
                import_state = EXCLUDED.import_state,
                campaign_id = EXCLUDED.campaign_id,
                prospect_id = EXCLUDED.prospect_id,
                error_code = NULL,
                updated_at = NOW()
            `;
          } catch (error) {
            failedCount += 1;
            await deps.sql`
              INSERT INTO velvet_lead_source_request_items (
                request_row_id, workspace_id, external_id,
                prospect_payload_hash, import_state, error_code
              ) VALUES (
                ${claim.row.id}, ${workspaceId}, ${prospect.externalId},
                ${prospectPayloadHash}, 'FAILED', ${safeFailureCode(error)}
              )
              ON CONFLICT (request_row_id, external_id)
              DO UPDATE SET
                prospect_payload_hash = EXCLUDED.prospect_payload_hash,
                import_state = 'FAILED',
                error_code = EXCLUDED.error_code,
                updated_at = NOW()
            `;
          }
        }

        const itemCounts = await deps.sql<{
          imported_count: number;
          failed_count: number;
        }[]>`
          SELECT
            COUNT(*) FILTER (
              WHERE import_state IN ('IMPORTED', 'DUPLICATE')
            )::int AS imported_count,
            COUNT(*) FILTER (
              WHERE import_state = 'FAILED'
            )::int AS failed_count
          FROM velvet_lead_source_request_items
          WHERE request_row_id = ${claim.row.id}
            AND workspace_id = ${workspaceId}
        `;
        const importedCount = Number(itemCounts[0]?.imported_count || 0);
        failedCount = Number(itemCounts[0]?.failed_count || failedCount);
        if (
          importedCount + failedCount !==
          remoteResponse.prospects.length
        ) {
          throw new VelvetLeadSourceRouteError(
            "The imported item receipts do not match the Velvet response.",
            500,
            "VELVET_LEAD_SOURCE_ITEM_COUNT_MISMATCH"
          );
        }
        const finalState =
          remoteResponse.prospects.length === 0
            ? "EMPTY"
            : failedCount > 0
              ? "PARTIAL"
              : "COMPLETED";
        await deps.sql.begin(async (tx: SqlClient) => {
          const updated = await tx<{ id: number }[]>`
            UPDATE velvet_lead_source_requests
            SET state = ${finalState}, imported_count = ${importedCount},
                failed_count = ${failedCount},
                last_error = ${
                  failedCount > 0
                    ? `${failedCount} prospect import(s) require retry.`
                    : null
                },
                completed_at = ${
                  finalState === "COMPLETED" || finalState === "EMPTY"
                    ? requestedAt.toISOString()
                    : null
                },
                updated_at = NOW()
            WHERE id = ${claim.row.id}
              AND workspace_id = ${workspaceId}
              AND state IN ('SENDING', 'PARTIAL')
            RETURNING id
          `;
          if (!updated[0]) {
            throw new VelvetLeadSourceRouteError(
              "The request changed before the import receipt was completed.",
              409,
              "VELVET_LEAD_SOURCE_DISPATCH_RACE"
            );
          }
          await writeEvent(tx, {
            workspaceId,
            requestRowId: claim.row.id,
            fromState: claim.row.state,
            toState: finalState,
            actor,
            payloadHash: claim.row.request_payload_hash,
            details: {
              importedCount,
              failedCount,
              remoteBatchId: remoteResponse.batchId,
              learningCandidateId:
                remoteResponse.appliedLearningCandidate?.id || null,
              contactActionAllowed: false,
              spendAuthorized: false,
            },
          });
        });
        return res.status(finalState === "PARTIAL" ? 502 : 200).json({
          id: claim.row.id,
          state: finalState,
          importedCount,
          failedCount,
          remoteBatchId: remoteResponse.batchId,
          appliedLearningCandidate:
            remoteResponse.appliedLearningCandidate,
          retryable: finalState === "PARTIAL",
          contactActionAllowed: false,
          spendAuthorized: false,
          externalAction: "research_import_only",
        });
      } catch (error) {
        const routed =
          error instanceof VelvetLeadSourceRouteError ? error : null;
        return res.status(routed?.status || 500).json({
          error:
            routed?.message ||
            "The Velvet source request could not be dispatched.",
          code: routed?.code || "VELVET_LEAD_SOURCE_DISPATCH_FAILED",
        });
      }
    }
  );
}
