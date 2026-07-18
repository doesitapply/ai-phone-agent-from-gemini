import type { Express, Request, RequestHandler, Response } from "express";
import { exactProofCallTargetMatchesDigest, normalizeExactProofCallTarget } from "../proof-call-binding.js";
import { v4 as uuidv4 } from "uuid";
import { activationIdentityForAuthMode } from "../activation-provenance.js";

const TERMINAL_PROOF_CALL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled", "cancelled"]);

type OutboundCallRouteDeps = {
  dashboardAuth: RequestHandler;
  callRateLimit: RequestHandler;
  requireTestCallSecret: RequestHandler;
  requireProofCallSchemaReady: RequestHandler;
  outboundCallSchema: {
    safeParse: (body: unknown) => {
      success: boolean;
      data?: {
        to: string;
        agentId?: number;
        reason?: string;
        notes?: string;
        source?: string;
      };
      error?: { issues: Array<{ message: string }> };
    };
  };
  env: {
    TWILIO_PHONE_NUMBER?: string;
  };
  sql: any;
  getWorkspaceId: (req: Request) => number;
  checkOutboundCompliance: (phone: string) => Promise<{
    allowed: boolean;
    reason?: string;
    blockedReason?: string;
    nextValidWindow?: Date | null;
  }>;
  getTwilioClient: () => any;
  getWorkspaceOutboundTelephony: (workspaceId: number) => Promise<{
    client: any;
    from: string;
    accountSid: string;
  }>;
  getAppUrl: () => string;
  getActiveAgent: () => Promise<any>;
  resolveContact: (phone: string, workspaceId?: number) => Promise<{ contact: any; isNew: boolean }>;
  sendOutboundCallConfirmationEmail: (input: {
    workspaceId: number;
    to: string;
    reason?: string;
    notes?: string;
    callSid: string;
    source: string;
  }) => Promise<{ sent: boolean; recipientCount: number }>;
  createActivationEvent: (data: {
    workspace_id?: number | null;
    provisioning_request_id?: number | null;
    event_type: string;
    status?: "open" | "blocked" | "complete" | "info";
    actor?: "customer" | "operator" | "system";
    detail?: Record<string, unknown>;
  }) => Promise<unknown>;
  logEvent: (callSid: string, eventType: string, payload?: Record<string, unknown>) => void;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerOutboundCallRoutes(app: Express, deps: OutboundCallRouteDeps): void {
  const {
    dashboardAuth,
    callRateLimit,
    requireTestCallSecret,
    requireProofCallSchemaReady,
    outboundCallSchema,
    env,
    sql,
    getWorkspaceId,
    checkOutboundCompliance,
    getTwilioClient,
    getWorkspaceOutboundTelephony,
    getAppUrl,
    getActiveAgent,
    resolveContact,
    sendOutboundCallConfirmationEmail,
    createActivationEvent,
    logEvent,
    log,
  } = deps;

  app.post("/api/calls", dashboardAuth, callRateLimit, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId;
    const parsed = outboundCallSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error?.issues[0]?.message || "Invalid request" });

    const { to, agentId, reason, notes, source } = parsed.data!;
    const from = env.TWILIO_PHONE_NUMBER;
    if (!from) return res.status(400).json({ error: "TWILIO_PHONE_NUMBER is not configured." });

    try {
      const outboundWsId = getWorkspaceId(req);
      const activationIdentity = activationIdentityForAuthMode((req as any).authMode);
      const provisioningRows = await sql<{ id: number }[]>`
        SELECT id
        FROM provisioning_requests
        WHERE workspace_id = ${outboundWsId}
          AND source = 'stripe_checkout_completed'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `;
      await createActivationEvent({
        workspace_id: outboundWsId,
        provisioning_request_id: Number(provisioningRows[0]?.id || 0) || null,
        event_type: "workspace_outbound_call_requested",
        status: "info",
        actor: activationIdentity.actor,
        detail: {
          auth_mode: activationIdentity.authMode,
          auth_provenance: activationIdentity.authProvenance,
          source: String(source || "dashboard").slice(0, 120),
        },
      });
      const normalizePhoneForBypass = (n: string) => n.replace(/\D/g, "");
      const bypassEnabled = process.env.DEV_OUTBOUND_BYPASS === "true";
      const bypassNumbers = (process.env.DEV_OUTBOUND_BYPASS_NUMBERS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(normalizePhoneForBypass);
      const isBypassNumber = bypassNumbers.includes(normalizePhoneForBypass(to));
      const shouldBypassCompliance = bypassEnabled && isBypassNumber;

      if (!shouldBypassCompliance) {
        const compliance = await checkOutboundCompliance(to);
        if (!compliance.allowed) {
          const nextWindow = compliance.nextValidWindow;
          log("warn", "Outbound call blocked by compliance gate", {
            requestId, to,
            reason: compliance.reason,
            blockedReason: compliance.blockedReason,
            nextValidWindow: nextWindow?.toISOString(),
          });
          return res.status(403).json({
            error: compliance.reason,
            blocked: true,
            blockedReason: compliance.blockedReason,
            nextValidWindow: nextWindow?.toISOString() ?? null,
            message: nextWindow
              ? `Call blocked. Next valid window opens at ${nextWindow.toISOString()} UTC.`
              : "Call blocked. Resolve timezone or DNC status before retrying.",
          });
        }
      } else {
        log("warn", "DEV outbound compliance bypass applied", { requestId, to });
      }

      const client = getTwilioClient();
      const appUrl = getAppUrl();
      const incomingParams = new URLSearchParams();
      if (agentId) incomingParams.set("agentId", String(agentId));
      if (reason) incomingParams.set("reason", reason);
      if (notes) incomingParams.set("notes", notes);
      const incomingQuery = incomingParams.toString();
      const incomingUrl = `${appUrl}/api/twilio/incoming${incomingQuery ? `?${incomingQuery}` : ""}`;
      const call = await client.calls.create({
        url: incomingUrl,
        to,
        from,
        statusCallback: `${appUrl}/api/twilio/status`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "DetectMessageEnd",
        asyncAmdStatusCallback: `${appUrl}/api/twilio/amd`,
        asyncAmdStatusCallbackMethod: "POST",
      });

      let agent = await getActiveAgent();
      if (agentId) {
        const rows = await sql`SELECT * FROM agent_configs WHERE id = ${agentId} LIMIT 1` as any[];
        if (rows[0]) agent = rows[0];
      }
      const { contact } = await resolveContact(to, outboundWsId);

      await sql`
        INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id, workspace_id)
        VALUES (${call.sid}, 'outbound', ${to}, ${from}, 'initiated', ${process.env.AGENT_NAME || agent?.name || "SMIRK"}, ${contact.id}, ${outboundWsId})
        ON CONFLICT (call_sid) DO NOTHING
      `;

      if (reason || notes) {
        const ctx = [reason && `[CALL REASON] ${reason}`, notes && `[OPERATOR NOTES] ${notes}`].filter(Boolean).join("\n");
        await sql`INSERT INTO messages (call_sid, role, text) VALUES (${call.sid}, 'system', ${ctx})`;
      }

      let confirmation: { sent: boolean; recipientCount: number } = { sent: false, recipientCount: 0 };
      try {
        confirmation = await sendOutboundCallConfirmationEmail({
          workspaceId: outboundWsId,
          to,
          reason,
          notes,
          callSid: call.sid,
          source: source || "dashboard",
        });
      } catch (emailErr: unknown) {
        log("warn", "Outbound call confirmation email failed", {
          requestId,
          callSid: call.sid,
          error: emailErr instanceof Error ? emailErr.message : String(emailErr),
        });
      }

      logEvent(call.sid, "CALL_STARTED", { direction: "outbound", to, contactId: contact.id, agentId, reason, source: source || "dashboard", confirmation });
      log("info", "Outbound call initiated", { requestId, callSid: call.sid, to, agentId, reason, confirmation });
      res.json({ success: true, callSid: call.sid, confirmationEmailSent: confirmation.sent, confirmationRecipientCount: confirmation.recipientCount });

    } catch (error: any) {
      log("error", "Outbound call failed", { requestId, error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/workspace/proof-call/fulfill", requireTestCallSecret, requireProofCallSchemaReady, callRateLimit, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId || uuidv4();
    const proofRequestId = Number(req.body?.proofRequestId);
    const workspaceId = Number(req.body?.workspaceId);
    const to = String(req.body?.to || "").trim();
    const confirmedTarget = String(req.body?.confirmedTarget || "").trim();
    const confirmation = String(req.body?.confirmation || "").trim();
    if (!Number.isSafeInteger(proofRequestId) || proofRequestId <= 0
      || !Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
      return res.status(400).json({ ok: false, error: "Exact positive proofRequestId and workspaceId are required." });
    }
    if (!/^\+[1-9]\d{7,14}$/.test(to) || confirmedTarget !== to) {
      return res.status(400).json({ ok: false, error: "The proof target and same-target confirmation must be one exact E.164 number." });
    }
    if (confirmation !== "place-one-smirk-real-proof-call") {
      return res.status(403).json({ ok: false, error: "Exact proof-call machine confirmation is required." });
    }

    let claimEventId: number | null = null;
    let dialAttempted = false;
    let acceptedCallSid: string | null = null;
    try {
      const proofRows = await sql<any[]>`
        SELECT ae.id, ae.workspace_id, ae.provisioning_request_id, ae.event_type, ae.status, ae.actor, ae.detail,
               ae.detail ->> 'proof_target_e164_sha256' AS proof_target_digest,
               w.business_name, w.proof_call_target
        FROM activation_events ae
        JOIN workspaces w ON w.id = ae.workspace_id
        WHERE ae.id = ${proofRequestId}
          AND ae.workspace_id = ${workspaceId}
          AND ae.event_type = 'proof_call_requested'
          AND ae.status = 'open'
          AND ae.actor = 'customer'
          AND ae.detail ->> 'auth_mode' = 'workspace'
          AND ae.detail ->> 'auth_provenance' = 'workspace_bearer_token'
          AND ae.id = (
            SELECT latest.id
            FROM activation_events latest
            WHERE latest.workspace_id = ${workspaceId}
              AND latest.event_type = 'proof_call_requested'
              AND latest.status IN ('open', 'complete')
              AND latest.actor = 'customer'
              AND latest.detail ->> 'auth_mode' = 'workspace'
              AND latest.detail ->> 'auth_provenance' = 'workspace_bearer_token'
            ORDER BY latest.created_at DESC, latest.id DESC
            LIMIT 1
          )
        LIMIT 2
      `;
      if (proofRows.length !== 1) {
        return res.status(409).json({ ok: false, error: "One exact open customer-authored proof request was not found." });
      }
      const proofRequest = proofRows[0];
      const currentProofTarget = normalizeExactProofCallTarget(proofRequest.proof_call_target);
      if (currentProofTarget !== to
        || !exactProofCallTargetMatchesDigest(to, proofRequest.proof_target_digest)) {
        return res.status(409).json({ ok: false, error: "The target no longer matches the exact customer request and current saved proof-call target." });
      }
      const compliance = await checkOutboundCompliance(to);
      if (!compliance.allowed) {
        return res.status(403).json({
          ok: false,
          error: compliance.reason || "Proof call blocked by outbound compliance.",
          blockedReason: compliance.blockedReason || null,
          nextValidWindow: compliance.nextValidWindow?.toISOString() || null,
        });
      }

      const claimRows = await sql<{ id: number }[]>`
        INSERT INTO activation_events (
          workspace_id, provisioning_request_id, event_type, status, actor, detail
        ) VALUES (
          ${workspaceId}, ${Number(proofRequest.provisioning_request_id) || null},
          'proof_call_dispatch_claimed', 'open', 'system',
          ${JSON.stringify({
            proof_request_event_id: String(proofRequestId),
            target_last4: to.replace(/\D/g, "").slice(-4),
            request_id: requestId,
          })}::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      claimEventId = Number(claimRows[0]?.id || 0) || null;
      if (!claimEventId) {
        return res.status(409).json({ ok: false, error: "This workspace already has an active proof attempt, or this exact request is already claimed or dispatched." });
      }

      const telephony = await getWorkspaceOutboundTelephony(workspaceId);
      const appUrl = getAppUrl();
      // From this point forward, a provider timeout can mean that Twilio
      // accepted a paid call even when no response reached us. Keep the exact
      // proof request terminally claimed unless an operator reconciles it.
      dialAttempted = true;
      const call = await telephony.client.calls.create({
        url: `${appUrl}/api/twilio/incoming?reason=${encodeURIComponent("Customer-authorized activation proof call")}`,
        to,
        from: telephony.from,
        statusCallback: `${appUrl}/api/twilio/status`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "DetectMessageEnd",
        asyncAmdStatusCallback: `${appUrl}/api/twilio/amd`,
        asyncAmdStatusCallbackMethod: "POST",
      });
      if (!/^CA[a-fA-F0-9]{32}$/.test(String(call?.sid || ""))) {
        throw new Error("Twilio did not return a valid call SID for the customer proof request.");
      }
      acceptedCallSid = String(call.sid);
      const acceptedRows = await sql<{ id: number }[]>`
        UPDATE activation_events
        SET status = 'outcome_unknown',
            detail = detail || ${JSON.stringify({
              call_sid: acceptedCallSid,
              dial_outcome_unknown: true,
            })}::jsonb
        WHERE id = ${claimEventId}
          AND workspace_id = ${workspaceId}
          AND event_type = 'proof_call_dispatch_claimed'
          AND status = 'open'
        RETURNING id
      `;
      if (Number(acceptedRows[0]?.id || 0) !== claimEventId) {
        throw new Error("Proof-call provider acceptance could not be durably claimed.");
      }
      const { contact } = await resolveContact(to, workspaceId);
      const agent = await getActiveAgent();
      await sql`
        INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id, workspace_id)
        VALUES (${call.sid}, 'outbound', ${to}, ${telephony.from}, 'initiated', ${process.env.AGENT_NAME || agent?.name || "SMIRK"}, ${contact.id}, ${workspaceId})
        ON CONFLICT (call_sid) DO NOTHING
      `;
      const proofContext = [
        "[CALL REASON] Customer-authorized SMIRK activation proof call.",
        `[BUSINESS_NAME] ${String(proofRequest.business_name || "SMIRK customer").slice(0, 160)}`,
        `[PROOF REQUEST EVENT] ${proofRequestId}`,
        "[OPERATOR NOTES] Demonstrate the customer's configured missed-call recovery flow. Do not sell SMIRK, mention Cameron, or use demo-company facts.",
        "[TEST_CALL] true",
      ].join("\n");
      await sql`INSERT INTO messages (call_sid, role, text) VALUES (${call.sid}, 'system', ${proofContext})`;
      const dispatchedDetail = {
        proof_request_event_id: String(proofRequestId),
        call_sid: call.sid,
        target_last4: to.replace(/\D/g, "").slice(-4),
        from_last4: telephony.from.replace(/\D/g, "").slice(-4),
        twilio_account_sid: telephony.accountSid,
        request_id: requestId,
      };
      const dispatchedRows = await sql<{ id: number }[]>`
        UPDATE activation_events
        SET event_type = 'proof_call_dispatched',
            status = 'in_progress',
            detail = ${JSON.stringify(dispatchedDetail)}::jsonb
        WHERE id = ${claimEventId}
          AND workspace_id = ${workspaceId}
          AND event_type = 'proof_call_dispatch_claimed'
          AND status = 'outcome_unknown'
        RETURNING id
      `;
      if (Number(dispatchedRows[0]?.id || 0) !== claimEventId) {
        throw new Error("Proof-call dispatch could not be durably linked to the customer request.");
      }
      logEvent(call.sid, "WORKSPACE_PROOF_CALL_DISPATCHED", { workspaceId, proofRequestId });
      log("info", "Customer-bound proof call initiated", { requestId, callSid: call.sid, workspaceId, proofRequestId });
      return res.status(202).json({ ok: true, callSid: call.sid, workspaceId, proofRequestId });
    } catch (error: any) {
      if (claimEventId) {
        const terminalStatus = dialAttempted ? 'outcome_unknown' : 'blocked';
        await sql`
          UPDATE activation_events
          SET status = ${terminalStatus},
              detail = detail || ${JSON.stringify({
                error: String(error?.message || error).slice(0, 300),
                dial_attempted: dialAttempted,
                dial_outcome_unknown: dialAttempted,
                call_sid: acceptedCallSid,
                retry_requires_operator_reconciliation: dialAttempted,
              })}::jsonb
          WHERE id = ${claimEventId}
            AND event_type = 'proof_call_dispatch_claimed'
            AND status IN ('open', 'outcome_unknown')
        `.catch(() => {});
      }
      log("error", "Customer-bound proof call failed", { requestId, workspaceId, proofRequestId, error: error?.message || String(error) });
      return res.status(500).json({
        ok: false,
        error: dialAttempted
          ? "Proof-call outcome is uncertain. Do not retry this request until an operator reconciles the Twilio attempt."
          : (error?.message || "Customer-bound proof call failed."),
        retryable: !dialAttempted,
        reconciliationRequired: dialAttempted,
      });
    }
  });

  app.post("/api/workspace/proof-call/reconcile", requireTestCallSecret, requireProofCallSchemaReady, callRateLimit, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId || uuidv4();
    const proofRequestId = Number(req.body?.proofRequestId);
    const workspaceId = Number(req.body?.workspaceId);
    const callSid = String(req.body?.callSid || "").trim();
    const confirmation = String(req.body?.confirmation || "").trim();
    if (!Number.isSafeInteger(proofRequestId) || proofRequestId <= 0
      || !Number.isSafeInteger(workspaceId) || workspaceId <= 0
      || !/^CA[a-fA-F0-9]{32}$/.test(callSid)) {
      return res.status(400).json({ ok: false, error: "Exact positive proofRequestId/workspaceId and one valid Twilio callSid are required." });
    }
    if (confirmation !== "reconcile-one-smirk-proof-call") {
      return res.status(403).json({ ok: false, error: "Exact proof-call reconciliation confirmation is required." });
    }

    try {
      const claimRows = await sql<any[]>`
        SELECT claim.id, claim.provisioning_request_id, claim.event_type, claim.status, claim.created_at,
               claim.detail ->> 'call_sid' AS stored_call_sid,
               request.detail ->> 'proof_target_e164_sha256' AS proof_target_digest,
               w.business_name
        FROM activation_events claim
        JOIN activation_events request
          ON request.id = ${proofRequestId}
         AND request.workspace_id = claim.workspace_id
         AND request.event_type = 'proof_call_requested'
         AND request.actor = 'customer'
         AND request.detail ->> 'auth_mode' = 'workspace'
         AND request.detail ->> 'auth_provenance' = 'workspace_bearer_token'
        JOIN workspaces w ON w.id = claim.workspace_id
        WHERE claim.workspace_id = ${workspaceId}
          AND claim.event_type IN ('proof_call_dispatch_claimed', 'proof_call_dispatched')
          AND claim.status IN ('open', 'outcome_unknown', 'in_progress')
          AND claim.detail ->> 'proof_request_event_id' = ${String(proofRequestId)}
        LIMIT 2
      `;
      if (claimRows.length !== 1) {
        return res.status(409).json({ ok: false, error: "One exact active or outcome-unknown proof-call claim was not found." });
      }
      const claim = claimRows[0];
      const storedCallSid = String(claim.stored_call_sid || "").trim();
      if (storedCallSid && storedCallSid !== callSid) {
        return res.status(409).json({ ok: false, error: "The supplied callSid does not match the provider SID already stored on this claim." });
      }

      const telephony = await getWorkspaceOutboundTelephony(workspaceId);
      const providerCall = await telephony.client.calls(callSid).fetch();
      const providerSid = String(providerCall?.sid || "").trim();
      const providerTo = normalizeExactProofCallTarget(providerCall?.to);
      const providerFrom = normalizeExactProofCallTarget(providerCall?.from);
      const providerStatus = String(providerCall?.status || "").trim().toLowerCase();
      const providerDirection = String(providerCall?.direction || "").trim().toLowerCase();
      const providerAccountSid = String(providerCall?.accountSid || providerCall?.account_sid || "").trim();
      const claimCreatedAtMs = new Date(claim.created_at).getTime();
      const providerCreatedAtRaw = providerCall?.dateCreated ?? providerCall?.date_created ?? null;
      const providerCreatedAtMs = providerCreatedAtRaw ? new Date(providerCreatedAtRaw).getTime() : Number.NaN;
      const providerTimePresent = Number.isFinite(providerCreatedAtMs);
      const providerTimeMatchesClaim = Number.isFinite(claimCreatedAtMs)
        && providerTimePresent
        && providerCreatedAtMs >= claimCreatedAtMs - (2 * 60 * 1000)
        && providerCreatedAtMs <= claimCreatedAtMs + (15 * 60 * 1000)
        && providerCreatedAtMs <= Date.now() + (2 * 60 * 1000);
      if (providerSid !== callSid
        || providerFrom !== telephony.from
        || !providerTo
        || !exactProofCallTargetMatchesDigest(providerTo, claim.proof_target_digest)
        || (providerAccountSid && providerAccountSid !== telephony.accountSid)
        || (providerDirection && providerDirection !== "outbound-api")
        || (!storedCallSid && !providerTimeMatchesClaim)
        || (providerTimePresent && !providerTimeMatchesClaim)
        || !/^(?:queued|ringing|in-progress|completed|busy|failed|no-answer|canceled)$/.test(providerStatus)) {
        return res.status(409).json({ ok: false, error: "Twilio did not return the exact provider call bound to this workspace and customer request." });
      }

      const { contact } = await resolveContact(providerTo, workspaceId);
      const agent = await getActiveAgent();
      await sql`
        INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id, workspace_id)
        VALUES (${callSid}, 'outbound', ${providerTo}, ${providerFrom}, ${providerStatus}, ${process.env.AGENT_NAME || agent?.name || "SMIRK"}, ${contact.id}, ${workspaceId})
        ON CONFLICT (call_sid) DO NOTHING
      `;
      const persistedCalls = await sql<{ call_sid: string }[]>`
        SELECT call_sid
        FROM calls
        WHERE call_sid = ${callSid}
          AND workspace_id = ${workspaceId}
          AND to_number = ${providerTo}
          AND from_number = ${providerFrom}
        LIMIT 2
      `;
      if (persistedCalls.length !== 1) {
        throw new Error("The provider call could not be persisted inside the exact customer workspace.");
      }
      const proofContext = [
        "[CALL REASON] Customer-authorized SMIRK activation proof call.",
        `[BUSINESS_NAME] ${String(claim.business_name || "SMIRK customer").slice(0, 160)}`,
        `[PROOF REQUEST EVENT] ${proofRequestId}`,
        "[OPERATOR NOTES] Provider-verified reconciliation of the customer's activation proof call.",
        "[TEST_CALL] true",
      ].join("\n");
      await sql`
        INSERT INTO messages (call_sid, role, text)
        SELECT ${callSid}, 'system', ${proofContext}
        WHERE NOT EXISTS (
          SELECT 1 FROM messages
          WHERE call_sid = ${callSid}
            AND role = 'system'
            AND text LIKE ${`%[PROOF REQUEST EVENT] ${proofRequestId}%`}
        )
      `;
      const dispatchedDetail = {
        proof_request_event_id: String(proofRequestId),
        call_sid: callSid,
        target_last4: providerTo.slice(-4),
        from_last4: providerFrom.slice(-4),
        twilio_account_sid: telephony.accountSid,
        request_id: requestId,
        reconciled_from_outcome_unknown: claim.status === "outcome_unknown",
        reconciled_from_state: `${String(claim.event_type || "unknown")}:${String(claim.status || "unknown")}`,
        provider_status_at_reconciliation: providerStatus,
        provider_created_at: providerTimePresent ? new Date(providerCreatedAtMs).toISOString() : null,
      };
      const reconciledDispatchStatus = TERMINAL_PROOF_CALL_STATUSES.has(providerStatus) ? "complete" : "in_progress";
      const dispatchedRows = await sql<{ id: number }[]>`
        UPDATE activation_events
        SET event_type = 'proof_call_dispatched',
            status = ${reconciledDispatchStatus},
            detail = ${JSON.stringify(dispatchedDetail)}::jsonb
        WHERE id = ${Number(claim.id)}
          AND workspace_id = ${workspaceId}
          AND event_type IN ('proof_call_dispatch_claimed', 'proof_call_dispatched')
          AND status IN ('open', 'outcome_unknown', 'in_progress')
        RETURNING id
      `;
      if (Number(dispatchedRows[0]?.id || 0) !== Number(claim.id)) {
        return res.status(409).json({ ok: false, error: "The proof-call claim changed before reconciliation could complete." });
      }
      logEvent(callSid, "WORKSPACE_PROOF_CALL_RECONCILED", { workspaceId, proofRequestId, providerStatus });
      log("info", "Customer-bound proof call reconciled", { requestId, callSid, workspaceId, proofRequestId, providerStatus });
      return res.status(200).json({ ok: true, callSid, workspaceId, proofRequestId, providerStatus });
    } catch (error: any) {
      log("error", "Customer-bound proof-call reconciliation failed", {
        requestId,
        callSid,
        workspaceId,
        proofRequestId,
        error: error?.message || String(error),
      });
      return res.status(500).json({
        ok: false,
        error: "Proof-call reconciliation could not be verified. The claim remains terminally held; do not redial it.",
        retryable: true,
        reconciliationRequired: true,
      });
    }
  });

  app.post("/api/test-call", requireTestCallSecret, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId || uuidv4();
    const to = String(req.body?.to || process.env.OWNER_PHONE || "+17754204485");
    const from = env.TWILIO_PHONE_NUMBER;
    if (!from) return res.status(400).json({ ok: false, error: "TWILIO_PHONE_NUMBER not configured" });
    const client = getTwilioClient();
    if (!client) return res.status(503).json({ ok: false, error: "Twilio not configured" });
    const appUrl = getAppUrl();
    const smirkPitch = `[CALL REASON] This is an outbound demo call to sell SMIRK AI to the business owner.
[BUSINESS_NAME] SMIRK AI
[OPERATOR NOTES] You are SMIRK, a missed-call recovery assistant built for trades contractors. You are calling Cameron, the owner of SMIRK AI, to demonstrate your own capabilities live. Your goal is to:
1. Open with: "Hey, this is SMIRK — the missed-call recovery assistant. I'm calling to show you what I can do. Got 60 seconds?"
2. If he engages, deliver the pitch: "Imagine you're on a job site and your phone rings — a $4,000 HVAC job. You can't answer. That call goes to voicemail. They call your competitor. That's $4,000 gone. I answer that missed call, capture the lead details, email you the summary, and create the callback task — while you're still under the sink."
3. Ask: "Want me to show you how I'd handle a real lead right now?"
4. If yes, walk through a mock lead qualification for an HVAC service call.
5. Close by offering to send a follow-up email with pricing and a demo link.
6. Be direct and confident — you're proving you work by doing the thing you're selling.
CRITICAL: You already have the caller's phone number on file. Do NOT ask for it. If they ask how you got it, say you called them from the number on file.
[TEST_CALL] true`;
    try {
      const call = await client.calls.create({
        url: `${appUrl}/api/twilio/incoming`,
        to,
        from,
        statusCallback: `${appUrl}/api/twilio/status`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "DetectMessageEnd",
        asyncAmdStatusCallback: `${appUrl}/api/twilio/amd`,
        asyncAmdStatusCallbackMethod: "POST",
      });
      const { contact } = await resolveContact(to, 1);
      const agent = await getActiveAgent();
      await sql`
        INSERT INTO calls (call_sid, direction, to_number, from_number, status, agent_name, contact_id, workspace_id)
        VALUES (${call.sid}, 'outbound', ${to}, ${from}, 'initiated', ${process.env.AGENT_NAME || agent?.name || "SMIRK"}, ${contact.id}, 1)
        ON CONFLICT (call_sid) DO NOTHING
      `;
      await sql`INSERT INTO messages (call_sid, role, text) VALUES (${call.sid}, 'system', ${smirkPitch})`;
      logEvent(call.sid, "TEST_CALL_STARTED", { to, requestId });
      log("info", "Test call initiated", { requestId, callSid: call.sid, to });
      res.json({ ok: true, callSid: call.sid, to, message: "SMIRK self-pitch call initiated" });
    } catch (err: any) {
      log("error", "Test call failed", { requestId, error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
