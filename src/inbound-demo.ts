import { randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";

type SqlClient = any;

export type InboundDemoInvite = {
  id: number;
  workspace_id: number;
  business_name: string;
  caller_phone: string;
  contact_name: string | null;
  industry: string | null;
  public_source_url: string | null;
  audit_hypothesis: string | null;
  status: "approved" | "called" | "completed" | "expired" | "opted_out";
  call_sid: string | null;
  handoff_id: number | null;
  task_id: number | null;
  created_at: string;
};

export type InboundDemoMatch = Pick<InboundDemoInvite,
  "id" | "workspace_id" | "business_name" | "contact_name" | "industry" | "public_source_url" | "audit_hypothesis" | "status"
>;

export type InboundDemoDossier = {
  inviteId: number;
  handoffId: number | null;
  taskId: number | null;
  businessName: string;
};

const normalizeUsPhone = (value: unknown): string | null => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15 && String(value || "").trim().startsWith("+")) return `+${digits}`;
  return null;
};

const cleanText = (value: unknown, max: number): string | null => {
  const clean = String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
  return clean || null;
};

export function buildInboundDemoGreeting(invite: InboundDemoMatch): string {
  return `You reached SMIRK's private demonstration for ${invite.business_name}. This is not ${invite.business_name}'s live line. I can show how SMIRK would capture a missed caller and send a callback-ready lead. Would you like to test an emergency request or an estimate request?`;
}

export function buildInboundDemoSystemContext(invite: InboundDemoMatch): string {
  const details = [
    `Named business: ${invite.business_name}.`,
    invite.industry ? `Industry: ${invite.industry}.` : null,
    invite.audit_hypothesis ? `Unverified operator audit hypothesis: ${invite.audit_hypothesis}` : null,
    invite.public_source_url ? `Public source recorded: ${invite.public_source_url}` : null,
  ].filter(Boolean).join(" ");

  return `[INBOUND_SMIRK_DEMO]
This caller voluntarily called a SMIRK product demonstration after an invitation. State clearly that this is a SMIRK demonstration, not the named business's live phone line. Never imply that the named business bought SMIRK, authorized representation, or promised the caller a callback. Run a realistic emergency-or-estimate intake demonstration, capture the caller's interest in missed-call recovery, and if they are interested say that a private summary and the $197 per month Starter setup link will be prepared. ${details}`;
}

export function createInboundDemoStore(sql: SqlClient) {
  return {
    async initSchema(): Promise<void> {
      await sql`
        CREATE TABLE IF NOT EXISTS inbound_demo_invites (
          id SERIAL PRIMARY KEY,
          workspace_id INTEGER NOT NULL,
          business_name TEXT NOT NULL,
          caller_phone TEXT NOT NULL,
          contact_name TEXT,
          industry TEXT,
          public_source_url TEXT,
          audit_hypothesis TEXT,
          invite_token TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'approved',
          call_sid TEXT,
          handoff_id INTEGER,
          task_id INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          called_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS inbound_demo_invites_workspace_phone_idx ON inbound_demo_invites (workspace_id, caller_phone)`;
      await sql`CREATE INDEX IF NOT EXISTS inbound_demo_invites_call_sid_idx ON inbound_demo_invites (call_sid)`;
    },

    async create(input: {
      workspaceId: number;
      businessName: string;
      callerPhone: string;
      contactName?: string | null;
      industry?: string | null;
      publicSourceUrl?: string | null;
      auditHypothesis?: string | null;
    }): Promise<InboundDemoInvite> {
      const callerPhone = normalizeUsPhone(input.callerPhone);
      const businessName = cleanText(input.businessName, 160);
      if (!Number.isSafeInteger(input.workspaceId) || input.workspaceId <= 0) throw new Error("A valid workspace is required.");
      if (!callerPhone) throw new Error("Caller phone must be a valid E.164 or North American phone number.");
      if (!businessName) throw new Error("Business name is required.");

      const rows = await sql<InboundDemoInvite[]>`
        INSERT INTO inbound_demo_invites (
          workspace_id, business_name, caller_phone, contact_name, industry,
          public_source_url, audit_hypothesis, invite_token, status, expires_at
        ) VALUES (
          ${input.workspaceId}, ${businessName}, ${callerPhone}, ${cleanText(input.contactName, 120)}, ${cleanText(input.industry, 80)},
          ${cleanText(input.publicSourceUrl, 700)}, ${cleanText(input.auditHypothesis, 600)}, ${randomUUID()}, 'approved', NOW() + INTERVAL '30 days'
        )
        RETURNING *
      `;
      return rows[0];
    },

    async list(workspaceId: number): Promise<InboundDemoInvite[]> {
      return sql<InboundDemoInvite[]>`
        SELECT * FROM inbound_demo_invites
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC
        LIMIT 200
      `;
    },

    async findActiveForCaller(workspaceId: number, callerPhone: string): Promise<InboundDemoMatch | null> {
      const normalizedPhone = normalizeUsPhone(callerPhone);
      if (!normalizedPhone) return null;
      const rows = await sql<InboundDemoMatch[]>`
        SELECT id, workspace_id, business_name, contact_name, industry, public_source_url, audit_hypothesis, status
        FROM inbound_demo_invites
        WHERE workspace_id = ${workspaceId}
          AND caller_phone = ${normalizedPhone}
          AND status = 'approved'
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return rows[0] || null;
    },

    async markCallStarted(inviteId: number, callSid: string): Promise<void> {
      await sql`
        UPDATE inbound_demo_invites
        SET status = 'called', call_sid = ${callSid}, called_at = NOW()
        WHERE id = ${inviteId} AND status = 'approved'
      `;
    },

    async finalizeCall(callSid: string): Promise<InboundDemoDossier | null> {
      return sql.begin(async (tx: SqlClient) => {
        const inviteRows = await tx<any[]>`
          SELECT i.*, c.contact_id, c.workspace_id, c.duration_seconds
          FROM inbound_demo_invites i
          JOIN calls c ON c.call_sid = i.call_sid
          WHERE i.call_sid = ${callSid}
          FOR UPDATE
        `;
        const invite = inviteRows[0];
        if (!invite) return null;

        let handoffId = invite.handoff_id ? Number(invite.handoff_id) : null;
        let taskId = invite.task_id ? Number(invite.task_id) : null;
        const notes = `SMIRK inbound demonstration completed for ${invite.business_name}. Review the call summary, confirm interest, and send the approved Starter setup link only after a human review.`;

        if (!handoffId) {
          const handoffRows = await tx<{ id: number }[]>`
            INSERT INTO handoffs (
              call_sid, contact_id, reason, urgency, transcript_snippet, recommended_action, notes, status, workspace_id
            ) VALUES (
              ${callSid}, ${invite.contact_id}, 'Inbound SMIRK product demonstration', 'normal',
              ${`Self-initiated demo for ${invite.business_name}.`},
              'Review intent and prepare the approved Starter setup link.', ${notes}, 'pending', ${invite.workspace_id}
            ) RETURNING id
          `;
          handoffId = Number(handoffRows[0]?.id || 0) || null;
        }

        if (!taskId) {
          const taskRows = await tx<{ id: number }[]>`
            INSERT INTO tasks (contact_id, call_sid, task_type, status, priority, notes, workspace_id)
            VALUES (${invite.contact_id}, ${callSid}, 'inbound_demo_follow_up', 'open', 'high', ${notes}, ${invite.workspace_id})
            RETURNING id
          `;
          taskId = Number(taskRows[0]?.id || 0) || null;
        }

        await tx`
          UPDATE inbound_demo_invites
          SET status = 'completed', completed_at = NOW(), handoff_id = ${handoffId}, task_id = ${taskId}
          WHERE id = ${invite.id}
        `;
        return { inviteId: Number(invite.id), handoffId, taskId, businessName: String(invite.business_name) };
      });
    },
  };
}

type InboundDemoRouteDeps = {
  dashboardAuth: (req: Request, res: Response, next: NextFunction) => void;
  requireOperator: (req: Request, res: Response, next: NextFunction) => void;
  dbEnabled: boolean;
  store: ReturnType<typeof createInboundDemoStore>;
};

export function registerInboundDemoRoutes(app: Express, deps: InboundDemoRouteDeps): void {
  const guard = [deps.dashboardAuth, deps.requireOperator];
  app.get("/api/operator/inbound-demo/invites", ...guard, async (req: Request, res: Response) => {
    if (!deps.dbEnabled) return res.status(503).json({ error: "Inbound demonstration records require the production database." });
    const workspaceId = Number(req.query.workspaceId || req.headers["x-workspace-id"] || 1);
    if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) return res.status(400).json({ error: "A valid workspaceId is required." });
    return res.json({ ok: true, invites: await deps.store.list(workspaceId) });
  });

  app.post("/api/operator/inbound-demo/invites", ...guard, async (req: Request, res: Response) => {
    if (!deps.dbEnabled) return res.status(503).json({ error: "Inbound demonstration records require the production database." });
    try {
      const body = req.body || {};
      const invite = await deps.store.create({
        workspaceId: Number(body.workspaceId || req.headers["x-workspace-id"] || 1),
        businessName: body.businessName,
        callerPhone: body.callerPhone,
        contactName: body.contactName,
        industry: body.industry,
        publicSourceUrl: body.publicSourceUrl,
        auditHypothesis: body.auditHypothesis,
      });
      return res.status(201).json({
        ok: true,
        invite,
        operatorNotice: "This invitation is a review record only. Do not send an automated AI call or SMS to this prospect. The prospect must self-initiate the disclosed SMIRK demonstration.",
      });
    } catch (error: any) {
      return res.status(400).json({ ok: false, error: error?.message || "Unable to create inbound demonstration invitation." });
    }
  });
}
