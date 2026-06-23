import type { Express, Request, RequestHandler, Response } from "express";
import type { Workspace } from "../saas.js";

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
      if (requestedTarget) {
        const digitCount = requestedTarget.replace(/\D/g, "").length;
        if (digitCount < 7) {
          return res.status(400).json({ ok: false, error: "proof_call_target must be a real owner-approved phone number." });
        }
        await updateWorkspace(id, { proof_call_target: requestedTarget });
        workspaceProfileCache.delete(id);
      }

      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      const [phoneRows, knowledgeSourceCountR, completeProofCallsR, latestCompleteProofCallR, provisioningRows] = await Promise.all([
        sql<{ phone_number: string }[]>`
          SELECT phone_number
          FROM workspace_phone_numbers
          WHERE workspace_id = ${id} AND enabled = TRUE
          ORDER BY id DESC
          LIMIT 1
        `,
        sql`SELECT COUNT(*) as count FROM workspace_knowledge_sources WHERE workspace_id = ${id}`,
        sql`
          SELECT COUNT(DISTINCT c.call_sid) as count
          FROM calls c
          JOIN call_summaries cs ON cs.call_sid = c.call_sid
          JOIN tasks t ON t.call_sid = c.call_sid AND t.task_type IN ('callback', 'handoff', 'escalate_to_human')
          JOIN call_events ce ON ce.call_sid = c.call_sid AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
          WHERE c.workspace_id = ${id}
        `,
        sql`
          SELECT MAX(c.started_at) as latest_at
          FROM calls c
          JOIN call_summaries cs ON cs.call_sid = c.call_sid
          JOIN tasks t ON t.call_sid = c.call_sid AND t.task_type IN ('callback', 'handoff', 'escalate_to_human')
          JOIN call_events ce ON ce.call_sid = c.call_sid AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
          WHERE c.workspace_id = ${id}
        `,
        sql`SELECT * FROM provisioning_requests WHERE workspace_id = ${id} ORDER BY created_at DESC LIMIT 1`,
      ]);
      const workspaceTwilioNumber = workspace.twilio_phone_number || phoneRows[0]?.phone_number || (id === 1 ? env.TWILIO_PHONE_NUMBER : null);
      const completeProofCalls = Number((completeProofCallsR[0] as { count?: string | number } | undefined)?.count || 0);
      const proofFreshness = buildProofFreshness((latestCompleteProofCallR[0] as { latest_at?: string | Date | null } | undefined)?.latest_at, completeProofCalls);
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
      const event = await createActivationEvent({
        workspace_id: id,
        provisioning_request_id: (provisioningRows as any[])[0]?.id || null,
        event_type: activationStatus.readyForProofCall ? "proof_call_requested" : "proof_call_request_blocked",
        status: activationStatus.readyForProofCall ? "open" : "blocked",
        actor: "customer",
        detail: {
          activation_stage: activationStatus.stage,
          masked_target: maskPhoneForResponse(workspace.proof_call_target),
          missing_checklist_keys: missingItems.map((item) => item.key),
          notes: String(body.notes || "").trim().slice(0, 500) || null,
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
          ? "First run npm run check:real-call-readiness -- <safe-number>; only after readiness passes, run npm run proof:real-call -- <safe-number>."
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
      const [phoneRows, knowledgeSourceCountR, completeProofCallsR, latestCompleteProofCallR, provisioningRows] = await Promise.all([
        sql<{ phone_number: string }[]>`
          SELECT phone_number
          FROM workspace_phone_numbers
          WHERE workspace_id = ${id} AND enabled = TRUE
          ORDER BY id DESC
          LIMIT 1
        `,
        sql`SELECT COUNT(*) as count FROM workspace_knowledge_sources WHERE workspace_id = ${id}`,
        sql`
          SELECT COUNT(DISTINCT c.call_sid) as count
          FROM calls c
          JOIN call_summaries cs ON cs.call_sid = c.call_sid
          JOIN tasks t ON t.call_sid = c.call_sid AND t.task_type IN ('callback', 'handoff', 'escalate_to_human')
          JOIN call_events ce ON ce.call_sid = c.call_sid AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
          WHERE c.workspace_id = ${id}
        `,
        sql`
          SELECT MAX(c.started_at) as latest_at
          FROM calls c
          JOIN call_summaries cs ON cs.call_sid = c.call_sid
          JOIN tasks t ON t.call_sid = c.call_sid AND t.task_type IN ('callback', 'handoff', 'escalate_to_human')
          JOIN call_events ce ON ce.call_sid = c.call_sid AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
          WHERE c.workspace_id = ${id}
        `,
        sql`SELECT * FROM provisioning_requests WHERE workspace_id = ${id} ORDER BY created_at DESC LIMIT 1`,
      ]);
      const workspaceTwilioNumber = workspace.twilio_phone_number || phoneRows[0]?.phone_number || (id === 1 ? env.TWILIO_PHONE_NUMBER : null);
      const completeProofCalls = Number((completeProofCallsR[0] as { count?: string | number } | undefined)?.count || 0);
      const proofFreshness = buildProofFreshness((latestCompleteProofCallR[0] as { latest_at?: string | Date | null } | undefined)?.latest_at, completeProofCalls);
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
