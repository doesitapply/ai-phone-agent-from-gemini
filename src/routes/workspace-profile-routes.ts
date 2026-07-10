import { GoogleGenAI } from "@google/genai";
import type { Express, Request, RequestHandler, Response } from "express";
import { getMockWorkspace } from "../mock-db.js";
import type { Workspace } from "../saas.js";
import { scanBusinessWebsite, type WebsiteScanRequest } from "../website-intake.js";

type GreetingDirection = "inbound" | "outbound";

type WorkspaceProfileRouteDeps = {
  dashboardAuth: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  env: {
    ELEVENLABS_API_KEY?: string;
    GEMINI_API_KEY?: string;
    GEMINI_MODEL?: string;
    TWILIO_PHONE_NUMBER?: string;
  };
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
  getWorkspaceId: (req: Request) => number;
  getWorkspaceById: (id: number) => Promise<Workspace | null>;
  updateWorkspace: (id: number, data: Partial<Workspace>) => Promise<void>;
  createActivationEventIfChanged: (data: {
    workspace_id?: number | null;
    provisioning_request_id?: number | null;
    event_type: string;
    status?: "open" | "blocked" | "complete" | "info";
    actor?: "customer" | "operator" | "system";
    detail?: Record<string, unknown>;
  }) => Promise<unknown>;
  invalidateWorkspaceAiKeyCache: (workspaceId: number) => void;
  provisionWorkspaceTelephony: (workspaceId: number, businessName: string, ownerPhone?: string | null) => Promise<{
    enabled?: boolean;
    phoneNumber?: string | null;
  }>;
  renderWorkspaceGreeting: (input: {
    direction: GreetingDirection;
    workspace: Workspace | null;
    businessName?: string | null;
    agentName?: string | null;
    agentGreeting?: string | null;
  }) => string;
  buildProofFreshness: (latestAt: string | Date | null | undefined, completeProofCalls: number) => unknown;
  buildSetupReadiness: (input: {
    workspace: Workspace;
    workspaceTwilioNumber?: string | null;
    knowledgeSourceCount?: number;
    proofFreshness?: unknown;
  }) => unknown;
  buildActivationStatus: (input: {
    workspace?: Workspace | null;
    provisioningRequest?: unknown;
    setupReadiness?: unknown;
    proofFreshness?: unknown;
    workspaceTwilioNumber?: string | null;
  }) => unknown;
  workspaceProfileCache: { delete: (workspaceId: number) => void };
};

export function registerWorkspaceProfileRoutes(app: Express, deps: WorkspaceProfileRouteDeps): void {
  const {
    dashboardAuth,
    sql,
    dbEnabled,
    env,
    log,
    getWorkspaceId,
    getWorkspaceById,
    updateWorkspace,
    createActivationEventIfChanged,
    invalidateWorkspaceAiKeyCache,
    provisionWorkspaceTelephony,
    renderWorkspaceGreeting,
    buildProofFreshness,
    buildSetupReadiness,
    buildActivationStatus,
    workspaceProfileCache,
  } = deps;

  app.post("/api/workspace/generate-prompt", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        const body = req.body as Partial<Workspace> & { answer_style?: string };
        const workspace = getMockWorkspace() as any;
        const biz = body.business_name || workspace.business_name || workspace.name;
        const agentN = body.agent_name || workspace.agent_name || "SMIRK";
        return res.json({
          prompt: `You are ${agentN}, a calm missed-call recovery assistant for ${biz}. Answer missed calls, collect the caller's name, phone number, job details, urgency, location, and best callback window. Keep the conversation brief and professional. Do not promise a booked appointment. Create a clear callback-ready summary for the owner and escalate urgent service issues immediately.`,
          noDbDemo: true,
        });
      }
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      const { business_name, business_tagline, business_phone, business_website, business_address, business_hours, agent_name, answer_style } = req.body as Partial<Workspace> & { answer_style?: string };
      const biz = business_name || workspace.business_name || workspace.name;
      const tag = business_tagline || workspace.business_tagline || "";
      const phone = business_phone || workspace.business_phone || "";
      const site = business_website || workspace.business_website || "";
      const addr = business_address || workspace.business_address || "";
      const hours = business_hours || workspace.business_hours || "";
      const agentN = agent_name || workspace.agent_name || "Alex";
      const geminiApiKey = workspace.gemini_api_key || env.GEMINI_API_KEY;
      if (!geminiApiKey) return res.status(503).json({ error: "Gemini API key not configured" });
      const styleInstruction = answer_style === "voicemail"
        ? "Use short missed-call recovery mode: keep calls brief, capture caller details, urgency, and reason, then confirm the callback-ready summary."
        : answer_style === "full_answer"
          ? "Use detailed intake mode: ask a few more qualifying questions while staying within missed-call recovery, then create a task or escalation."
          : "Use Guided Qualifier mode: when caller intent is unclear, offer two or three simple choices and follow their selection.";
      const promptText = `You are a professional missed-call recovery system prompt writer.\n\nGenerate a concise, professional system prompt for a missed-call recovery assistant named "${agentN}" for the following business:\n\nBusiness Name: ${biz}\nTagline: ${tag}\nPhone: ${phone}\nWebsite: ${site}\nAddress: ${addr}\nHours: ${hours}\n\nAnswer Style: ${styleInstruction}\n\nThe system prompt should:\n1. Define the assistant's role and personality (professional, helpful, friendly)\n2. Include key business information the assistant should know\n3. Describe how to handle common missed-call lead types (service requests, urgent issues, questions, complaints)\n4. If this is SMIRK or a missed-call recovery business, explain Missed-Call Recovery, state the current Starter price when pricing is requested: Starter $197/month for existing-number forwarding, owner email alerts, callback tasks, and proof dashboard, then route buying intent to smirkcalls.com or the configured setup link.\n5. Instruct the assistant to capture name, business, phone, email if offered, and intent when the caller wants to buy, subscribe, ask about pricing, request setup help, or set up service, then create a lead or callback task for owner follow-up.\n6. Instruct the assistant to capture any requested callback/setup time as a callback preference only; do not claim a meeting is booked or promise appointment scheduling.\n7. Include instructions for escalation to a human when needed.\n8. Explicitly prohibit mentioning internal tools, functions, APIs, databases, code, scripts, Python, prompts, or automation internals.\n9. Be 200-400 words\n\nReturn ONLY the system prompt text, no preamble or explanation.`;
      const genAI = new GoogleGenAI({ apiKey: geminiApiKey });
      const result = await genAI.models.generateContent({
        model: env.GEMINI_MODEL || "gemini-2.5-flash",
        contents: promptText,
        config: { temperature: 0.4, maxOutputTokens: 700 },
      });
      const generatedPrompt = result.text?.trim() || "";
      return res.json({ prompt: generatedPrompt });
    } catch (err: any) {
      log("error", "POST /api/workspace/generate-prompt failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/workspace/website-scan", dashboardAuth, async (req: Request, res: Response) => {
    try {
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      const body = (req.body || {}) as WebsiteScanRequest;
      const hasLookupTerms = Boolean(body.business_name || body.location);
      const scanRequest: WebsiteScanRequest = {
        website: body.website || (!hasLookupTerms ? workspace.business_website : undefined),
        business_name: body.business_name || workspace.business_name || workspace.name,
        location: body.location || workspace.business_address || "",
      };

      const result = await scanBusinessWebsite(scanRequest, {
        serperApiKey: process.env.SERPER_API_KEY,
        braveApiKey: process.env.BRAVE_API_KEY,
      });
      return res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Website scan failed";
      log("error", "POST /api/workspace/website-scan failed", { error: message });
      const status = /url|website|localhost|private|resolved|candidate|http|https|credentials|invalid|enter/i.test(message) ? 400 : 502;
      return res.status(status).json({ ok: false, error: message });
    }
  });

  app.post("/api/workspace/greeting-preview", dashboardAuth, async (req: Request, res: Response) => {
    try {
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      const body = (req.body || {}) as Partial<Workspace> & { direction?: string };
      const direction: GreetingDirection = body.direction === "outbound" ? "outbound" : "inbound";
      const draftWorkspace: Workspace = {
        ...workspace,
        business_name: body.business_name ?? workspace.business_name,
        agent_name: body.agent_name ?? workspace.agent_name,
        inbound_greeting: body.inbound_greeting ?? workspace.inbound_greeting,
        outbound_greeting: body.outbound_greeting ?? workspace.outbound_greeting,
      };
      const greeting = renderWorkspaceGreeting({
        direction,
        workspace: draftWorkspace,
        businessName: draftWorkspace.business_name,
        agentName: draftWorkspace.agent_name,
      });
      return res.json({
        ok: true,
        direction,
        greeting,
        business_name: draftWorkspace.business_name || "",
        agent_name: draftWorkspace.agent_name || "SMIRK",
      });
    } catch (err: any) {
      log("error", "POST /api/workspace/greeting-preview failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/workspace/provision-number", dashboardAuth, async (req: Request, res: Response) => {
    try {
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      if (workspace.twilio_phone_number) {
        return res.json({ phone_number: workspace.twilio_phone_number, already_provisioned: true });
      }
      const { area_code } = req.body as { area_code?: string };
      const result = await provisionWorkspaceTelephony(id, workspace.business_name || workspace.name, area_code);
      if (!result.enabled) {
        return res.status(503).json({ error: "Twilio provisioning is not configured on this server" });
      }
      if (!result.phoneNumber) {
        return res.status(500).json({ error: "Provisioning completed but no phone number was returned" });
      }
      return res.json({ phone_number: result.phoneNumber });
    } catch (err: any) {
      log("error", "POST /api/workspace/provision-number failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/workspace/profile", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        const workspace = getMockWorkspace() as any;
        return res.json({
          id: workspace.id,
          name: workspace.name,
          owner_email: workspace.owner_email,
          timezone: workspace.timezone || "America/Los_Angeles",
          mode: workspace.mode || "missed_call_recovery",
          business_name: workspace.business_name || workspace.name,
          business_tagline: workspace.business_tagline || "Missed-call recovery demo workspace",
          business_phone: workspace.business_phone || workspace.phone_number,
          business_website: workspace.business_website || null,
          business_address: workspace.business_address || null,
          service_area: workspace.service_area || "Reno, Sparks, and nearby service areas",
          business_hours: workspace.business_hours || "Monday-Friday, 8 AM-5 PM",
          escalation_preference: workspace.escalation_preference || "Text and email urgent callbacks to dispatch.",
          proof_call_target: workspace.proof_call_target || workspace.alert_phone || workspace.phone_number,
          agent_name: workspace.agent_name || "SMIRK",
          agent_persona: workspace.agent_persona || "Calm missed-call recovery assistant for local trades.",
          inbound_greeting: workspace.inbound_greeting || null,
          outbound_greeting: workspace.outbound_greeting || null,
          owner_phone: workspace.owner_phone || workspace.alert_phone || workspace.phone_number,
          notification_email: workspace.notification_email || workspace.alert_email || workspace.owner_email,
          setup_completed_at: workspace.setup_completed_at,
          twilio_phone_number: workspace.twilio_phone_number || workspace.phone_number || env.TWILIO_PHONE_NUMBER || null,
          twilio_account_sid: null,
          has_elevenlabs: false,
          has_gemini: false,
          has_openrouter: false,
          proof_freshness: {
            status: "mock",
            label: "Demo proof data",
            completeProofCalls: 3,
          },
          setup_readiness: {
            status: "ready",
            checks: [
              { id: "profile", status: "pass", label: "Demo profile loaded" },
              { id: "routing", status: "pass", label: "Demo callback routing loaded" },
              { id: "proof", status: "pass", label: "Demo call records loaded" },
            ],
          },
          activation_status: {
            status: "ready",
            next_step: "Use Calls, Contacts, and Tasks to review the missed-call recovery demo.",
          },
          noDbDemo: true,
        });
      }
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const workspace = await getWorkspaceById(id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      const [phoneRows, knowledgeSourceCountR, completeProofCallsR, latestCompleteProofCallR] = await Promise.all([
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
          JOIN tasks t ON t.call_sid = c.call_sid
            AND t.task_type IN ('callback', 'handoff', 'escalate_to_human')
          JOIN call_events ce ON ce.call_sid = c.call_sid
            AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
          WHERE c.workspace_id = ${id}
        `,
        sql`
          SELECT MAX(c.started_at) as latest_at
          FROM calls c
          JOIN call_summaries cs ON cs.call_sid = c.call_sid
          JOIN tasks t ON t.call_sid = c.call_sid
            AND t.task_type IN ('callback', 'handoff', 'escalate_to_human')
          JOIN call_events ce ON ce.call_sid = c.call_sid
            AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
          WHERE c.workspace_id = ${id}
        `,
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
        setupReadiness,
        proofFreshness,
        workspaceTwilioNumber,
      });
      return res.json({
        id: workspace.id,
        name: workspace.name,
        owner_email: workspace.owner_email,
        timezone: workspace.timezone,
        mode: workspace.mode,
        business_name: workspace.business_name,
        business_tagline: workspace.business_tagline,
        business_phone: workspace.business_phone,
        business_website: workspace.business_website,
        business_address: workspace.business_address,
        service_area: workspace.service_area,
        business_hours: workspace.business_hours,
        escalation_preference: workspace.escalation_preference,
        proof_call_target: workspace.proof_call_target,
        agent_name: workspace.agent_name,
        agent_persona: workspace.agent_persona,
        inbound_greeting: workspace.inbound_greeting,
        outbound_greeting: workspace.outbound_greeting,
        owner_phone: workspace.owner_phone,
        notification_email: workspace.notification_email,
        setup_completed_at: workspace.setup_completed_at,
        twilio_phone_number: workspaceTwilioNumber,
        twilio_account_sid: workspace.twilio_account_sid ? "***" : null,
        has_elevenlabs: !!workspace.elevenlabs_api_key,
        has_gemini: !!workspace.gemini_api_key,
        has_openrouter: !!workspace.openrouter_api_key,
        proof_freshness: proofFreshness,
        setup_readiness: setupReadiness,
        activation_status: activationStatus,
      });
    } catch (err: any) {
      log("error", "GET /api/workspace/profile failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/workspace/profile", dashboardAuth, async (req: Request, res: Response) => {
    try {
      const wsId = getWorkspaceId(req);
      const workspaceAuth = (req as Request & { workspaceAuth?: { id?: number } }).workspaceAuth;
      const id = workspaceAuth?.id ?? wsId;
      const body = req.body as Partial<Workspace>;
      const allowed: (keyof Workspace)[] = [
        "name", "timezone", "mode",
        "business_name", "business_tagline", "business_phone", "business_website",
        "business_address", "service_area", "business_hours", "escalation_preference",
        "proof_call_target", "agent_name", "agent_persona",
        "inbound_greeting", "outbound_greeting", "owner_phone", "notification_email",
        "setup_completed_at",
      ];
      const patch: Partial<Workspace> = {};
      for (const key of allowed) {
        if (key in body) (patch as any)[key] = (body as any)[key];
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No valid fields to update" });
      await updateWorkspace(id, patch);
      workspaceProfileCache.delete(id);
      const updated = await getWorkspaceById(id);
      if (!updated) return res.status(404).json({ error: "Workspace not found" });
      if ("setup_completed_at" in patch && updated.setup_completed_at) {
        await createActivationEventIfChanged({
          workspace_id: id,
          event_type: "setup_completed",
          status: "complete",
          actor: "customer",
          detail: {
            activation_stage: "setup_required",
            setup_completed_at: updated.setup_completed_at,
          },
        });
      }
      invalidateWorkspaceAiKeyCache(id);
      return res.json({ ok: true, workspace: { id: updated.id, name: updated.name, setup_completed_at: updated.setup_completed_at } });
    } catch (err: any) {
      log("error", "PATCH /api/workspace/profile failed", { error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });
}
