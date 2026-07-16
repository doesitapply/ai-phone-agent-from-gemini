import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { Workspace } from "../saas.js";
import { provisionWorkspace, updateWorkspace } from "../saas.js";
import { sendProvisioningAlert } from "../monetization-alerts.js";

type ProvisioningRouteDeps = {
  publicDemoRateLimit: RequestHandler;
  dashboardAuth: RequestHandler;
  requireOperator: (req: Request, res: Response, next: NextFunction) => void;
  requireProvisioningSecret: (req: Request, res: Response, next: NextFunction) => void;
  sql: any;
  dbEnabled: boolean;
  env: {
    CALENDLY_URL?: string;
  };
  getAppUrl: () => string;
  provisionWorkspaceTelephony: (workspaceId: number, businessName: string, ownerPhone?: string | null) => Promise<{
    phoneNumber?: string | null;
    subaccountSid?: string | null;
    phoneNumberSid?: string | null;
  }>;
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
};

const SMIRK24_PROMO_CODE = "SMIRK24";
const normalizePromoCode = (value: unknown) => String(value || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
const isSmirk24Promo = (value: unknown) => normalizePromoCode(value) === SMIRK24_PROMO_CODE;
const getSmirk24ExpiresAt = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const normalizeStripeCheckoutSessionId = (value: unknown) => {
  const sessionId = String(value || "").trim();
  return /^cs_(test|live)_[A-Za-z0-9_]{8,240}$/.test(sessionId) ? sessionId : "";
};

function formatPublicProvisioningStatus(status: string) {
  const labels: Record<string, string> = {
    workspace_and_line_created: "Workspace and phone line ready",
    workspace_created: "Workspace ready",
    manual_fallback_required: "Setup needs operator follow-up",
    pending_auto_fulfillment: "Workspace setup is running",
    pending: "Workspace setup is queued",
    processing: "Workspace setup is in progress",
    not_found: "No activation request found",
    unknown: "Status unavailable",
  };
  return labels[status] || status.replace(/_/g, " ");
}

function formatPublicProvisioningNextStep(nextStep: string) {
  const labels: Record<string, string> = {
    check_owner_email: "Check the owner email for the next activation step.",
    manual_follow_up: "SMIRK needs operator follow-up before the workspace is ready.",
    processing: "Keep an eye on the owner email while setup continues.",
  };
  return labels[nextStep] || nextStep.replace(/_/g, " ");
}

export function registerProvisioningRoutes(app: Express, deps: ProvisioningRouteDeps): void {
  const {
    publicDemoRateLimit,
    dashboardAuth,
    requireOperator,
    requireProvisioningSecret,
    sql,
    dbEnabled,
    env,
    getAppUrl,
    provisionWorkspaceTelephony,
    buildProofFreshness,
    buildSetupReadiness,
    buildActivationStatus,
  } = deps;

  app.post("/api/provisioning/request", publicDemoRateLimit, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const businessName = String((req.body as any)?.business_name || (req.body as any)?.name || "").trim();
    const ownerEmail = String((req.body as any)?.owner_email || (req.body as any)?.email || "").trim().toLowerCase();
    const ownerPhone = String((req.body as any)?.phone || "").trim() || null;
    const requestedSlug = String((req.body as any)?.slug || "").trim() || null;
    const requestedPlan = String((req.body as any)?.plan || "starter").trim().toLowerCase();
    const requestedMode = String((req.body as any)?.mode || "missed_call_recovery").trim().toLowerCase();
    const promoCode = normalizePromoCode((req.body as any)?.promo_code || (req.body as any)?.promoCode);
    const promoApplied = isSmirk24Promo(promoCode);
    const source = String((req.body as any)?.source || "public_pricing").trim() || "public_pricing";
    const isSmokeTestProvisioning =
      source === "buyer-auth-smoke" ||
      (businessName === "SMIRK Smoke Test" && ownerEmail === "smoke+buyer@example.com");
    const requestId = String((req as any).requestId || "");
    const ip = String((req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")).split(",")[0].trim() || null;

    if (!businessName || !ownerEmail) {
      return res.status(400).json({ ok: false, error: "business_name and owner_email required" });
    }

    if (!dbEnabled) {
      await sendProvisioningAlert({
        event: "activation_manual_fallback",
        businessName,
        ownerEmail,
        ownerPhone,
        plan: requestedPlan || "starter",
        mode: requestedMode || "missed_call_recovery",
        source,
        status: "manual_fallback_required",
        error: "Persistence is not configured.",
      });
      return res.status(202).json({
        ok: true,
        status: "manual_fallback_required",
        source,
        message: "Provisioning request received, but persistence is not configured yet. Complete setup manually.",
      });
    }

    const plan = (promoApplied ? "free" : (["free", "starter", "pro", "enterprise"].includes(requestedPlan) ? requestedPlan : "starter")) as "free" | "starter" | "pro" | "enterprise";
    const mode = (requestedMode === "general" ? "general" : "missed_call_recovery") as "general" | "missed_call_recovery";
    const autoFulfill = String(process.env.AUTO_FULFILL_PROVISIONING_REQUESTS || "false").trim().toLowerCase() === "true";
    const shouldProvisionNow = !isSmokeTestProvisioning && (autoFulfill || promoApplied);

    if (promoApplied) {
      const existingPromo = await sql<{ id: number; workspace_id: number | null; status: string; created_at: string }[]>`
        SELECT id, workspace_id, status, created_at
        FROM provisioning_requests
        WHERE owner_email = ${ownerEmail}
          AND requested_plan = 'free'
          AND status = 'promo_workspace_created'
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (existingPromo.length > 0) {
        return res.status(409).json({
          ok: false,
          error: "SMIRK24 has already been used for this owner email.",
          code: "PROMO_ALREADY_REDEEMED",
          promo_code: SMIRK24_PROMO_CODE,
        });
      }
    }

    const auditRows = await sql<{ id: number }[]>`
      INSERT INTO provisioning_requests (
        request_id, business_name, owner_email, requested_plan, requested_mode, requested_slug, status, source, ip
      ) VALUES (
        ${requestId || null}, ${businessName}, ${ownerEmail}, ${plan}, ${mode}, ${requestedSlug}, ${shouldProvisionNow ? 'pending_auto_fulfillment' : 'manual_fallback_required'}, ${source}, ${ip}
      )
      RETURNING id
    `;
    const provisioningRequestId = auditRows[0]?.id || null;

    if (!shouldProvisionNow) {
      await sendProvisioningAlert({
        event: "activation_manual_fallback",
        businessName,
        ownerEmail,
        ownerPhone,
        plan,
        mode,
        source,
        status: "manual_fallback_required",
        provisioningRequestId,
      });
      return res.status(202).json({
        ok: true,
        provisioning_request_id: provisioningRequestId,
        status: "manual_fallback_required",
        fallback_status: "manual_fallback_required",
        booking_link: String(process.env.BOOKING_LINK || process.env.CALENDLY_URL || env.CALENDLY_URL || "").trim() || null,
        message: isSmokeTestProvisioning
          ? "Smoke test request captured without workspace provisioning."
          : "Request captured. Manual activation fallback is enabled for this workspace.",
      });
    }

    try {
      const { workspace, ownerInvite } = await provisionWorkspace({
        name: businessName,
        owner_email: ownerEmail,
        plan,
        slug: requestedSlug || undefined,
        mode,
      });
      const promoExpiresAt = promoApplied ? getSmirk24ExpiresAt() : null;
      if (promoApplied) {
        await updateWorkspace(workspace.id, {
          trial_ends_at: promoExpiresAt || undefined,
          subscription_status: "trialing",
          monthly_call_limit: 10,
          monthly_minute_limit: 20,
          business_name: businessName,
          business_phone: ownerPhone || undefined,
          owner_phone: ownerPhone || undefined,
          notification_email: ownerEmail,
        });
      }
      const telephony = promoApplied
        ? { phoneNumber: null as string | null }
        : await provisionWorkspaceTelephony(workspace.id, workspace.name, ownerPhone);
      const inviteLink = `${getAppUrl()}/invite/${ownerInvite.invite_token}`;

      if (provisioningRequestId) {
        await sql`
          UPDATE provisioning_requests
          SET workspace_id = ${workspace.id},
              invite_link = ${inviteLink},
              workspace_api_key = ${workspace.api_key},
              status = ${promoApplied ? 'promo_workspace_created' : telephony.phoneNumber ? 'workspace_and_line_created' : 'workspace_created'},
              updated_at = NOW()
          WHERE id = ${provisioningRequestId}
        `;
      }
      await sendProvisioningAlert({
        event: "activation_workspace_created",
        businessName,
        ownerEmail,
        ownerPhone,
        plan,
        mode,
        source,
        status: promoApplied ? "promo_workspace_created" : telephony.phoneNumber ? "workspace_and_line_created" : "workspace_created",
        provisioningRequestId,
        workspaceId: workspace.id,
        inviteLink,
      });

      return res.status(201).json({
        ok: true,
        provisioning_request_id: provisioningRequestId,
        status: promoApplied ? 'promo_workspace_created' : telephony.phoneNumber ? 'workspace_and_line_created' : 'workspace_created',
        invite_available: true,
        next_step: 'check_owner_email',
        promo: promoApplied ? {
          code: SMIRK24_PROMO_CODE,
          setup_fee_waived: true,
          profile_active_hours: 24,
          expires_at: promoExpiresAt,
        } : null,
        workspace: {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          owner_email: workspace.owner_email,
          plan: workspace.plan,
          mode: workspace.mode,
          phone_number: telephony.phoneNumber,
          trial_ends_at: promoExpiresAt || workspace.trial_ends_at,
        },
      });
    } catch (err: any) {
      const errorMessage = err?.message || 'Workspace provisioning failed';
      if (provisioningRequestId) {
        await sql`
          UPDATE provisioning_requests
          SET status = 'manual_fallback_required',
              error = ${errorMessage},
              updated_at = NOW()
          WHERE id = ${provisioningRequestId}
        `;
      }
      await sendProvisioningAlert({
        event: "activation_manual_fallback",
        businessName,
        ownerEmail,
        ownerPhone,
        plan,
        mode,
        source,
        status: "manual_fallback_required",
        provisioningRequestId,
        error: errorMessage,
      });
      return res.status(202).json({
        ok: true,
        provisioning_request_id: provisioningRequestId,
        status: 'manual_fallback_required',
        fallback_status: 'manual_fallback_required',
        error: errorMessage,
        booking_link: String(process.env.BOOKING_LINK || process.env.CALENDLY_URL || env.CALENDLY_URL || "").trim() || null,
      });
    }
  });

  app.post("/api/provisioning/checkout-status", publicDemoRateLimit, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const email = String((req.body as any)?.email || (req.body as any)?.owner_email || "").trim().toLowerCase();
    const checkoutSessionId = normalizeStripeCheckoutSessionId((req.body as any)?.checkout_session_id || (req.body as any)?.session_id);
    const checkoutReferenceReceived = Boolean(checkoutSessionId);
    if (!email) return res.status(400).json({ ok: false, error: "email required" });

    if (!dbEnabled) {
      return res.status(200).json({
        ok: true,
        email,
        checkout_reference_received: checkoutReferenceReceived,
        status: 'unknown',
        status_label: formatPublicProvisioningStatus('unknown'),
        found: false,
        message: 'Persistence is not configured yet.',
      });
    }

    const rows = await sql<any[]>`
      SELECT pr.id, pr.request_id, pr.workspace_id, pr.business_name, pr.owner_email, pr.requested_plan, pr.requested_mode,
             pr.requested_slug, pr.status, pr.invite_link, pr.source, pr.error, pr.created_at, pr.updated_at,
             w.id as w_id, w.slug as w_slug, w.name as w_name, w.owner_email as w_owner_email,
             w.plan as workspace_plan, w.subscription_status, w.trial_ends_at,
             w.business_name as w_business_name,
             (COALESCE(w.owner_phone, '') <> '' OR COALESCE(w.business_phone, '') <> '') as w_callback_phone_configured,
             (COALESCE(w.service_area, '') <> '' OR COALESCE(w.business_address, '') <> '') as w_service_area_configured,
             (COALESCE(w.business_hours, '') <> '') as w_business_hours_configured,
             (COALESCE(w.inbound_greeting, '') <> '') as w_inbound_greeting_configured,
             (COALESCE(w.notification_email, w.owner_email, pr.owner_email, '') <> '') as w_owner_email_configured,
             (COALESCE(w.setup_completed_at::text, '') <> '') as w_setup_completed,
             (COALESCE(w.twilio_phone_number, '') <> '') as w_twilio_phone_configured,
             (COALESCE(w.escalation_preference, '') <> '') as w_escalation_preference_configured,
             (COALESCE(w.proof_call_target, '') <> '') as w_proof_call_target_configured,
             w.timezone as w_timezone, w.mode as w_mode
      FROM provisioning_requests pr
      LEFT JOIN workspaces w ON w.id = pr.workspace_id
      WHERE pr.owner_email = ${email}
      ORDER BY pr.created_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return res.status(200).json({
        ok: true,
        email,
        checkout_reference_received: checkoutReferenceReceived,
        found: false,
        status: 'not_found',
        status_label: formatPublicProvisioningStatus('not_found'),
      });
    }
    const workspace = row.workspace_id ? {
      id: row.w_id || row.workspace_id,
      slug: row.w_slug || "",
      name: row.w_name || row.business_name,
      owner_email: row.w_owner_email || row.owner_email,
      plan: row.workspace_plan || row.requested_plan || "starter",
      subscription_status: row.subscription_status || "none",
      monthly_call_limit: 0,
      monthly_minute_limit: 0,
      calls_this_month: 0,
      minutes_this_month: 0,
      api_key: "",
      timezone: row.w_timezone || "America/New_York",
      mode: row.w_mode || row.requested_mode || "missed_call_recovery",
      business_name: row.w_business_name || row.business_name,
      business_phone: row.w_callback_phone_configured ? "__configured__" : null,
      business_address: row.w_service_area_configured ? "__configured__" : null,
      service_area: row.w_service_area_configured ? "__configured__" : null,
      business_hours: row.w_business_hours_configured ? "__configured__" : null,
      inbound_greeting: row.w_inbound_greeting_configured ? "__configured__" : null,
      owner_phone: row.w_callback_phone_configured ? "__configured__" : null,
      notification_email: row.w_owner_email_configured ? "__configured__" : null,
      setup_completed_at: row.w_setup_completed ? row.updated_at : null,
      twilio_phone_number: row.w_twilio_phone_configured ? "__configured__" : null,
      escalation_preference: row.w_escalation_preference_configured ? "__configured__" : null,
      proof_call_target: row.w_proof_call_target_configured ? "__configured__" : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    } as Workspace : null;
    const setupReadiness = workspace ? buildSetupReadiness({
      workspace,
      workspaceTwilioNumber: row.w_twilio_phone_configured ? "__configured__" : null,
      knowledgeSourceCount: 0,
      proofFreshness: buildProofFreshness(null, 0),
    }) : null;
    const activationStatus = buildActivationStatus({
      workspace,
      provisioningRequest: row,
      setupReadiness,
      proofFreshness: buildProofFreshness(null, 0),
      workspaceTwilioNumber: row.w_twilio_phone_configured ? "__configured__" : null,
    });
    const publicActivationStatus = {
      ...(activationStatus as Record<string, unknown>),
      inviteLink: null,
      workspaceId: null,
      exceptionReason: null,
    };
    const requestSummary = {
      status: row.status,
      status_label: formatPublicProvisioningStatus(row.status),
      requested_plan: row.requested_plan,
      requested_mode: row.requested_mode,
      invite_available: Boolean(row.invite_link),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    const nextStep = row.invite_link ? 'check_owner_email' : row.status === 'manual_fallback_required' ? 'manual_follow_up' : 'processing';

    return res.status(200).json({
      ok: true,
      found: true,
      email,
      checkout_reference_received: checkoutReferenceReceived,
      request_summary: requestSummary,
      activation_status: publicActivationStatus,
      next_step: nextStep,
      next_step_label: formatPublicProvisioningNextStep(nextStep),
    });
  });

  app.post("/api/provision/workspace", requireProvisioningSecret, async (req: Request, res: Response) => {
    const name = String((req.body as any)?.name || (req.body as any)?.business_name || "").trim();
    const owner_email = String((req.body as any)?.owner_email || (req.body as any)?.email || "").trim().toLowerCase();
    const requestedSlug = String((req.body as any)?.slug || "").trim() || undefined;
    const requestedPlan = String((req.body as any)?.plan || "starter").trim().toLowerCase();
    const requestedMode = String((req.body as any)?.mode || "missed_call_recovery").trim();
    const source = String((req.body as any)?.source || "signup").trim() || "signup";
    const ownerPhone = String((req.body as any)?.phone || (req.body as any)?.owner_phone || "").trim() || null;
    const requestId = String((req as any).requestId || "");
    const ip = String((req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")).split(",")[0].trim() || null;

    if (!name || !owner_email) {
      return res.status(400).json({ ok: false, error: "name and owner_email required" });
    }

    const plan = (["free", "starter", "pro", "enterprise"].includes(requestedPlan) ? requestedPlan : "starter") as "free" | "starter" | "pro" | "enterprise";
    const mode = (requestedMode === "general" ? "general" : "missed_call_recovery") as "general" | "missed_call_recovery";

    if (!dbEnabled) {
      return res.status(503).json({ ok: false, error: "Persistence is not configured." });
    }

    const auditRows = await sql<{ id: number }[]>`
      INSERT INTO provisioning_requests (
        request_id, business_name, owner_email, requested_plan, requested_mode, requested_slug, status, source, ip
      ) VALUES (
        ${requestId || null}, ${name}, ${owner_email}, ${plan}, ${mode}, ${requestedSlug || null}, 'pending', ${source}, ${ip}
      )
      RETURNING id
    `;
    const provisioningRequestId = auditRows[0]?.id;

    try {
      const { workspace, ownerInvite } = await provisionWorkspace({
        name,
        owner_email,
        plan,
        slug: requestedSlug,
        mode,
      });
      const telephony = await provisionWorkspaceTelephony(workspace.id, workspace.name, ownerPhone);

      const inviteLink = `${getAppUrl()}/invite/${ownerInvite.invite_token}`;
      if (provisioningRequestId) {
        await sql`
          UPDATE provisioning_requests
          SET workspace_id = ${workspace.id},
              invite_link = ${inviteLink},
              workspace_api_key = ${workspace.api_key},
              status = ${telephony.phoneNumber ? 'workspace_and_line_created' : 'workspace_created'},
              updated_at = NOW()
          WHERE id = ${provisioningRequestId}
        `;
      }
      await sendProvisioningAlert({
        event: "provisioning_workspace_created",
        businessName: name,
        ownerEmail: owner_email,
        ownerPhone,
        plan,
        mode,
        source,
        status: telephony.phoneNumber ? "workspace_and_line_created" : "workspace_created",
        provisioningRequestId,
        workspaceId: workspace.id,
        inviteLink,
      });

      return res.json({
        ok: true,
        provisioning_request_id: provisioningRequestId,
        workspace: {
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          owner_email: workspace.owner_email,
          plan: workspace.plan,
          mode: workspace.mode,
          subscription_status: workspace.subscription_status,
          created_at: workspace.created_at,
          phone_number: telephony.phoneNumber,
          twilio_subaccount_sid: telephony.subaccountSid,
          phone_number_sid: telephony.phoneNumberSid,
        },
        invite_link: inviteLink,
        workspace_api_key: workspace.api_key,
        provisioned_phone_number: telephony.phoneNumber,
        twilio_subaccount_sid: telephony.subaccountSid,
        phone_number_sid: telephony.phoneNumberSid,
      });
    } catch (err: any) {
      const errorMessage = err?.message || 'Workspace provisioning failed';
      if (provisioningRequestId) {
        await sql`
          UPDATE provisioning_requests
          SET status = 'manual_fallback_required',
              error = ${errorMessage},
              updated_at = NOW()
          WHERE id = ${provisioningRequestId}
        `;
      }
      await sendProvisioningAlert({
        event: "provisioning_failed",
        businessName: name,
        ownerEmail: owner_email,
        ownerPhone,
        plan,
        mode,
        source,
        status: "manual_fallback_required",
        provisioningRequestId,
        error: errorMessage,
      });
      return res.status(500).json({
        ok: false,
        provisioning_request_id: provisioningRequestId,
        fallback_status: 'manual_fallback_required',
        error: errorMessage,
      });
    }
  });

  app.get("/api/provisioning/requests", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
    if (!dbEnabled) {
      return res.json({ requests: [] });
    }

    const rows = await sql`
      SELECT pr.id, pr.request_id, pr.workspace_id, pr.business_name, pr.owner_email, pr.requested_plan, pr.requested_mode,
             pr.requested_slug, pr.status, pr.invite_link, pr.error, pr.source, pr.ip, pr.created_at, pr.updated_at,
             pr.owner_name, pr.owner_phone, pr.business_phone, pr.business_website, pr.business_type, pr.service_area,
             pr.intake_notes, pr.deposit_percent, pr.deposit_status, pr.balance_status, pr.onboarding_source,
             pr.caller_phone, pr.trusted_intake, pr.handoff_team_member_id,
             w.plan as workspace_plan, w.subscription_status, w.trial_ends_at, w.calls_this_month, w.minutes_this_month,
             w.setup_completed_at, w.twilio_phone_number, w.owner_phone as workspace_owner_phone,
             w.business_phone as workspace_business_phone, w.notification_email, w.service_area as workspace_service_area,
             w.business_address as workspace_business_address, w.business_hours as workspace_business_hours,
             w.inbound_greeting as workspace_inbound_greeting, w.escalation_preference, w.proof_call_target,
             ROUND(EXTRACT(EPOCH FROM (NOW() - pr.created_at)) / 60) as age_minutes,
             CASE
               WHEN pr.source LIKE '%smoke%' OR pr.owner_email LIKE 'smoke+%' THEN FALSE
               WHEN pr.status IN ('manual_fallback_required', 'pending', 'pending_auto_fulfillment') THEN TRUE
               WHEN pr.error IS NOT NULL AND pr.error <> '' THEN TRUE
               ELSE FALSE
             END as needs_operator_action,
             CASE
               WHEN pr.source LIKE '%smoke%' OR pr.owner_email LIKE 'smoke+%' THEN 'Smoke test only; no operator action required.'
               WHEN pr.source IN ('voice_operator_onboarding', 'voice_direct_onboarding') THEN 'Review intake, send deposit link, create workspace, confirm activation, then collect balance.'
               WHEN pr.status = 'manual_fallback_required' THEN 'Contact buyer and finish activation manually.'
               WHEN pr.status = 'pending_auto_fulfillment' THEN 'Watch automatic activation or complete by hand if it stalls.'
               WHEN pr.status = 'pending' THEN 'Provision workspace and phone line.'
               WHEN pr.invite_link IS NOT NULL AND pr.invite_link <> '' THEN 'Send or resend invite link.'
               ELSE 'No operator action required.'
             END as next_action,
             CASE
               WHEN pr.source LIKE '%smoke%' OR pr.owner_email LIKE 'smoke+%' THEN FALSE
               WHEN pr.source IN ('voice_operator_onboarding', 'voice_direct_onboarding') THEN TRUE
               WHEN pr.source LIKE 'stripe_%' OR pr.source LIKE '%checkout%' OR pr.requested_plan IN ('starter', 'pro', 'enterprise') THEN TRUE
               ELSE FALSE
             END as paid_signal
      FROM provisioning_requests pr
      LEFT JOIN workspaces w ON w.id = pr.workspace_id
      ORDER BY pr.created_at DESC
      LIMIT ${limit}
    `;
    const enriched = rows.map((row: any) => {
      const hasWorkspace = Boolean(row.workspace_id);
      const paymentActive = Boolean(
        row.subscription_status === "active" ||
        row.subscription_status === "trialing" ||
        row.paid_signal ||
        String(row.source || "").includes("stripe")
      );
      const hasMinimumSetup = Boolean(
        (row.business_name || "").trim() &&
        (row.owner_email || row.notification_email || "").trim() &&
        (row.workspace_owner_phone || row.workspace_business_phone || row.owner_phone || row.business_phone || "").trim() &&
        (row.workspace_service_area || row.workspace_business_address || row.service_area || "").trim() &&
        (row.workspace_business_hours || "").trim() &&
        (row.workspace_inbound_greeting || "").trim() &&
        (row.escalation_preference || "").trim() &&
        (row.proof_call_target || "").trim()
      );
      const operatorException = Boolean(row.needs_operator_action || row.error || (paymentActive && !hasWorkspace));
      const activationStage = operatorException
        ? "operator_exception"
        : hasWorkspace && paymentActive && hasMinimumSetup
          ? "proof_ready"
          : hasWorkspace
            ? "setup_required"
            : paymentActive
              ? "workspace_created"
              : "payment_pending";
      return {
        ...row,
        activation_stage: activationStage,
        activation_ready_for_proof_call: activationStage === "proof_ready",
        activation_exception_reason: row.error || (paymentActive && !hasWorkspace ? "Payment signal exists but no workspace has been created yet." : null),
      };
    });
    res.json({ requests: enriched });
  });
}
