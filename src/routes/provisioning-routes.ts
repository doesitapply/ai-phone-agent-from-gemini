import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { Workspace } from "../saas.js";
import { inviteMember, provisionWorkspace, resendCheckoutOwnerInvite, updateWorkspace } from "../saas.js";
import { sendManualSetupReceipt, sendPromoActivationEmail, sendProvisioningAlert, type BuyerActivationEmailResult } from "../monetization-alerts.js";
import { shouldProvisionPublicRequest } from "../checkout-safety.js";
import { hasWorkspaceBillingEntitlement } from "../billing-safety.js";
import { firstSafePublicHttpsUrl, resolveTrustedProductionAppOrigin } from "../public-url-safety.js";
import { normalizeStrictMailbox } from "../email-safety.js";

type ProvisioningRouteDeps = {
  publicProvisioningRequestRateLimit: RequestHandler;
  publicCheckoutStatusRateLimit: RequestHandler;
  publicInviteResendRateLimit: RequestHandler;
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
const normalizePublicProvisioningSource = (value: unknown) => {
  const source = String(value || "public_pricing").trim().slice(0, 120);
  const allowed = new Set(["public_pricing", "public_landing", "public_book_setup", "public_landing_funnel", "buyer-auth-smoke"]);
  return allowed.has(source) ? source : "public_unverified";
};
const getBuyerFacingBookingLink = (env: ProvisioningRouteDeps["env"]): string | null => (
  firstSafePublicHttpsUrl(process.env.BOOKING_LINK, process.env.CALENDLY_URL, env.CALENDLY_URL)
);

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
    billing_inactive: "Workspace access is paused. Contact setup help to restore active billing.",
    refresh_owner_invite: "The secure owner link expired. Request a fresh access email below.",
    open_dashboard: "Owner access was accepted. Open the dashboard on the device where you accepted it.",
    processing: "Keep an eye on the owner email while setup continues.",
  };
  return labels[nextStep] || nextStep.replace(/_/g, " ");
}

export function registerProvisioningRoutes(app: Express, deps: ProvisioningRouteDeps): void {
  const {
    publicProvisioningRequestRateLimit,
    publicCheckoutStatusRateLimit,
    publicInviteResendRateLimit,
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

  const persistPromoActivationDelivery = async (input: {
    provisioningRequestId: number;
    workspaceId: number;
    businessName: string;
    ownerEmail: string;
    inviteLink: string;
    inviteExpiresAt: string;
    promoExpiresAt: string;
  }): Promise<{ delivery: BuyerActivationEmailResult; deliveryStatus: string; error: string | null }> => {
    const delivery = await sendPromoActivationEmail(input);
    const error = delivery.sent
      ? null
      : String(delivery.error || delivery.skippedReason || "Promo activation email was not delivered.").slice(0, 500);
    const deliveryStatus = delivery.sent ? "sent" : delivery.retryable ? "retryable_failed" : "failed";
    await sql`
      UPDATE provisioning_requests
      SET invite_link = ${input.inviteLink},
          status = ${delivery.sent ? 'promo_workspace_created' : 'manual_fallback_required'},
          buyer_activation_email_status = ${deliveryStatus},
          buyer_activation_email_sent_at = ${delivery.sent ? new Date().toISOString() : null},
          buyer_activation_email_provider_id = ${delivery.providerMessageId || null},
          buyer_activation_email_error = ${error},
          error = ${error},
          updated_at = NOW()
      WHERE id = ${input.provisioningRequestId}
        AND workspace_id = ${input.workspaceId}
    `;
    await sql`
      INSERT INTO activation_events (
        workspace_id, provisioning_request_id, event_type, status, actor, detail
      ) VALUES (
        ${input.workspaceId}, ${input.provisioningRequestId}, 'buyer_activation_email',
        ${delivery.sent ? 'complete' : 'blocked'}, 'system',
        ${JSON.stringify({
          source: "smirk24_promo",
          delivery_status: deliveryStatus,
          provider_message_id: delivery.providerMessageId || null,
          reason: error,
        })}::jsonb
      )
    `;
    return { delivery, deliveryStatus, error };
  };

  const respondPromoDeliveryFailure = (
    res: Response,
    provisioningRequestId: number,
    delivery: BuyerActivationEmailResult,
    deliveryStatus: string,
  ) => {
    const message = delivery.retryable
      ? "Your promo workspace was created, but the owner email could not be delivered yet. Submit SMIRK24 again with the same owner email to retry safely."
      : "Your promo workspace was created, but the owner email could not be delivered. Request setup help so the owner address can be corrected.";
    return res.status(delivery.retryable ? 503 : 422).json({
      ok: false,
      error: message,
      message,
      provisioning_request_id: provisioningRequestId,
      status: deliveryStatus,
      invite_available: false,
      retryable: delivery.retryable === true,
      booking_link: getBuyerFacingBookingLink(env),
    });
  };

  app.post("/api/provisioning/request", publicProvisioningRequestRateLimit, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const businessName = String((req.body as any)?.business_name || (req.body as any)?.name || "").trim().replace(/[\r\n\t]+/g, " ").slice(0, 200);
    const ownerEmail = normalizeStrictMailbox((req.body as any)?.owner_email || (req.body as any)?.email)?.toLowerCase() || "";
    const ownerPhone = String((req.body as any)?.phone || "").trim().replace(/[\r\n\t]+/g, " ").slice(0, 80) || null;
    const intakeNotes = String((req.body as any)?.notes || (req.body as any)?.intake_notes || "").trim().slice(0, 2_000) || null;
    const requestedSlug = String((req.body as any)?.slug || "").trim() || null;
    const requestedPlan = String((req.body as any)?.plan || "starter").trim().toLowerCase();
    const requestedMode = String((req.body as any)?.mode || "missed_call_recovery").trim().toLowerCase();
    const promoCode = normalizePromoCode((req.body as any)?.promo_code || (req.body as any)?.promoCode);
    const promoApplied = isSmirk24Promo(promoCode);
    const source = normalizePublicProvisioningSource((req.body as any)?.source);
    const isSmokeTestProvisioning =
      source === "buyer-auth-smoke" ||
      (businessName === "SMIRK Smoke Test" && ownerEmail === "smoke+buyer@example.com");
    const requestId = String((req as any).requestId || "");
    const ip = String((req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")).split(",")[0].trim() || null;
    const bookingLink = getBuyerFacingBookingLink(env);

    if (!businessName || !ownerEmail || !ownerPhone) {
      return res.status(400).json({ ok: false, error: "business_name, valid owner_email, and phone required" });
    }

    if (!dbEnabled) {
      const operatorAlert = await sendProvisioningAlert({
        event: "activation_manual_fallback",
        businessName,
        ownerEmail,
        ownerPhone,
        intakeNotes,
        plan: requestedPlan || "starter",
        mode: requestedMode || "missed_call_recovery",
        source,
        status: "manual_fallback_required",
        error: "Persistence is not configured.",
        deliveryScope: requestId || `no_db_${ownerEmail}_${businessName}`,
      });
      if (!operatorAlert.sent) {
        return res.status(503).json({
          ok: false,
          captured: false,
          status: "capture_unavailable",
          retryable: operatorAlert.retryable === true,
          booking_link: bookingLink,
          error: "We could not safely save or route this setup request. Nothing has been captured; try again or use setup help.",
        });
      }
      const receipt = await sendManualSetupReceipt({
        deliveryScope: requestId || `no_db_${ownerEmail}_${businessName}`,
        businessName,
        ownerEmail,
        ownerPhone,
        intakeNotes,
        bookingLink,
      });
      return res.status(202).json({
        ok: true,
        captured: true,
        status: "manual_fallback_alerted",
        source,
        operator_alert_sent: true,
        receipt_email_sent: receipt.sent,
        booking_link: bookingLink,
        message: receipt.sent
          ? "Online storage is unavailable, but the setup request was routed to the setup team by email and a confirmation was sent to the owner address."
          : "Online storage is unavailable, but the setup request was routed to the setup team by email. The owner confirmation could not be delivered.",
      });
    }

    const plan = (promoApplied ? "free" : (["free", "starter", "pro", "enterprise"].includes(requestedPlan) ? requestedPlan : "starter")) as "free" | "starter" | "pro" | "enterprise";
    const mode = (requestedMode === "general" ? "general" : "missed_call_recovery") as "general" | "missed_call_recovery";
    // Paid workspaces are created only by the signed Stripe webhook or the
    // provisioning-secret route. This public lead-capture route may immediately
    // create only the deliberately free, one-time promo workspace.
    const shouldProvisionNow = shouldProvisionPublicRequest({ promoApplied, isSmokeTestProvisioning });
    const provisioningSource = promoApplied && shouldProvisionNow ? "smirk24_promo" : source;

    if (promoApplied && shouldProvisionNow) {
      const existingPromo = await sql<{
        id: number;
        workspace_id: number | null;
        business_name: string;
        status: string;
        buyer_activation_email_status: string;
        workspace_name: string | null;
        trial_ends_at: string | null;
        invite_accepted: boolean;
        owner_invite_token: string | null;
        owner_invite_expires_at: string | null;
      }[]>`
        SELECT pr.id, pr.workspace_id, pr.business_name, pr.status, pr.buyer_activation_email_status,
               w.name AS workspace_name, w.trial_ends_at,
               EXISTS (
                 SELECT 1 FROM workspace_members wm
                 WHERE wm.workspace_id = pr.workspace_id
                   AND lower(wm.email) = lower(pr.owner_email)
                   AND wm.role = 'owner'
                   AND wm.accepted_at IS NOT NULL
               ) AS invite_accepted,
               (
                 SELECT wm.invite_token FROM workspace_members wm
                 WHERE wm.workspace_id = pr.workspace_id
                   AND lower(wm.email) = lower(pr.owner_email)
                   AND wm.role = 'owner'
                 LIMIT 1
               ) AS owner_invite_token,
               (
                 SELECT wm.invite_expires_at FROM workspace_members wm
                 WHERE wm.workspace_id = pr.workspace_id
                   AND lower(wm.email) = lower(pr.owner_email)
                   AND wm.role = 'owner'
                 LIMIT 1
               ) AS owner_invite_expires_at
        FROM provisioning_requests pr
        LEFT JOIN workspaces w ON w.id = pr.workspace_id
        WHERE lower(pr.owner_email) = lower(${ownerEmail})
          AND pr.requested_plan = 'free'
          AND (pr.source = 'smirk24_promo' OR pr.status = 'promo_workspace_created')
        ORDER BY pr.created_at DESC
        LIMIT 2
      `;
      if (existingPromo.length > 1 || (existingPromo[0] && (!existingPromo[0].workspace_id || !existingPromo[0].trial_ends_at))) {
        return res.status(409).json({
          ok: false,
          error: "This SMIRK24 redemption needs setup help before it can continue.",
          code: "PROMO_RECOVERY_REQUIRES_OPERATOR",
          booking_link: getBuyerFacingBookingLink(env),
        });
      }
      if (existingPromo[0]?.buyer_activation_email_status === "sent" || existingPromo[0]?.invite_accepted) {
        return res.status(409).json({
          ok: false,
          error: "SMIRK24 has already been used for this owner email.",
          code: "PROMO_ALREADY_REDEEMED",
          promo_code: SMIRK24_PROMO_CODE,
        });
      }
      if (existingPromo[0]) {
        const promoExpiresAt = new Date(existingPromo[0].trial_ends_at!);
        if (!Number.isFinite(promoExpiresAt.getTime()) || promoExpiresAt.getTime() <= Date.now()) {
          return res.status(410).json({
            ok: false,
            error: "This SMIRK24 access window has expired.",
            code: "PROMO_EXPIRED",
            booking_link: getBuyerFacingBookingLink(env),
          });
        }
        const existingInviteExpiry = new Date(existingPromo[0].owner_invite_expires_at || "");
        const reusableInvite = Boolean(
          /^[a-f0-9]{64}$/i.test(existingPromo[0].owner_invite_token || "")
          && Number.isFinite(existingInviteExpiry.getTime())
          && existingInviteExpiry.getTime() > Date.now(),
        );
        const ownerInvite = reusableInvite
          ? {
              invite_token: existingPromo[0].owner_invite_token!,
              invite_expires_at: existingPromo[0].owner_invite_expires_at!,
            }
          : await inviteMember(existingPromo[0].workspace_id!, ownerEmail, "owner");
        const inviteLink = `${resolveTrustedProductionAppOrigin(process.env.APP_URL, getAppUrl())}/invite/${ownerInvite.invite_token}`;
        const promoDelivery = await persistPromoActivationDelivery({
          provisioningRequestId: existingPromo[0].id,
          workspaceId: existingPromo[0].workspace_id!,
          businessName: existingPromo[0].business_name || businessName,
          ownerEmail,
          inviteLink,
          inviteExpiresAt: String(ownerInvite.invite_expires_at || ""),
          promoExpiresAt: promoExpiresAt.toISOString(),
        });
        await sendProvisioningAlert({
          event: promoDelivery.delivery.sent ? "activation_workspace_created" : "activation_manual_fallback",
          businessName: existingPromo[0].business_name || businessName,
          ownerEmail,
          ownerPhone,
          plan: "free",
          mode,
          source: "smirk24_promo",
          status: promoDelivery.delivery.sent ? "promo_workspace_created" : promoDelivery.deliveryStatus,
          provisioningRequestId: existingPromo[0].id,
          workspaceId: existingPromo[0].workspace_id,
          error: promoDelivery.error,
          deliveryScope: `smirk24_${existingPromo[0].id}_${promoDelivery.deliveryStatus}`,
        });
        if (!promoDelivery.delivery.sent) {
          return respondPromoDeliveryFailure(res, existingPromo[0].id, promoDelivery.delivery, promoDelivery.deliveryStatus);
        }
        return res.status(200).json({
          ok: true,
          provisioning_request_id: existingPromo[0].id,
          status: "promo_workspace_created",
          invite_available: true,
          next_step: "check_owner_email",
          promo: {
            code: SMIRK24_PROMO_CODE,
            setup_fee_waived: true,
            profile_active_hours: 24,
            expires_at: promoExpiresAt.toISOString(),
          },
        });
      }
    }

    const auditRows = await sql<{ id: number }[]>`
      INSERT INTO provisioning_requests (
        request_id, business_name, owner_email, owner_phone, business_phone, intake_notes,
        requested_plan, requested_mode, requested_slug, status, source, ip
      ) VALUES (
        ${requestId || null}, ${businessName}, ${ownerEmail}, ${ownerPhone}, ${ownerPhone}, ${intakeNotes},
        ${plan}, ${mode}, ${requestedSlug}, ${shouldProvisionNow ? 'pending_auto_fulfillment' : 'manual_fallback_required'}, ${provisioningSource}, ${ip}
      )
      RETURNING id
    `;
    const provisioningRequestId = auditRows[0]?.id || null;

    if (!shouldProvisionNow) {
      const [operatorAlert, receipt] = await Promise.all([
        sendProvisioningAlert({
          event: "activation_manual_fallback",
          businessName,
          ownerEmail,
          ownerPhone,
          intakeNotes,
          plan,
          mode,
          source: provisioningSource,
          status: "manual_fallback_required",
          provisioningRequestId,
          deliveryScope: `manual_setup_${provisioningRequestId}`,
        }),
        sendManualSetupReceipt({
          deliveryScope: `manual_setup_${provisioningRequestId}`,
          businessName,
          ownerEmail,
          ownerPhone,
          intakeNotes,
          bookingLink,
        }),
      ]);
      const receiptStatus = receipt.sent
        ? "manual_receipt_sent"
        : receipt.retryable ? "manual_receipt_retryable_failed" : "manual_receipt_failed";
      try {
        await sql`
          UPDATE provisioning_requests
          SET buyer_activation_email_status = ${receiptStatus},
              buyer_activation_email_sent_at = ${receipt.sent ? new Date().toISOString() : null},
              buyer_activation_email_provider_id = ${receipt.providerMessageId || null},
              buyer_activation_email_error = ${receipt.sent ? null : String(receipt.error || receipt.skippedReason || "Manual setup receipt was not delivered.").slice(0, 500)},
              updated_at = NOW()
          WHERE id = ${provisioningRequestId}
        `;
      } catch {
        // The lead row was already committed. Do not tell the buyer it was lost
        // merely because the best-effort delivery audit update failed.
      }
      return res.status(202).json({
        ok: true,
        captured: true,
        provisioning_request_id: provisioningRequestId,
        status: "manual_fallback_required",
        fallback_status: "manual_fallback_required",
        operator_alert_sent: operatorAlert.sent,
        receipt_email_sent: receipt.sent,
        booking_link: bookingLink,
        message: isSmokeTestProvisioning
          ? "Smoke test request captured without workspace provisioning."
          : receipt.sent
            ? "Setup request saved with the business phone and any setup notes you provided. A confirmation email was sent to the owner address."
            : "Setup request saved with the business phone and any setup notes you provided. The confirmation email could not be delivered, so use setup help if you need an immediate next step.",
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
      const inviteLink = `${resolveTrustedProductionAppOrigin(process.env.APP_URL, getAppUrl())}/invite/${ownerInvite.invite_token}`;

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
      const promoDelivery = promoApplied
        ? await persistPromoActivationDelivery({
            provisioningRequestId: provisioningRequestId!,
            workspaceId: workspace.id,
            businessName,
            ownerEmail,
            inviteLink,
            inviteExpiresAt: String(ownerInvite.invite_expires_at || ""),
            promoExpiresAt: promoExpiresAt!,
          })
        : null;
      await sendProvisioningAlert({
        event: promoDelivery && !promoDelivery.delivery.sent ? "activation_manual_fallback" : "activation_workspace_created",
        businessName,
        ownerEmail,
        ownerPhone,
        plan,
        mode,
        source: provisioningSource,
        status: promoDelivery && !promoDelivery.delivery.sent
          ? promoDelivery.deliveryStatus
          : promoApplied ? "promo_workspace_created" : telephony.phoneNumber ? "workspace_and_line_created" : "workspace_created",
        provisioningRequestId,
        workspaceId: workspace.id,
        inviteLink,
        error: promoDelivery?.error || null,
        deliveryScope: promoApplied && provisioningRequestId ? `smirk24_${provisioningRequestId}_${promoDelivery?.deliveryStatus || "created"}` : null,
      });

      if (promoDelivery && !promoDelivery.delivery.sent) {
        return respondPromoDeliveryFailure(res, provisioningRequestId!, promoDelivery.delivery, promoDelivery.deliveryStatus);
      }

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
        source: provisioningSource,
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
        booking_link: getBuyerFacingBookingLink(env),
      });
    }
  });

  app.post("/api/provisioning/checkout-status", publicCheckoutStatusRateLimit, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const email = String((req.body as any)?.email || (req.body as any)?.owner_email || "").trim().toLowerCase();
    const rawCheckoutSessionId = String((req.body as any)?.checkout_session_id || (req.body as any)?.session_id || "").trim();
    const checkoutSessionId = normalizeStripeCheckoutSessionId(rawCheckoutSessionId);
    const checkoutReferenceReceived = Boolean(checkoutSessionId);
    if (!email) return res.status(400).json({ ok: false, error: "email required" });
    if (rawCheckoutSessionId && !checkoutSessionId) {
      return res.status(400).json({ ok: false, error: "valid checkout_session_id required" });
    }
    if (!checkoutSessionId) {
      return res.status(200).json({
        ok: true,
        found: false,
        checkout_reference_received: false,
        checkout_verified: false,
        payment_received: false,
        payment_verified: false,
        access_active: false,
        status: 'secure_reference_required',
        status_label: 'Secure checkout reference required',
        message: 'For privacy, detailed activation status is available only from the secure checkout success link and the matching owner email.',
      });
    }

    if (!dbEnabled) {
      return res.status(200).json({
        ok: true,
        email,
        checkout_reference_received: checkoutReferenceReceived,
        checkout_verified: false,
        payment_received: false,
        payment_verified: false,
        access_active: false,
        status: 'unknown',
        status_label: formatPublicProvisioningStatus('unknown'),
        found: false,
        message: 'Persistence is not configured yet.',
      });
    }

    const rows = await sql<any[]>`
      SELECT pr.id, pr.request_id, pr.workspace_id, pr.business_name, pr.owner_email, pr.requested_plan, pr.requested_mode,
             pr.requested_slug, pr.status, pr.invite_link, pr.source, pr.error,
             pr.buyer_activation_email_status, pr.buyer_activation_email_sent_at,
             pr.created_at, pr.updated_at,
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
             w.timezone as w_timezone, w.mode as w_mode,
             EXISTS (
               SELECT 1
               FROM activation_events ae
               WHERE ae.provisioning_request_id = pr.id
                 AND ae.event_type = 'checkout_completed'
                 AND ae.status = 'complete'
                 AND ae.detail ->> 'source' = 'stripe_checkout_completed'
                 AND ae.detail ->> 'stripe_livemode' = 'true'
                 AND ae.detail ->> 'payment_status' = 'paid'
            ) as payment_received,
            (
              SELECT wm.invite_expires_at
              FROM workspace_members wm
              WHERE wm.workspace_id = pr.workspace_id
                AND lower(wm.email) = lower(pr.owner_email)
                AND wm.role = 'owner'
              ORDER BY wm.invited_at DESC
              LIMIT 1
            ) as owner_invite_expires_at,
            EXISTS (
              SELECT 1
              FROM workspace_members wm
              WHERE wm.workspace_id = pr.workspace_id
                AND lower(wm.email) = lower(pr.owner_email)
                AND wm.role = 'owner'
                AND wm.accepted_at IS NOT NULL
            ) as owner_invite_accepted,
            EXISTS (
              SELECT 1
              FROM workspace_members wm
              WHERE wm.workspace_id = pr.workspace_id
                AND lower(wm.email) = lower(pr.owner_email)
                AND wm.role = 'owner'
                AND wm.invite_token IS NOT NULL
                AND wm.invite_expires_at > NOW()
                AND (wm.accepted_at IS NULL OR wm.accepted_at > NOW() - INTERVAL '10 minutes')
                AND pr.invite_link LIKE '%/invite/' || wm.invite_token
            ) as owner_invite_active
      FROM provisioning_requests pr
      LEFT JOIN workspaces w ON w.id = pr.workspace_id
      WHERE pr.owner_email = ${email}
        AND pr.request_id = ${checkoutSessionId}
        AND pr.source = 'stripe_checkout_completed'
      ORDER BY pr.created_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return res.status(200).json({
        ok: true,
        email,
        checkout_reference_received: checkoutReferenceReceived,
        checkout_verified: false,
        payment_received: false,
        payment_verified: false,
        access_active: false,
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
    const accessActive = Boolean(workspace && hasWorkspaceBillingEntitlement(workspace.plan, workspace.subscription_status));
    const checkoutVerified = Boolean(checkoutSessionId && row.request_id === checkoutSessionId && row.source === 'stripe_checkout_completed');
    const paymentReceived = Boolean(checkoutVerified && row.payment_received);
    const paymentVerified = Boolean(paymentReceived && accessActive);
    const inviteAccepted = row.owner_invite_accepted === true;
    const inviteAvailable = Boolean(accessActive && row.owner_invite_active && row.buyer_activation_email_status === 'sent');
    const inviteExpired = Boolean(
      accessActive
      && row.buyer_activation_email_status === 'sent'
      && !inviteAccepted
      && !inviteAvailable
      && row.owner_invite_expires_at,
    );
    const activationStatus = buildActivationStatus({
      workspace,
      provisioningRequest: row,
      setupReadiness,
      proofFreshness: buildProofFreshness(null, 0),
      workspaceTwilioNumber: row.w_twilio_phone_configured ? "__configured__" : null,
    });
    const activationDeliveryFailed = ['failed', 'retryable_failed'].includes(String(row.buyer_activation_email_status || ''));
    const exactOperatorException = Boolean(paymentReceived && (
      !workspace
      || !accessActive
      || row.status === 'manual_fallback_required'
      || row.status === 'pending_auto_fulfillment'
      || activationDeliveryFailed
    ));
    const exactReadyForProof = Boolean(
      paymentVerified
      && !exactOperatorException
      && (activationStatus as any)?.readyForProofCall === true
    );
    const exactStage = !paymentReceived
      ? 'payment_pending'
      : exactOperatorException
        ? 'operator_exception'
        : exactReadyForProof
          ? 'proof_ready'
          : workspace
            ? 'setup_required'
            : 'workspace_created';
    const nextStep = !paymentReceived
      ? 'processing'
      : !accessActive
        ? 'billing_inactive'
        : exactOperatorException
          ? 'manual_follow_up'
          : inviteAccepted
            ? 'open_dashboard'
            : inviteAvailable
              ? 'check_owner_email'
              : inviteExpired
                ? 'refresh_owner_invite'
                : 'processing';
    const publicActivationStatus = {
      ...(activationStatus as Record<string, unknown>),
      inviteLink: null,
      workspaceId: null,
      exceptionReason: null,
      stage: exactStage,
      operatorException: exactOperatorException,
      customerNextAction: formatPublicProvisioningNextStep(nextStep),
      paymentReceived,
      paymentActive: paymentVerified,
      readyForProofCall: exactReadyForProof,
    };
    const requestSummary = {
      status: row.status,
      status_label: !accessActive && paymentReceived
        ? "Workspace access paused"
        : inviteExpired
          ? "Secure access link expired"
          : inviteAccepted
            ? "Owner access accepted"
            : formatPublicProvisioningStatus(row.status),
      requested_plan: row.requested_plan,
      requested_mode: row.requested_mode,
      activation_email_delivered: row.buyer_activation_email_status === 'sent',
      invite_available: inviteAvailable,
      invite_accepted: inviteAccepted,
      invite_expired: inviteExpired,
      invite_expires_at: row.owner_invite_expires_at || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return res.status(200).json({
      ok: true,
      found: true,
      email,
      checkout_reference_received: checkoutReferenceReceived,
      checkout_verified: checkoutVerified,
      payment_received: paymentReceived,
      payment_verified: paymentVerified,
      access_active: accessActive,
      request_summary: requestSummary,
      activation_status: publicActivationStatus,
      next_step: nextStep,
      next_step_label: formatPublicProvisioningNextStep(nextStep),
    });
  });

  app.post("/api/provisioning/resend-invite", publicInviteResendRateLimit, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const email = String((req.body as any)?.email || (req.body as any)?.owner_email || "").trim().toLowerCase();
    const checkoutSessionId = normalizeStripeCheckoutSessionId((req.body as any)?.checkout_session_id || (req.body as any)?.session_id);
    if (!email || !checkoutSessionId) {
      return res.status(400).json({ ok: false, error: "valid email and checkout_session_id required" });
    }
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Activation email service is unavailable." });

    const result = await resendCheckoutOwnerInvite({
      checkoutSessionId,
      ownerEmail: email,
      appUrl: resolveTrustedProductionAppOrigin(process.env.APP_URL, getAppUrl()),
    });
    if (result.status === "billing_inactive") {
      return res.status(402).json({ ok: false, error: "Workspace billing is not active.", code: "WORKSPACE_BILLING_INACTIVE" });
    }
    if (result.status === "not_found") {
      return res.status(404).json({ ok: false, error: "Unable to match that secure checkout and owner email." });
    }
    if (!result.ok) {
      return res.status(result.retryable ? 503 : 422).json({
        ok: false,
        error: "A fresh owner email could not be delivered. Try again or request setup help.",
        retryable: result.retryable,
      });
    }
    return res.status(200).json({
      ok: true,
      status: "sent",
      message: "A fresh secure owner invitation was sent to the matching buyer email.",
      invite_expires_at: result.inviteExpiresAt || null,
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

      const inviteLink = `${resolveTrustedProductionAppOrigin(process.env.APP_URL, getAppUrl())}/invite/${ownerInvite.invite_token}`;
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

  app.get("/api/provisioning/checkout-activation-evidence/:checkoutSessionId", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Persistence is not configured." });
    const checkoutSessionId = normalizeStripeCheckoutSessionId(req.params.checkoutSessionId);
    if (!checkoutSessionId) return res.status(400).json({ ok: false, error: "valid checkout session id required" });

    const rows = await sql<any[]>`
      SELECT
        scf.checkout_session_id,
        scf.event_id AS fulfillment_event_id,
        scf.status AS fulfillment_status,
        pr.id AS provisioning_id,
        pr.request_id,
        pr.workspace_id,
        pr.owner_email AS provisioning_owner_email,
        pr.requested_plan,
        pr.source,
        pr.status AS provisioning_status,
        pr.created_at AS provisioning_created_at,
        pr.buyer_activation_email_sent_at,
        w.id AS exact_workspace_id,
        w.owner_email AS workspace_owner_email,
        w.plan AS workspace_plan,
        w.stripe_customer_id,
        w.stripe_subscription_id,
        w.created_at AS workspace_created_at,
        (
          SELECT MAX(ae.created_at)
          FROM activation_events ae
          WHERE ae.provisioning_request_id = pr.id
            AND ae.workspace_id = w.id
            AND ae.event_type = 'checkout_completed'
            AND ae.status = 'complete'
            AND ae.actor = 'system'
        ) AS checkout_completed_at,
        EXISTS (
          SELECT 1
          FROM activation_events ae
          WHERE ae.provisioning_request_id = pr.id
            AND ae.workspace_id = w.id
            AND ae.event_type = 'checkout_completed'
            AND ae.status = 'complete'
            AND ae.actor = 'system'
            AND ae.detail ->> 'source' = 'stripe_checkout_completed'
            AND ae.detail ->> 'stripe_livemode' = 'true'
            AND ae.detail ->> 'payment_status' = 'paid'
            AND COALESCE(ae.detail ->> 'amount_total', '') ~ '^[0-9]+$'
            AND (ae.detail ->> 'amount_total')::numeric > 0
        ) AS checkout_completed_event,
        EXISTS (
          SELECT 1
          FROM activation_events ae
          WHERE ae.provisioning_request_id = pr.id
            AND ae.workspace_id = w.id
            AND ae.event_type = 'workspace_created'
            AND ae.status = 'complete'
            AND ae.actor = 'system'
            AND COALESCE(ae.detail ->> 'existing_workspace', 'false') <> 'true'
        ) AS workspace_created_by_checkout,
        EXISTS (
          SELECT 1
          FROM activation_events ae
          WHERE ae.provisioning_request_id = pr.id
            AND ae.workspace_id = w.id
            AND ae.event_type = 'buyer_activation_email'
            AND ae.status = 'complete'
            AND ae.actor = 'system'
            AND ae.detail ->> 'delivery_status' = 'sent'
            AND COALESCE(ae.detail ->> 'provider_message_id', '') <> ''
            AND ae.detail ->> 'provider_message_id' = pr.buyer_activation_email_provider_id
        )
          AND pr.buyer_activation_email_status = 'sent'
          AND pr.buyer_activation_email_sent_at IS NOT NULL
          AND COALESCE(pr.buyer_activation_email_provider_id, '') <> ''
          AS buyer_activation_email_sent,
        (
          SELECT wm.accepted_at
          FROM workspace_members wm
          WHERE wm.workspace_id = w.id
            AND lower(wm.email) = lower(pr.owner_email)
            AND wm.role = 'owner'
            AND wm.accepted_at IS NOT NULL
          ORDER BY wm.accepted_at ASC
          LIMIT 1
        ) AS owner_invite_accepted_at,
        (
          SELECT MAX(ae.created_at)
          FROM activation_events ae
          WHERE ae.provisioning_request_id = pr.id
            AND ae.workspace_id = w.id
            AND ae.event_type = 'buyer_invite_accepted'
            AND ae.status = 'complete'
            AND ae.actor = 'customer'
            AND ae.detail ->> 'auth_mode' = 'invite'
            AND ae.detail ->> 'auth_provenance' = 'buyer_email_invite_token'
            AND ae.detail ->> 'checkout_session_id' = scf.checkout_session_id
        ) AS buyer_invite_acceptance_event_at,
        (
          SELECT MIN(ae.created_at)
          FROM activation_events ae
          WHERE ae.provisioning_request_id = pr.id
            AND ae.workspace_id = w.id
            AND ae.event_type = 'setup_completed'
            AND ae.status = 'complete'
            AND ae.actor = 'customer'
            AND ae.detail ->> 'auth_mode' = 'workspace'
            AND ae.detail ->> 'auth_provenance' = 'workspace_bearer_token'
        ) AS customer_setup_event_at,
        (
          SELECT MIN(ae.created_at)
          FROM activation_events ae
          WHERE ae.provisioning_request_id = pr.id
            AND ae.workspace_id = w.id
            AND ae.event_type = 'proof_call_requested'
            AND ae.status IN ('open', 'complete')
            AND ae.actor = 'customer'
            AND ae.detail ->> 'auth_mode' = 'workspace'
            AND ae.detail ->> 'auth_provenance' = 'workspace_bearer_token'
        ) AS customer_proof_event_at,
        EXISTS (
          SELECT 1
          FROM activation_events ae
          WHERE ae.workspace_id = w.id
            AND ae.created_at >= pr.created_at
            AND (
              ae.actor = 'operator'
              OR ae.event_type = 'workspace_api_key_revealed_by_operator'
            )
        ) AS operator_rescue_event
      FROM stripe_checkout_fulfillments scf
      JOIN provisioning_requests pr
        ON pr.request_id = scf.checkout_session_id
       AND pr.source = 'stripe_checkout_completed'
      JOIN workspaces w ON w.id = pr.workspace_id
      WHERE scf.checkout_session_id = ${checkoutSessionId}
        AND pr.status = 'workspace_created'
      LIMIT 2
    `;
    if (rows.length > 1) return res.status(409).json({ ok: false, error: "checkout activation evidence is ambiguous" });
    const row = rows[0];
    if (!row) return res.status(404).json({ ok: false, found: false, checkout_session_id: checkoutSessionId });
    const [workspaceRows, phoneRows, knowledgeRows, proofRows] = await Promise.all([
      sql<Workspace[]>`SELECT * FROM workspaces WHERE id = ${Number(row.exact_workspace_id)} LIMIT 1`,
      sql<{ phone_number: string }[]>`
        SELECT phone_number
        FROM workspace_phone_numbers
        WHERE workspace_id = ${Number(row.exact_workspace_id)}
          AND enabled = TRUE
        ORDER BY id DESC
        LIMIT 1
      `,
      sql<{ count: string | number }[]>`
        SELECT COUNT(*) AS count
        FROM workspace_knowledge_sources
        WHERE workspace_id = ${Number(row.exact_workspace_id)}
      `,
      sql<{ count: string | number; latest_at: string | Date | null }[]>`
        SELECT
          COUNT(DISTINCT c.call_sid) AS count,
          MAX(c.started_at) AS latest_at
        FROM calls c
        JOIN call_summaries cs ON cs.call_sid = c.call_sid
        JOIN tasks t ON t.call_sid = c.call_sid
          AND t.task_type IN ('callback', 'handoff', 'escalate_to_human')
        JOIN call_events ce ON ce.call_sid = c.call_sid
          AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
        WHERE c.workspace_id = ${Number(row.exact_workspace_id)}
      `,
    ]);
    const workspace = workspaceRows[0];
    if (!workspace) return res.status(409).json({ ok: false, error: "checkout workspace evidence is missing" });
    const completeProofCalls = Number(proofRows[0]?.count || 0);
    const proofFreshness = buildProofFreshness(proofRows[0]?.latest_at, completeProofCalls) as any;
    const workspaceTwilioNumber = workspace.twilio_phone_number || phoneRows[0]?.phone_number || null;
    const setupReadiness = buildSetupReadiness({
      workspace,
      workspaceTwilioNumber,
      knowledgeSourceCount: Number(knowledgeRows[0]?.count || 0),
      proofFreshness,
    }) as any;
    const activationStatus = buildActivationStatus({
      workspace,
      provisioningRequest: {
        id: row.provisioning_id,
        workspace_id: row.workspace_id,
        source: row.source,
        status: row.provisioning_status,
      },
      setupReadiness,
      proofFreshness,
      workspaceTwilioNumber,
    }) as any;
    return res.status(200).json({
      ok: true,
      found: true,
      checkout_session_id: row.checkout_session_id,
      fulfillment: {
        status: row.fulfillment_status,
        event_id: row.fulfillment_event_id,
      },
      provisioning: {
        id: row.provisioning_id,
        request_id: row.request_id,
        workspace_id: row.workspace_id,
        owner_email: row.provisioning_owner_email,
        requested_plan: row.requested_plan,
        source: row.source,
        status: row.provisioning_status,
        created_at: row.provisioning_created_at,
      },
      workspace: {
        id: row.exact_workspace_id,
        owner_email: row.workspace_owner_email,
        plan: row.workspace_plan,
        stripe_customer_id: row.stripe_customer_id,
        stripe_subscription_id: row.stripe_subscription_id,
        created_at: row.workspace_created_at,
      },
      automatic_chain: {
        checkout_completed_event: row.checkout_completed_event === true,
        checkout_completed_at: row.checkout_completed_at || null,
        workspace_created_by_checkout: row.workspace_created_by_checkout === true,
        buyer_activation_email_sent: row.buyer_activation_email_sent === true,
        buyer_activation_email_sent_at: row.buyer_activation_email_sent_at || null,
        owner_invite_accepted: Boolean(row.owner_invite_accepted_at),
        owner_invite_accepted_at: row.owner_invite_accepted_at || null,
        buyer_invite_acceptance_event: Boolean(row.buyer_invite_acceptance_event_at),
        buyer_invite_acceptance_event_at: row.buyer_invite_acceptance_event_at || null,
        customer_setup_event: Boolean(row.customer_setup_event_at),
        customer_setup_event_at: row.customer_setup_event_at || null,
        customer_proof_event: Boolean(row.customer_proof_event_at),
        customer_proof_event_at: row.customer_proof_event_at || null,
        operator_rescue_event: row.operator_rescue_event === true,
        operator_authored_activation_event: row.operator_rescue_event === true,
      },
      current_state: {
        activation_stage: String(activationStatus?.stage || ""),
        setup_ready: setupReadiness?.ready === true,
        proof_fresh: proofFreshness?.fresh === true,
        setup_completed_at: workspace.setup_completed_at || null,
        complete_proof_calls: completeProofCalls,
        latest_complete_proof_at: proofFreshness?.latestCompleteProofAt || null,
      },
    });
  });

  app.get("/api/provisioning/requests", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
    if (!dbEnabled) {
      return res.json({ requests: [] });
    }

    const rows = await sql`
      SELECT pr.id, pr.request_id, pr.workspace_id, pr.business_name, pr.owner_email, pr.requested_plan, pr.requested_mode,
             pr.requested_slug, pr.status, pr.error, pr.source, pr.ip, pr.created_at, pr.updated_at,
             pr.owner_name, pr.owner_phone, pr.business_phone, pr.business_website, pr.business_type, pr.service_area,
             pr.intake_notes, pr.deposit_percent, pr.deposit_status, pr.balance_status, pr.onboarding_source,
             pr.caller_phone, pr.trusted_intake, pr.handoff_team_member_id,
             w.plan as workspace_plan, w.subscription_status, w.trial_ends_at, w.calls_this_month, w.minutes_this_month,
             w.stripe_customer_id,
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
               WHEN EXISTS (
                 SELECT 1
                 FROM activation_events ae
                 WHERE ae.provisioning_request_id = pr.id
                   AND ae.event_type = 'checkout_completed'
                   AND ae.status = 'complete'
                   AND ae.detail ->> 'stripe_livemode' = 'true'
                   AND ae.detail ->> 'payment_status' = 'paid'
                   AND COALESCE(ae.detail ->> 'amount_total', '') ~ '^[0-9]+$'
                   AND (ae.detail ->> 'amount_total')::numeric > 0
                   AND NOT EXISTS (
                     SELECT 1
                     FROM activation_events refund_event
                     WHERE refund_event.workspace_id = w.id
                       AND refund_event.detail ->> 'exact_subscription_binding' = 'true'
                       AND (
                         (
                           refund_event.event_type = 'billing_refund_recorded'
                           AND refund_event.detail ->> 'fully_refunded' = 'true'
                         )
                         OR (
                           refund_event.event_type = 'billing_dispute_recorded'
                           AND refund_event.detail ->> 'disputed' = 'true'
                         )
                       )
                       AND refund_event.created_at > ae.created_at
                   )
               ) THEN TRUE
               ELSE FALSE
             END as paid_signal
      FROM provisioning_requests pr
      LEFT JOIN workspaces w ON w.id = pr.workspace_id
      ORDER BY pr.created_at DESC
      LIMIT ${limit}
    `;
    const enriched = rows.map((row: any) => {
      const hasWorkspace = Boolean(row.workspace_id);
      const paymentActive = hasWorkspace
        ? Boolean(row.subscription_status === "active" && row.stripe_customer_id && row.paid_signal)
        : Boolean(row.paid_signal);
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
