import type { Express, Request, RequestHandler, Response } from "express";
import type { Workspace } from "../saas.js";
import { activationIdentityForAuthMode } from "../activation-provenance.js";
import { digestExactProofCallTarget, normalizeExactProofCallTarget } from "../proof-call-binding.js";

type SqlClient = <T = any>(strings: TemplateStringsArray, ...values: any[]) => Promise<T>;

type WorkspaceActivationRouteDeps = {
  dashboardAuth: RequestHandler;
  sql: SqlClient;
  env: {
    TWILIO_PHONE_NUMBER?: string;
  };
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
  getWorkspaceId: (req: Request) => number;
  getWorkspaceById: (id: number) => Promise<Workspace | null>;
  updateWorkspace: (id: number, data: Partial<Workspace>) => Promise<void>;
  createActivationEvent: (data: {
    workspace_id?: number | null;
    provisioning_request_id?: number | null;
    event_type: string;
    status?: "open" | "blocked" | "complete" | "info";
    actor?: "customer" | "operator" | "system";
    detail?: Record<string, unknown>;
  }) => Promise<{ id: number }>;
  listActivationEvents: (workspaceId: number, limit?: number) => Promise<unknown[]>;
  recordActivationStageEvent: (input: {
    workspaceId: number;
    provisioningRequestId?: number | null;
    activationStatus: { stage: string; [key: string]: unknown };
  }) => Promise<void>;
  buildProofFreshness: (latestAt: string | Date | null | undefined, completeProofCalls: number) => unknown;
  buildSetupReadiness: (input: {
    workspace: Workspace;
    workspaceTwilioNumber?: string | null;
    knowledgeSourceCount?: number;
    proofFreshness?: unknown;
  }) => { items: Array<{ key: string; complete: boolean }>; [key: string]: unknown };
  buildActivationStatus: (input: {
    workspace?: Workspace | null;
    provisioningRequest?: unknown;
    setupReadiness?: unknown;
    proofFreshness?: unknown;
    workspaceTwilioNumber?: string | null;
  }) => { readyForProofCall: boolean; stage: string; customerNextAction: string; [key: string]: unknown };
  maskPhoneForResponse: (value?: string | null) => string | null;
  workspaceProfileCache: { delete: (workspaceId: number) => void };
};

export function registerWorkspaceActivationRoutes(app: Express, deps: WorkspaceActivationRouteDeps): void {
  const {
    dashboardAuth,
    sql,
    env,
    log,
    getWorkspaceId,
    getWorkspaceById,
    updateWorkspace,
    createActivationEvent,
    listActivationEvents,
    recordActivationStageEvent,
    buildProofFreshness,
    buildSetupReadiness,
    buildActivationStatus,
    maskPhoneForResponse,
    workspaceProfileCache,
  } = deps;

  app.post("/api/workspace/proof-call/request", dashboardAuth, async (req: Request, res: Response) => {
    try {
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const body = (req.body || {}) as { proof_call_target?: string; notes?: string };
      const requestedTarget = String(body.proof_call_target || "").trim();
      const activationIdentity = activationIdentityForAuthMode((req as any).authMode);
      const exactProvisioningRows = await sql<{ id: number }[]>`
        SELECT id
        FROM provisioning_requests
        WHERE workspace_id = ${id}
        ORDER BY
          CASE WHEN source = 'stripe_checkout_completed' THEN 0 ELSE 1 END,
          created_at DESC,
          id DESC
        LIMIT 1
      `;
      const provisioningRequestId = Number(exactProvisioningRows[0]?.id || 0) || null;
      const activeClaimRows = await sql<{ id: number; status: string; proof_request_event_id: string | null }[]>`
        SELECT id, status, detail ->> 'proof_request_event_id' AS proof_request_event_id
        FROM activation_events
        WHERE workspace_id = ${id}
          AND event_type IN ('proof_call_dispatch_claimed', 'proof_call_dispatched')
          AND status IN ('open', 'outcome_unknown', 'in_progress')
        ORDER BY created_at DESC, id DESC
        LIMIT 2
      `;
      if (activeClaimRows.length > 0) {
        const activeClaim = activeClaimRows[0];
        await createActivationEvent({
          workspace_id: id,
          provisioning_request_id: provisioningRequestId,
          event_type: "proof_call_request_blocked",
          status: "blocked",
          actor: activationIdentity.actor,
          detail: {
            auth_mode: activationIdentity.authMode,
            auth_provenance: activationIdentity.authProvenance,
            reason: "active_or_uncertain_proof_call_claim",
            active_claim_event_id: String(activeClaim.id),
            active_proof_request_event_id: activeClaim.proof_request_event_id,
            active_claim_status: activeClaim.status,
          },
        });
        return res.status(409).json({
          ok: false,
          error: "This workspace already has an active or uncertain proof-call attempt. Reconcile it before requesting another call.",
          reconciliation_required: true,
          active_claim_event_id: activeClaim.id,
          active_proof_request_id: Number(activeClaim.proof_request_event_id || 0) || null,
        });
      }
      await createActivationEvent({
        workspace_id: id,
        provisioning_request_id: provisioningRequestId,
        event_type: "proof_call_action_requested",
        status: "info",
        actor: activationIdentity.actor,
        detail: {
          auth_mode: activationIdentity.authMode,
          auth_provenance: activationIdentity.authProvenance,
          target_update_requested: Boolean(requestedTarget),
        },
      });
      if (requestedTarget) {
        const exactRequestedTarget = normalizeExactProofCallTarget(requestedTarget);
        if (!exactRequestedTarget) {
          return res.status(400).json({ ok: false, error: "proof_call_target must be one exact owner-approved E.164 number." });
        }
        await updateWorkspace(id, { proof_call_target: exactRequestedTarget });
        workspaceProfileCache.delete(id);
      }

      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      const [phoneRows, knowledgeSourceCountR, provisioningRows] = await Promise.all([
        sql<{ phone_number: string }[]>`
          SELECT phone_number
          FROM workspace_phone_numbers
          WHERE workspace_id = ${id} AND enabled = TRUE
          ORDER BY id DESC
          LIMIT 1
        `,
        sql`SELECT COUNT(*) as count FROM workspace_knowledge_sources WHERE workspace_id = ${id}`,
        sql`SELECT * FROM provisioning_requests WHERE workspace_id = ${id} ORDER BY created_at DESC LIMIT 1`,
      ]);
      const workspaceTwilioNumber = workspace.twilio_phone_number || phoneRows[0]?.phone_number || (id === 1 ? env.TWILIO_PHONE_NUMBER : null);
      // A new customer request is the start of a new proof attempt. Prior or
      // unrelated workspace calls must not make the request appear complete.
      const proofFreshness = buildProofFreshness(null, 0);
      const setupReadiness = buildSetupReadiness({
        workspace,
        workspaceTwilioNumber,
        knowledgeSourceCount: Number((knowledgeSourceCountR[0] as { count?: string | number } | undefined)?.count || 0),
        proofFreshness,
      });
      const activationStatus = buildActivationStatus({
        workspace,
        provisioningRequest: (provisioningRows as any[])[0] || null,
        setupReadiness,
        proofFreshness,
        workspaceTwilioNumber,
      });
      const missingItems = setupReadiness.items.filter((item) => !item.complete);
      const exactProofTarget = normalizeExactProofCallTarget(workspace.proof_call_target);
      const event = await createActivationEvent({
        workspace_id: id,
        provisioning_request_id: provisioningRequestId,
        event_type: activationStatus.readyForProofCall ? "proof_call_requested" : "proof_call_request_blocked",
        status: activationStatus.readyForProofCall ? "open" : "blocked",
        actor: activationIdentity.actor,
        detail: {
          activation_stage: activationStatus.stage,
          masked_target: maskPhoneForResponse(workspace.proof_call_target),
          proof_target_e164_sha256: activationStatus.readyForProofCall
            ? digestExactProofCallTarget(exactProofTarget)
            : null,
          proof_target_last4: exactProofTarget?.slice(-4) || null,
          missing_checklist_keys: missingItems.map((item) => item.key),
          notes: String(body.notes || "").trim().slice(0, 500) || null,
          auth_mode: activationIdentity.authMode,
          auth_provenance: activationIdentity.authProvenance,
        },
      });
      const responseBody = {
        ok: activationStatus.readyForProofCall,
        request_id: event.id,
        status: activationStatus.readyForProofCall ? "proof_call_requested" : "proof_call_blocked",
        activation_status: activationStatus,
        masked_target: maskPhoneForResponse(workspace.proof_call_target),
        missing_items: missingItems,
        next_action: activationStatus.readyForProofCall
          ? "SMIRK support can run the guarded proof call after readiness is rechecked."
          : activationStatus.customerNextAction,
        command_hint: activationStatus.readyForProofCall
          ? `First run npm run check:real-call-readiness -- <safe-number>; only after readiness passes and APPROVE_SMIRK_REAL_PROOF_CALL names that exact E.164 target, bind the run to this customer request with SMIRK_PROOF_WORKSPACE_ID=${id} SMIRK_PROOF_REQUEST_ID=${event.id}, then run CONFIRM_SMIRK_REAL_PROOF_CALL=place-one-smirk-real-proof-call CONFIRM_SMIRK_REAL_PROOF_CALL_TARGET='<exact-approved-e164>' npm run -s proof:real-call -- '<exact-approved-e164>'.`
          : null,
      };
      return res.status(activationStatus.readyForProofCall ? 202 : 409).json(responseBody);
    } catch (err: any) {
      log("error", "POST /api/workspace/proof-call/request failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/workspace/activation-events", dashboardAuth, async (req: Request, res: Response) => {
    try {
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const limit = Number(req.query.limit || 25);
      const events = await listActivationEvents(id, Number.isFinite(limit) ? limit : 25);
      return res.json({ ok: true, events });
    } catch (err: any) {
      log("error", "GET /api/workspace/activation-events failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/workspace/activation-status", dashboardAuth, async (req: Request, res: Response) => {
    try {
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      const [phoneRows, knowledgeSourceCountR, linkedProofCallsR, provisioningRows] = await Promise.all([
        sql<{ phone_number: string }[]>`
          SELECT phone_number
          FROM workspace_phone_numbers
          WHERE workspace_id = ${id} AND enabled = TRUE
          ORDER BY id DESC
          LIMIT 1
        `,
        sql`SELECT COUNT(*) as count FROM workspace_knowledge_sources WHERE workspace_id = ${id}`,
        sql`
          SELECT COUNT(DISTINCT c.call_sid) as count, MAX(c.started_at) as latest_at
          FROM activation_events request
          JOIN activation_events dispatch
            ON dispatch.workspace_id = request.workspace_id
           AND dispatch.provisioning_request_id IS NOT DISTINCT FROM request.provisioning_request_id
           AND dispatch.event_type = 'proof_call_dispatched'
           AND dispatch.status = 'complete'
           AND dispatch.actor = 'system'
           AND dispatch.detail ->> 'proof_request_event_id' = request.id::text
          JOIN calls c
            ON c.call_sid = dispatch.detail ->> 'call_sid'
           AND c.workspace_id = request.workspace_id
          JOIN call_summaries cs ON cs.call_sid = c.call_sid
          JOIN tasks t ON t.call_sid = c.call_sid AND t.task_type IN ('callback', 'follow_up', 'handoff', 'escalate_to_human')
          JOIN call_events ce ON ce.call_sid = c.call_sid AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
          WHERE request.id = (
            SELECT latest.id
            FROM activation_events latest
            WHERE latest.workspace_id = ${id}
              AND latest.event_type = 'proof_call_requested'
              AND latest.status IN ('open', 'complete')
              AND latest.actor = 'customer'
              AND latest.detail ->> 'auth_mode' = 'workspace'
              AND latest.detail ->> 'auth_provenance' = 'workspace_bearer_token'
            ORDER BY latest.created_at DESC, latest.id DESC
            LIMIT 1
          )
        `,
        sql`SELECT * FROM provisioning_requests WHERE workspace_id = ${id} ORDER BY created_at DESC LIMIT 1`,
      ]);
      const workspaceTwilioNumber = workspace.twilio_phone_number || phoneRows[0]?.phone_number || (id === 1 ? env.TWILIO_PHONE_NUMBER : null);
      const completeProofCalls = Number((linkedProofCallsR[0] as { count?: string | number } | undefined)?.count || 0);
      const proofFreshness = buildProofFreshness((linkedProofCallsR[0] as { latest_at?: string | Date | null } | undefined)?.latest_at, completeProofCalls);
      const setupReadiness = buildSetupReadiness({
        workspace,
        workspaceTwilioNumber,
        knowledgeSourceCount: Number((knowledgeSourceCountR[0] as { count?: string | number } | undefined)?.count || 0),
        proofFreshness,
      });
      const latestProvisioningRequest = (provisioningRows as any[])[0] || null;
      const activationStatus = buildActivationStatus({
        workspace,
        provisioningRequest: latestProvisioningRequest,
        setupReadiness,
        proofFreshness,
        workspaceTwilioNumber,
      });
      await recordActivationStageEvent({
        workspaceId: id,
        provisioningRequestId: latestProvisioningRequest?.id || null,
        activationStatus,
      });
      return res.json({
        ok: true,
        activation_status: activationStatus,
        setup_readiness: setupReadiness,
        proof_freshness: proofFreshness,
      });
    } catch (err: any) {
      log("error", "GET /api/workspace/activation-status failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });
}
