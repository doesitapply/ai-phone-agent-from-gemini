import { randomUUID } from "node:crypto";
import type {
  Express,
  Request,
  RequestHandler,
  Response,
} from "express";
import { z } from "zod";
import {
  VELVET_DISCOVERY_APPROVAL_CONFIRMATION,
  VELVET_DISCOVERY_CANCEL_CONFIRMATION,
  VELVET_DISCOVERY_DISPATCH_CONFIRMATION,
  VELVET_DISCOVERY_IMPORT_CONFIRMATION,
  VELVET_DISCOVERY_REFRESH_CONFIRMATION,
  buildVelvetDiscoveryRequest,
  getVelvetDiscoveryStatus,
  hashVelvetDiscoveryValue,
  prepareVelvetDiscovery,
  readVelvetDiscoveryConfig,
  validateVelvetDiscoveryStatus,
  velvetDiscoveryCriteriaSchema,
  velvetDiscoveryPreparedResponseSchema,
  velvetDiscoveryRequestSchema,
  velvetDiscoveryStatusResponseSchema,
  type VelvetDiscoveryRequest,
} from "../velvet-discovery.js";
import {
  buildVelvetLeadSourceRequest,
  hashVelvetLeadSourceValue,
} from "../velvet-lead-source.js";
import {
  ProspectAcquisitionPausedError,
  acquireProspectAcquisitionWorkspaceLock,
  assertProspectAcquisitionMutationUnpaused,
  assertProspectAcquisitionUnpaused,
  createProspectAcquisitionUnpausedGuard,
} from "../prospect-positive-outcome-pause.js";

type SqlClient = any;
const DISPATCH_LEASE_MS = 2 * 60_000;
const MAX_DISPATCH_ATTEMPTS = 3;
const APPROVAL_TTL_MS = 24 * 60 * 60_000;

type VelvetDiscoveryRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  requireFullOperator: RequestHandler;
  sql: SqlClient;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

type DiscoveryRequestRow = {
  id: number;
  request_id: string;
  workspace_id: number;
  state:
    | "PREPARED"
    | "APPROVED"
    | "SENDING"
    | "SUBMITTED"
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
  remote_discovery_id: number | null;
  remote_state: string | null;
  remote_prepared_response: unknown;
  remote_prepared_hash: string | null;
  remote_status_response: unknown;
  remote_status_hash: string | null;
  quote_payload: unknown;
  quote_payload_hash: string | null;
  effective_criteria: unknown;
  created_lead_count: number;
  ready_lead_count: number;
  skipped_lead_count: number;
  failed_lead_count: number;
  provider_requests: number;
  approved_max_spend_cents: number | null;
  last_error: string | null;
  dispatch_requested_by: string | null;
  dispatch_requested_at: string | null;
  dispatch_response_at: string | null;
  status_checked_by: string | null;
  status_checked_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

class VelvetDiscoveryRouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
  }
}

const prepareSchema = z
  .object({ criteria: velvetDiscoveryCriteriaSchema })
  .strict();

const approveSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(VELVET_DISCOVERY_APPROVAL_CONFIRMATION),
    attestations: z
      .object({
        noContactAuthorized: z.literal(true),
        requestOnlyNoProviderSpend: z.literal(true),
      })
      .strict(),
  })
  .strict();

const exactActionSchema = <T extends string>(confirmation: T) =>
  z
    .object({
      payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
      confirmation: z.literal(confirmation),
    })
    .strict();

const dispatchSchema = exactActionSchema(
  VELVET_DISCOVERY_DISPATCH_CONFIRMATION
);
const refreshSchema = exactActionSchema(
  VELVET_DISCOVERY_REFRESH_CONFIRMATION
);
const importSchema = exactActionSchema(
  VELVET_DISCOVERY_IMPORT_CONFIRMATION
);
const cancelSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(VELVET_DISCOVERY_CANCEL_CONFIRMATION),
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
  const parsed =
    value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(parsed.getTime())) {
    throw new VelvetDiscoveryRouteError(
      `${label} is invalid.`,
      409,
      "VELVET_DISCOVERY_STORED_TIME_INVALID"
    );
  }
  return parsed;
}

async function writeDiscoveryEvent(
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
): Promise<void> {
  await tx`
    INSERT INTO velvet_discovery_request_events (
      event_id, workspace_id, request_row_id, from_state, to_state,
      actor, payload_hash, details
    ) VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.requestRowId},
      ${input.fromState}, ${input.toState}, ${input.actor},
      ${input.payloadHash}, ${tx.json(input.details || {})}
    )
  `;
}

async function writeSourceEvent(
  tx: SqlClient,
  input: {
    workspaceId: number;
    requestRowId: number;
    actor: string;
    payloadHash: string;
    discoveryRequestId: number;
  }
): Promise<void> {
  await tx`
    INSERT INTO velvet_lead_source_request_events (
      event_id, workspace_id, request_row_id, from_state, to_state,
      actor, payload_hash, details
    ) VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.requestRowId},
      ${null}, ${"PREPARED"}, ${input.actor}, ${input.payloadHash},
      ${tx.json({
        discoveryRequestId: input.discoveryRequestId,
        contactActionAllowed: false,
        maxSpendCents: 0,
      })}
    )
  `;
}

async function loadRequest(
  tx: SqlClient,
  requestRowId: number,
  workspaceId: number
): Promise<DiscoveryRequestRow> {
  const rows = await tx<DiscoveryRequestRow[]>`
    SELECT *
    FROM velvet_discovery_requests
    WHERE id = ${requestRowId}
      AND workspace_id = ${workspaceId}
    LIMIT 1
    FOR UPDATE
  `;
  if (!rows[0]) {
    throw new VelvetDiscoveryRouteError(
      "Velvet discovery request not found.",
      404,
      "VELVET_DISCOVERY_REQUEST_NOT_FOUND"
    );
  }
  return rows[0];
}

function assertStoredRequest(
  row: DiscoveryRequestRow,
  expectedHash: string
): VelvetDiscoveryRequest {
  if (row.request_payload_hash !== expectedHash) {
    throw new VelvetDiscoveryRouteError(
      "The discovery request payload hash does not match.",
      409,
      "VELVET_DISCOVERY_PAYLOAD_MISMATCH"
    );
  }
  let stored: unknown;
  try {
    stored = safeJson(row.request_payload);
  } catch {
    throw new VelvetDiscoveryRouteError(
      "The stored discovery request is not readable.",
      409,
      "VELVET_DISCOVERY_STORED_REQUEST_INVALID"
    );
  }
  const parsed = velvetDiscoveryRequestSchema.safeParse(stored);
  if (
    !parsed.success ||
    parsed.data.workspaceId !== row.workspace_id ||
    parsed.data.requestId !== row.request_id ||
    hashVelvetDiscoveryValue(parsed.data) !==
      row.request_payload_hash
  ) {
    throw new VelvetDiscoveryRouteError(
      "The stored discovery request failed its integrity check.",
      409,
      "VELVET_DISCOVERY_STORED_REQUEST_INVALID"
    );
  }
  return parsed.data;
}

function assertStoredPreparedResponse(
  row: DiscoveryRequestRow,
  request: VelvetDiscoveryRequest
) {
  let stored: unknown;
  try {
    stored = safeJson(row.remote_prepared_response);
  } catch {
    throw new VelvetDiscoveryRouteError(
      "The stored Velvet discovery response is not readable.",
      409,
      "VELVET_DISCOVERY_STORED_RESPONSE_INVALID"
    );
  }
  const parsed = velvetDiscoveryPreparedResponseSchema.safeParse(stored);
  if (
    !parsed.success ||
    !row.remote_prepared_hash ||
    !row.quote_payload_hash ||
    hashVelvetDiscoveryValue(parsed.data) !==
      row.remote_prepared_hash ||
    parsed.data.requestPayloadHash !==
      hashVelvetDiscoveryValue(request) ||
    parsed.data.quotePayloadHash !== row.quote_payload_hash ||
    parsed.data.discoveryId !== row.remote_discovery_id
  ) {
    throw new VelvetDiscoveryRouteError(
      "The stored Velvet discovery response failed its integrity check.",
      409,
      "VELVET_DISCOVERY_STORED_RESPONSE_INVALID"
    );
  }
  return parsed.data;
}

function assertStoredStatus(
  row: DiscoveryRequestRow,
  request: VelvetDiscoveryRequest
) {
  let stored: unknown;
  try {
    stored = safeJson(row.remote_status_response);
  } catch {
    throw new VelvetDiscoveryRouteError(
      "The stored Velvet discovery status is not readable.",
      409,
      "VELVET_DISCOVERY_STORED_STATUS_INVALID"
    );
  }
  const validation = validateVelvetDiscoveryStatus({
    body: stored,
    request,
  });
  if (
    validation.success === false ||
    !row.remote_status_hash ||
    hashVelvetDiscoveryValue(stored) !== row.remote_status_hash ||
    validation.response.discoveryId !== row.remote_discovery_id ||
    validation.response.quotePayloadHash !== row.quote_payload_hash
  ) {
    throw new VelvetDiscoveryRouteError(
      "The stored Velvet discovery status failed its integrity check.",
      409,
      "VELVET_DISCOVERY_STORED_STATUS_INVALID"
    );
  }
  return validation.response;
}

function routeError(error: unknown, fallback: string, code: string) {
  const routed =
    error instanceof VelvetDiscoveryRouteError ||
    error instanceof ProspectAcquisitionPausedError
      ? error
      : null;
  return {
    status: routed?.status || 500,
    body: {
      error: routed?.message || fallback,
      code: routed?.code || code,
      ...(routed instanceof ProspectAcquisitionPausedError
        ? {
            pendingPositiveOutcomeReviews:
              routed.pendingCount,
            externalAction: "none",
          }
        : {}),
    },
  };
}

export function registerVelvetDiscoveryRoutes(
  app: Express,
  deps: VelvetDiscoveryRouteDeps
): void {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || (() => new Date());
  const requireAcquisitionUnpaused =
    createProspectAcquisitionUnpausedGuard({
      sql: deps.sql,
      dbEnabled: deps.dbEnabled,
      getWorkspaceId: deps.getWorkspaceId,
    });

  app.get(
    "/api/prospecting/velvet-discovery/status",
    deps.dashboardAuth,
    deps.requireOperator,
    (req: Request, res: Response) => {
      const workspaceId = deps.getWorkspaceId(req);
      const config = readVelvetDiscoveryConfig(env);
      return res.json({
        enabled: config.enabled,
        configured: config.configured,
        availableForWorkspace:
          deps.dbEnabled &&
          config.configured &&
          config.workspaceId === workspaceId,
        workspaceId,
        missing: config.missing,
        maximumLeads: 20,
        maximumQuotedSpendCents: 500,
        contactActionAllowed: false,
        spendAuthorized: false,
        externalAction: "none",
      });
    }
  );

  app.get(
    "/api/prospecting/velvet-discovery/requests",
    deps.dashboardAuth,
    deps.requireOperator,
    async (req: Request, res: Response) => {
      if (!deps.dbEnabled) {
        return res.json({ requests: [], externalAction: "none" });
      }
      const workspaceId = deps.getWorkspaceId(req);
      const rows = await deps.sql<DiscoveryRequestRow[]>`
        SELECT id, request_id, workspace_id, state, criteria,
               request_payload_hash, approved_by, approved_at, expires_at,
               attempts, remote_discovery_id, remote_state,
               quote_payload, quote_payload_hash, effective_criteria,
               created_lead_count, ready_lead_count, skipped_lead_count,
               failed_lead_count, provider_requests,
               approved_max_spend_cents, last_error,
               dispatch_requested_at, dispatch_response_at,
               status_checked_at, completed_at, created_at, updated_at
        FROM velvet_discovery_requests
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC
        LIMIT 50
      `;
      const links =
        rows.length === 0
          ? []
          : await deps.sql<
              Array<{
                discovery_request_id: number;
                source_request_id: number;
                source_state: string;
              }>
            >`
              SELECT discovery_request_id, id AS source_request_id,
                     state AS source_state
              FROM velvet_lead_source_requests
              WHERE workspace_id = ${workspaceId}
                AND discovery_request_id IS NOT NULL
              ORDER BY created_at DESC
              LIMIT 50
            `;
      const byDiscovery = new Map<
        number,
        (typeof links)[number]
      >(
        links.map((link) => [
          link.discovery_request_id,
          link,
        ])
      );
      return res.json({
        requests: rows.map((row) => ({
          ...row,
          source_request_id:
            byDiscovery.get(row.id)?.source_request_id || null,
          source_state: byDiscovery.get(row.id)?.source_state || null,
        })),
        externalAction: "none",
      });
    }
  );

  app.post(
    "/api/prospecting/velvet-discovery/requests",
    deps.dashboardAuth,
    deps.requireOperator,
    deps.requireFullOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      if (!deps.dbEnabled) {
        return res.status(503).json({
          error: "Durable storage is required.",
          code: "VELVET_DISCOVERY_STORAGE_REQUIRED",
        });
      }
      const parsed = prepareSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid Velvet discovery request.",
          code: "VELVET_DISCOVERY_PREPARE_INVALID",
        });
      }
      const workspaceId = deps.getWorkspaceId(req);
      const requestedAt = now();
      if (!Number.isFinite(requestedAt.getTime())) {
        return res.status(503).json({
          error: "The discovery request clock is unavailable.",
          code: "VELVET_DISCOVERY_CLOCK_INVALID",
        });
      }
      const requestId = `smirk-discovery-${randomUUID()}`;
      const payload = buildVelvetDiscoveryRequest({
        requestId,
        workspaceId,
        criteria: parsed.data.criteria,
      });
      const payloadHash = hashVelvetDiscoveryValue(payload);
      const expiresAt = new Date(
        requestedAt.getTime() + APPROVAL_TTL_MS
      ).toISOString();
      const actor = actorForRequest(req);

      try {
        const inserted = await deps.sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          const rows = await tx<{ id: number }[]>`
            INSERT INTO velvet_discovery_requests (
              request_id, workspace_id, state, criteria, request_payload,
              request_payload_hash, prepared_by, expires_at
            ) VALUES (
              ${requestId}, ${workspaceId}, ${"PREPARED"},
              ${tx.json(parsed.data.criteria)}, ${tx.json(payload)},
              ${payloadHash}, ${actor}, ${expiresAt}
            )
            RETURNING id
          `;
          const id = Number(rows[0]?.id || 0);
          if (!id) {
            throw new VelvetDiscoveryRouteError(
              "The discovery request receipt was not created.",
              500,
              "VELVET_DISCOVERY_PREPARE_FAILED"
            );
          }
          await writeDiscoveryEvent(tx, {
            workspaceId,
            requestRowId: id,
            fromState: null,
            toState: "PREPARED",
            actor,
            payloadHash,
            details: {
              contactActionAllowed: false,
              spendAuthorized: false,
            },
          });
          return { id };
        });
        return res.status(201).json({
          id: inserted.id,
          requestId,
          state: "PREPARED",
          payloadHash,
          expiresAt,
          contactActionAllowed: false,
          spendAuthorized: false,
          externalAction: "none",
        });
      } catch (error) {
        const mapped = routeError(
          error,
          "The Velvet discovery request could not be prepared.",
          "VELVET_DISCOVERY_PREPARE_FAILED"
        );
        return res.status(mapped.status).json(mapped.body);
      }
    }
  );

  app.post(
    "/api/prospecting/velvet-discovery/requests/:id/approve",
    deps.dashboardAuth,
    deps.requireOperator,
    deps.requireFullOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      const requestRowId = parsePositiveId(req.params.id);
      const parsed = approveSchema.safeParse(req.body);
      if (!requestRowId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid Velvet discovery approval.",
          code: "VELVET_DISCOVERY_APPROVAL_INVALID",
        });
      }
      if (!deps.dbEnabled) {
        return res.status(503).json({
          error: "Durable storage is required.",
          code: "VELVET_DISCOVERY_STORAGE_REQUIRED",
        });
      }
      const workspaceId = deps.getWorkspaceId(req);
      const actor = actorForRequest(req);
      const approvedAt = now();
      if (!Number.isFinite(approvedAt.getTime())) {
        return res.status(503).json({
          error: "The discovery approval clock is unavailable.",
          code: "VELVET_DISCOVERY_CLOCK_INVALID",
        });
      }

      try {
        const result = await deps.sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          const row = await loadRequest(tx, requestRowId, workspaceId);
          assertStoredRequest(row, parsed.data.payloadHash);
          if (row.state === "APPROVED") {
            return { state: "APPROVED" as const, replay: true };
          }
          if (row.state !== "PREPARED") {
            throw new VelvetDiscoveryRouteError(
              `A ${row.state} discovery request cannot be approved.`,
              409,
              "VELVET_DISCOVERY_APPROVAL_STATE_CONFLICT"
            );
          }
          if (
            checkedTime(
              row.expires_at,
              "The stored discovery expiration"
            ).getTime() <= approvedAt.getTime()
          ) {
            const expired = await tx<{ id: number }[]>`
              UPDATE velvet_discovery_requests
              SET state = ${"EXPIRED"}, completed_at = NOW(),
                  updated_at = NOW()
              WHERE id = ${row.id}
                AND workspace_id = ${workspaceId}
                AND state = ${"PREPARED"}
              RETURNING id
            `;
            if (!expired[0]) {
              throw new VelvetDiscoveryRouteError(
                "The discovery request changed before expiration.",
                409,
                "VELVET_DISCOVERY_APPROVAL_RACE"
              );
            }
            await writeDiscoveryEvent(tx, {
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
            UPDATE velvet_discovery_requests
            SET state = ${"APPROVED"}, approved_by = ${actor},
                approved_at = ${approvedAt.toISOString()},
                approval_attestations = ${tx.json(parsed.data.attestations)},
                updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = ${"PREPARED"}
            RETURNING id
          `;
          if (!updated[0]) {
            throw new VelvetDiscoveryRouteError(
              "The discovery request changed before approval.",
              409,
              "VELVET_DISCOVERY_APPROVAL_RACE"
            );
          }
          await writeDiscoveryEvent(tx, {
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
            error: "The discovery request expired before approval.",
            code: "VELVET_DISCOVERY_REQUEST_EXPIRED",
            externalAction: "none",
          });
        }
        return res.json({
          id: requestRowId,
          ...result,
          contactActionAllowed: false,
          spendAuthorized: false,
          externalAction: "none",
        });
      } catch (error) {
        const mapped = routeError(
          error,
          "The Velvet discovery request could not be approved.",
          "VELVET_DISCOVERY_APPROVAL_FAILED"
        );
        return res.status(mapped.status).json(mapped.body);
      }
    }
  );

  app.post(
    "/api/prospecting/velvet-discovery/requests/:id/cancel",
    deps.dashboardAuth,
    deps.requireOperator,
    deps.requireFullOperator,
    async (req: Request, res: Response) => {
      const requestRowId = parsePositiveId(req.params.id);
      const parsed = cancelSchema.safeParse(req.body);
      if (!requestRowId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid Velvet discovery cancellation.",
          code: "VELVET_DISCOVERY_CANCEL_INVALID",
        });
      }
      if (!deps.dbEnabled) {
        return res.status(503).json({
          error: "Durable storage is required.",
          code: "VELVET_DISCOVERY_STORAGE_REQUIRED",
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
            throw new VelvetDiscoveryRouteError(
              `A ${row.state} discovery request cannot be cancelled locally.`,
              409,
              "VELVET_DISCOVERY_CANCEL_STATE_CONFLICT"
            );
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE velvet_discovery_requests
            SET state = ${"CANCELLED"}, last_error = ${parsed.data.reason},
                completed_at = NOW(), updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = ${row.state}
            RETURNING id
          `;
          if (!updated[0]) {
            throw new VelvetDiscoveryRouteError(
              "The discovery request changed before cancellation.",
              409,
              "VELVET_DISCOVERY_CANCEL_RACE"
            );
          }
          await writeDiscoveryEvent(tx, {
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
        const mapped = routeError(
          error,
          "The Velvet discovery request could not be cancelled.",
          "VELVET_DISCOVERY_CANCEL_FAILED"
        );
        return res.status(mapped.status).json(mapped.body);
      }
    }
  );

  app.post(
    "/api/prospecting/velvet-discovery/requests/:id/dispatch",
    deps.dashboardAuth,
    deps.requireOperator,
    deps.requireFullOperator,
    async (req: Request, res: Response) => {
      const requestRowId = parsePositiveId(req.params.id);
      const parsed = dispatchSchema.safeParse(req.body);
      if (!requestRowId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid Velvet discovery dispatch.",
          code: "VELVET_DISCOVERY_DISPATCH_INVALID",
        });
      }
      if (!deps.dbEnabled) {
        return res.status(503).json({
          error: "Durable storage is required.",
          code: "VELVET_DISCOVERY_STORAGE_REQUIRED",
        });
      }
      const workspaceId = deps.getWorkspaceId(req);
      const config = readVelvetDiscoveryConfig(env);
      if (!config.configured) {
        return res.status(503).json({
          error: `Velvet discovery is not configured: ${config.missing.join(", ")}`,
          code: "VELVET_DISCOVERY_NOT_CONFIGURED",
        });
      }
      if (config.workspaceId !== workspaceId) {
        return res.status(403).json({
          error: "Velvet discovery is locked to another workspace.",
          code: "VELVET_DISCOVERY_WORKSPACE_LOCKED",
        });
      }
      const actor = actorForRequest(req);
      const requestedAt = now();
      if (!Number.isFinite(requestedAt.getTime())) {
        return res.status(503).json({
          error: "The discovery dispatch clock is unavailable.",
          code: "VELVET_DISCOVERY_CLOCK_INVALID",
        });
      }

      try {
        const claim = await deps.sql.begin(async (tx: SqlClient) => {
          await acquireProspectAcquisitionWorkspaceLock(
            tx,
            workspaceId
          );
          await tx`
            SELECT pg_advisory_xact_lock(1447842643, ${workspaceId})
          `;
          const row = await loadRequest(tx, requestRowId, workspaceId);
          const requestPayload = assertStoredRequest(
            row,
            parsed.data.payloadHash
          );
          if (row.state === "SUBMITTED") {
            assertStoredPreparedResponse(row, requestPayload);
            return {
              row,
              requestPayload,
              replay: true as const,
            };
          }
          if (!["APPROVED", "SENDING"].includes(row.state)) {
            throw new VelvetDiscoveryRouteError(
              `A ${row.state} discovery request cannot be dispatched.`,
              409,
              "VELVET_DISCOVERY_DISPATCH_STATE_CONFLICT"
            );
          }
          if (row.state === "APPROVED") {
            await assertProspectAcquisitionUnpaused(
              tx,
              workspaceId
            );
          }
          if (
            row.state === "APPROVED" &&
            checkedTime(
              row.expires_at,
              "The stored discovery expiration"
            ).getTime() <= requestedAt.getTime()
          ) {
            const expired = await tx<{ id: number }[]>`
              UPDATE velvet_discovery_requests
              SET state = ${"EXPIRED"}, completed_at = NOW(),
                  updated_at = NOW()
              WHERE id = ${row.id}
                AND workspace_id = ${workspaceId}
                AND state = ${"APPROVED"}
              RETURNING id
            `;
            if (!expired[0]) {
              throw new VelvetDiscoveryRouteError(
                "The discovery request changed before expiration.",
                409,
                "VELVET_DISCOVERY_DISPATCH_RACE"
              );
            }
            await writeDiscoveryEvent(tx, {
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
              replay: false as const,
              expired: true as const,
            };
          }
          if (
            row.state === "SENDING" &&
            !row.last_error &&
            row.dispatch_requested_at &&
            requestedAt.getTime() <
              checkedTime(
                row.dispatch_requested_at,
                "The stored discovery dispatch lease"
              ).getTime() +
                DISPATCH_LEASE_MS
          ) {
            throw new VelvetDiscoveryRouteError(
              "This exact discovery request is already being dispatched.",
              409,
              "VELVET_DISCOVERY_DISPATCH_IN_PROGRESS"
            );
          }
          if (row.attempts >= MAX_DISPATCH_ATTEMPTS) {
            throw new VelvetDiscoveryRouteError(
              "The maximum exact dispatch attempts were reached; reconcile the remote request manually.",
              409,
              "VELVET_DISCOVERY_MAX_ATTEMPTS"
            );
          }
          const fromState = row.state;
          const updated = await tx<{ id: number }[]>`
            UPDATE velvet_discovery_requests
            SET state = ${"SENDING"}, attempts = attempts + 1,
                dispatch_requested_by = ${actor},
                dispatch_requested_at = ${requestedAt.toISOString()},
                dispatch_response_at = NULL, last_error = NULL,
                updated_at = NOW()
            WHERE id = ${row.id}
              AND workspace_id = ${workspaceId}
              AND state = ${fromState}
            RETURNING id
          `;
          if (!updated[0]) {
            throw new VelvetDiscoveryRouteError(
              "The discovery request changed before dispatch.",
              409,
              "VELVET_DISCOVERY_DISPATCH_RACE"
            );
          }
          await writeDiscoveryEvent(tx, {
            workspaceId,
            requestRowId: row.id,
            fromState,
            toState: "SENDING",
            actor,
            payloadHash: row.request_payload_hash,
            details: { attempt: row.attempts + 1 },
          });
          row.state = "SENDING";
          row.attempts += 1;
          row.last_error = null;
          row.dispatch_requested_at = requestedAt.toISOString();
          return {
            row,
            requestPayload,
            replay: false as const,
            expired: false as const,
          };
        });

        if ("expired" in claim && claim.expired) {
          return res.status(409).json({
            id: claim.row.id,
            state: "EXPIRED",
            error: "The discovery request expired before dispatch.",
            code: "VELVET_DISCOVERY_REQUEST_EXPIRED",
            externalAction: "none",
          });
        }
        if (claim.replay) {
          return res.json({
            id: claim.row.id,
            state: "SUBMITTED",
            remoteState: claim.row.remote_state,
            remoteDiscoveryId: claim.row.remote_discovery_id,
            replay: true,
            contactActionAllowed: false,
            spendAuthorized: false,
            externalAction: "discovery_status_only",
          });
        }

        const remote = await prepareVelvetDiscovery(
          claim.requestPayload,
          config,
          fetchImpl
        );
        if (remote.success === false) {
          const nextState = remote.retryable ? "SENDING" : "FAILED";
          await deps.sql.begin(async (tx: SqlClient) => {
            const updated = await tx<{ id: number }[]>`
              UPDATE velvet_discovery_requests
              SET state = ${nextState},
                  last_error = ${`${remote.code}: ${remote.error}`.slice(0, 2_000)},
                  dispatch_response_at = ${
                    remote.httpStatus
                      ? requestedAt.toISOString()
                      : null
                  },
                  completed_at = ${
                    nextState === "FAILED"
                      ? requestedAt.toISOString()
                      : null
                  },
                  updated_at = NOW()
              WHERE id = ${claim.row.id}
                AND workspace_id = ${workspaceId}
                AND state = ${"SENDING"}
              RETURNING id
            `;
            if (!updated[0]) {
              throw new VelvetDiscoveryRouteError(
                "The discovery request changed before its failure receipt was stored.",
                409,
                "VELVET_DISCOVERY_DISPATCH_RACE"
              );
            }
            if (nextState === "FAILED") {
              await writeDiscoveryEvent(tx, {
                workspaceId,
                requestRowId: claim.row.id,
                fromState: "SENDING",
                toState: "FAILED",
                actor,
                payloadHash: claim.row.request_payload_hash,
                details: {
                  code: remote.code,
                  httpStatus: remote.httpStatus,
                },
              });
            }
          });
          return res.status(remote.retryable ? 503 : 502).json({
            id: claim.row.id,
            state: nextState,
            code: remote.code,
            error: remote.error,
            retryable: remote.retryable,
            externalAction: remote.retryable
              ? "velvet_discovery_unknown"
              : "blocked",
          });
        }

        const responseHash = hashVelvetDiscoveryValue(remote.response);
        const stored = await deps.sql.begin(async (tx: SqlClient) => {
          const updated = await tx<{ id: number }[]>`
            UPDATE velvet_discovery_requests
            SET state = ${"SUBMITTED"},
                remote_discovery_id = ${remote.response.discoveryId},
                remote_state = ${remote.response.currentState},
                remote_prepared_response = ${tx.json(remote.response)},
                remote_prepared_hash = ${responseHash},
                quote_payload = ${tx.json(remote.response.quote)},
                quote_payload_hash = ${remote.response.quotePayloadHash},
                effective_criteria = ${
                  tx.json(remote.response.effectiveCriteria)
                },
                dispatch_response_at = ${requestedAt.toISOString()},
                last_error = NULL, updated_at = NOW()
            WHERE id = ${claim.row.id}
              AND workspace_id = ${workspaceId}
              AND state = ${"SENDING"}
            RETURNING id
          `;
          if (!updated[0]) {
            throw new VelvetDiscoveryRouteError(
              "The discovery request changed before the Velvet receipt was stored.",
              409,
              "VELVET_DISCOVERY_DISPATCH_RACE"
            );
          }
          await writeDiscoveryEvent(tx, {
            workspaceId,
            requestRowId: claim.row.id,
            fromState: "SENDING",
            toState: "SUBMITTED",
            actor,
            payloadHash: claim.row.request_payload_hash,
            details: {
              remoteDiscoveryId: remote.response.discoveryId,
              remoteState: remote.response.currentState,
              remotePreparedHash: responseHash,
              quotePayloadHash: remote.response.quotePayloadHash,
            },
          });
          return updated[0];
        });
        if (!stored) {
          throw new VelvetDiscoveryRouteError(
            "The submitted discovery receipt was not persisted.",
            500,
            "VELVET_DISCOVERY_DISPATCH_FAILED"
          );
        }
        return res.json({
          id: claim.row.id,
          state: "SUBMITTED",
          remoteState: remote.response.currentState,
          remoteDiscoveryId: remote.response.discoveryId,
          quote: remote.response.quote,
          approvalRequiredInVelvet: remote.response.approvalRequired,
          contactActionAllowed: false,
          spendAuthorized: false,
          externalAction:
            remote.response.currentState === "PREPARED"
              ? "velvet_admin_approval_required"
              : "discovery_status_only",
        });
      } catch (error) {
        const mapped = routeError(
          error,
          "The Velvet discovery request could not be dispatched.",
          "VELVET_DISCOVERY_DISPATCH_FAILED"
        );
        return res.status(mapped.status).json(mapped.body);
      }
    }
  );

  app.post(
    "/api/prospecting/velvet-discovery/requests/:id/refresh",
    deps.dashboardAuth,
    deps.requireOperator,
    deps.requireFullOperator,
    async (req: Request, res: Response) => {
      const requestRowId = parsePositiveId(req.params.id);
      const parsed = refreshSchema.safeParse(req.body);
      if (!requestRowId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid Velvet discovery status refresh.",
          code: "VELVET_DISCOVERY_REFRESH_INVALID",
        });
      }
      if (!deps.dbEnabled) {
        return res.status(503).json({
          error: "Durable storage is required.",
          code: "VELVET_DISCOVERY_STORAGE_REQUIRED",
        });
      }
      const workspaceId = deps.getWorkspaceId(req);
      const config = readVelvetDiscoveryConfig(env);
      if (!config.configured) {
        return res.status(503).json({
          error: `Velvet discovery is not configured: ${config.missing.join(", ")}`,
          code: "VELVET_DISCOVERY_NOT_CONFIGURED",
        });
      }
      if (config.workspaceId !== workspaceId) {
        return res.status(403).json({
          error: "Velvet discovery is locked to another workspace.",
          code: "VELVET_DISCOVERY_WORKSPACE_LOCKED",
        });
      }
      const actor = actorForRequest(req);
      const checkedAt = now();
      if (!Number.isFinite(checkedAt.getTime())) {
        return res.status(503).json({
          error: "The discovery status clock is unavailable.",
          code: "VELVET_DISCOVERY_CLOCK_INVALID",
        });
      }

      try {
        const loaded = await deps.sql.begin(async (tx: SqlClient) => {
          const row = await loadRequest(tx, requestRowId, workspaceId);
          const requestPayload = assertStoredRequest(
            row,
            parsed.data.payloadHash
          );
          if (row.state !== "SUBMITTED") {
            throw new VelvetDiscoveryRouteError(
              `A ${row.state} discovery request has no confirmed remote status to refresh.`,
              409,
              "VELVET_DISCOVERY_REFRESH_STATE_CONFLICT"
            );
          }
          assertStoredPreparedResponse(row, requestPayload);
          return { row, requestPayload };
        });

        const remote = await getVelvetDiscoveryStatus(
          loaded.requestPayload,
          config,
          fetchImpl
        );
        if (remote.success === false) {
          const stored = await deps.sql<{ id: number }[]>`
            UPDATE velvet_discovery_requests
            SET last_error = ${`${remote.code}: ${remote.error}`.slice(0, 2_000)},
                status_checked_by = ${actor},
                status_checked_at = ${checkedAt.toISOString()},
                updated_at = NOW()
            WHERE id = ${loaded.row.id}
              AND workspace_id = ${workspaceId}
              AND state = ${"SUBMITTED"}
            RETURNING id
          `;
          if (!stored[0]) {
            throw new VelvetDiscoveryRouteError(
              "The discovery status failure receipt was not stored.",
              409,
              "VELVET_DISCOVERY_REFRESH_RACE"
            );
          }
          return res.status(remote.retryable ? 503 : 502).json({
            id: loaded.row.id,
            state: "SUBMITTED",
            remoteState: loaded.row.remote_state,
            code: remote.code,
            error: remote.error,
            retryable: remote.retryable,
            externalAction: "discovery_status_unknown",
          });
        }
        if (
          remote.response.discoveryId !==
            loaded.row.remote_discovery_id ||
          remote.response.quotePayloadHash !==
            loaded.row.quote_payload_hash
        ) {
          throw new VelvetDiscoveryRouteError(
            "The refreshed discovery status conflicts with the submitted receipt.",
            409,
            "VELVET_DISCOVERY_REFRESH_MISMATCH"
          );
        }
        const statusHash = hashVelvetDiscoveryValue(remote.response);
        const terminal = [
          "COMPLETED",
          "EMPTY",
          "PARTIAL",
          "FAILED",
          "REJECTED",
          "CANCELLED",
          "EXPIRED",
        ].includes(remote.response.state);
        await deps.sql.begin(async (tx: SqlClient) => {
          const current = await loadRequest(
            tx,
            loaded.row.id,
            workspaceId
          );
          if (
            current.state !== "SUBMITTED" ||
            current.remote_discovery_id !==
              remote.response.discoveryId ||
            current.quote_payload_hash !==
              remote.response.quotePayloadHash
          ) {
            throw new VelvetDiscoveryRouteError(
              "The discovery request changed before status storage.",
              409,
              "VELVET_DISCOVERY_REFRESH_RACE"
            );
          }
          const updated = await tx<{ id: number }[]>`
            UPDATE velvet_discovery_requests
            SET remote_state = ${remote.response.state},
                remote_status_response = ${tx.json(remote.response)},
                remote_status_hash = ${statusHash},
                created_lead_count = ${remote.response.createdLeadCount},
                ready_lead_count = ${remote.response.readyLeadCount},
                skipped_lead_count = ${remote.response.skippedLeadCount},
                failed_lead_count = ${remote.response.failedLeadCount},
                provider_requests = ${remote.response.providerRequests},
                approved_max_spend_cents = ${
                  remote.response.approvedMaxSpendCents
                },
                last_error = ${remote.response.error},
                status_checked_by = ${actor},
                status_checked_at = ${checkedAt.toISOString()},
                completed_at = ${
                  terminal ? checkedAt.toISOString() : null
                },
                updated_at = NOW()
            WHERE id = ${current.id}
              AND workspace_id = ${workspaceId}
              AND state = ${"SUBMITTED"}
            RETURNING id
          `;
          if (!updated[0]) {
            throw new VelvetDiscoveryRouteError(
              "The discovery status was not stored.",
              409,
              "VELVET_DISCOVERY_REFRESH_RACE"
            );
          }
          await writeDiscoveryEvent(tx, {
            workspaceId,
            requestRowId: current.id,
            fromState: "SUBMITTED",
            toState: "SUBMITTED",
            actor,
            payloadHash: current.request_payload_hash,
            details: {
              action: "status_refreshed",
              previousRemoteState: current.remote_state,
              remoteState: remote.response.state,
              statusHash,
              readyLeadCount: remote.response.readyLeadCount,
              contactActionAllowed: false,
            },
          });
        });
        return res.json({
          id: loaded.row.id,
          state: "SUBMITTED",
          remoteState: remote.response.state,
          readyLeadCount: remote.response.readyLeadCount,
          createdLeadCount: remote.response.createdLeadCount,
          failedLeadCount: remote.response.failedLeadCount,
          providerRequests: remote.response.providerRequests,
          approvedMaxSpendCents:
            remote.response.approvedMaxSpendCents,
          canPrepareImport:
            ["COMPLETED", "PARTIAL"].includes(
              remote.response.state
            ) && remote.response.readyLeadCount > 0,
          contactActionAllowed: false,
          externalAction: "discovery_status_only",
        });
      } catch (error) {
        const mapped = routeError(
          error,
          "The Velvet discovery status could not be refreshed.",
          "VELVET_DISCOVERY_REFRESH_FAILED"
        );
        return res.status(mapped.status).json(mapped.body);
      }
    }
  );

  app.post(
    "/api/prospecting/velvet-discovery/requests/:id/prepare-import",
    deps.dashboardAuth,
    deps.requireOperator,
    deps.requireFullOperator,
    requireAcquisitionUnpaused,
    async (req: Request, res: Response) => {
      const requestRowId = parsePositiveId(req.params.id);
      const parsed = importSchema.safeParse(req.body);
      if (!requestRowId || !parsed.success) {
        return res.status(400).json({
          error: "Invalid reviewed-import preparation.",
          code: "VELVET_DISCOVERY_IMPORT_INVALID",
        });
      }
      if (!deps.dbEnabled) {
        return res.status(503).json({
          error: "Durable storage is required.",
          code: "VELVET_DISCOVERY_STORAGE_REQUIRED",
        });
      }
      const workspaceId = deps.getWorkspaceId(req);
      const actor = actorForRequest(req);
      const preparedAt = now();
      if (!Number.isFinite(preparedAt.getTime())) {
        return res.status(503).json({
          error: "The reviewed-import clock is unavailable.",
          code: "VELVET_DISCOVERY_CLOCK_INVALID",
        });
      }

      try {
        const result = await deps.sql.begin(async (tx: SqlClient) => {
          await assertProspectAcquisitionMutationUnpaused(
            tx,
            workspaceId
          );
          await tx`
            SELECT pg_advisory_xact_lock(1447842644, ${workspaceId})
          `;
          const row = await loadRequest(tx, requestRowId, workspaceId);
          const discoveryRequest = assertStoredRequest(
            row,
            parsed.data.payloadHash
          );
          if (row.state !== "SUBMITTED") {
            throw new VelvetDiscoveryRouteError(
              `A ${row.state} discovery request cannot prepare an import.`,
              409,
              "VELVET_DISCOVERY_IMPORT_STATE_CONFLICT"
            );
          }
          assertStoredPreparedResponse(row, discoveryRequest);
          const status = assertStoredStatus(row, discoveryRequest);
          if (
            !["COMPLETED", "PARTIAL"].includes(status.state) ||
            status.readyLeadCount < 1
          ) {
            throw new VelvetDiscoveryRouteError(
              "The discovery has no completed reviewed inventory to import.",
              409,
              "VELVET_DISCOVERY_IMPORT_NOT_READY"
            );
          }
          const existing = await tx<
            Array<{
              id: number;
              request_id: string;
              state: string;
              request_payload_hash: string;
            }>
          >`
            SELECT id, request_id, state, request_payload_hash
            FROM velvet_lead_source_requests
            WHERE workspace_id = ${workspaceId}
              AND discovery_request_id = ${row.id}
            LIMIT 1
            FOR UPDATE
          `;
          if (existing[0]) {
            return {
              sourceRequestId: existing[0].id,
              sourceRequestExternalId: existing[0].request_id,
              sourceState: existing[0].state,
              sourcePayloadHash: existing[0].request_payload_hash,
              replay: true,
            };
          }
          const sourceRequestExternalId = `smirk-source-${randomUUID()}`;
          const sourcePayload = buildVelvetLeadSourceRequest({
            requestId: sourceRequestExternalId,
            workspaceId,
            sourceDiscoveryRequestId: discoveryRequest.requestId,
            criteria: {
              limit: Math.min(
                status.effectiveCriteria.limit,
                status.readyLeadCount
              ),
              category: status.effectiveCriteria.category,
              city: status.effectiveCriteria.city,
              state: status.effectiveCriteria.state,
              learningMode: "none",
            },
          });
          const sourcePayloadHash =
            hashVelvetLeadSourceValue(sourcePayload);
          const expiresAt = new Date(
            preparedAt.getTime() + APPROVAL_TTL_MS
          ).toISOString();
          const inserted = await tx<{ id: number }[]>`
            INSERT INTO velvet_lead_source_requests (
              request_id, workspace_id, state, criteria,
              request_payload, request_payload_hash, prepared_by,
              expires_at, discovery_request_id
            ) VALUES (
              ${sourceRequestExternalId}, ${workspaceId}, ${"PREPARED"},
              ${tx.json(sourcePayload.criteria)}, ${tx.json(sourcePayload)},
              ${sourcePayloadHash}, ${actor}, ${expiresAt}, ${row.id}
            )
            RETURNING id
          `;
          const sourceRequestId = Number(inserted[0]?.id || 0);
          if (!sourceRequestId) {
            throw new VelvetDiscoveryRouteError(
              "The reviewed lead pull was not prepared.",
              500,
              "VELVET_DISCOVERY_IMPORT_PREPARE_FAILED"
            );
          }
          await writeSourceEvent(tx, {
            workspaceId,
            requestRowId: sourceRequestId,
            actor,
            payloadHash: sourcePayloadHash,
            discoveryRequestId: row.id,
          });
          await writeDiscoveryEvent(tx, {
            workspaceId,
            requestRowId: row.id,
            fromState: "SUBMITTED",
            toState: "SUBMITTED",
            actor,
            payloadHash: row.request_payload_hash,
            details: {
              action: "reviewed_import_prepared",
              sourceRequestId,
              sourcePayloadHash,
              contactActionAllowed: false,
              maxSpendCents: 0,
            },
          });
          return {
            sourceRequestId,
            sourceRequestExternalId,
            sourceState: "PREPARED",
            sourcePayloadHash,
            replay: false,
          };
        });
        return res.status(result.replay ? 200 : 201).json({
          id: requestRowId,
          discoveryState: "SUBMITTED",
          ...result,
          contactActionAllowed: false,
          spendAuthorized: false,
          externalAction: "source_approval_required",
        });
      } catch (error) {
        const mapped = routeError(
          error,
          "The reviewed lead pull could not be prepared from discovery.",
          "VELVET_DISCOVERY_IMPORT_PREPARE_FAILED"
        );
        return res.status(mapped.status).json(mapped.body);
      }
    }
  );
}
