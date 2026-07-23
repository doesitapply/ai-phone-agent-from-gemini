import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { Workspace } from "../saas.js";
import { evaluateCustomerPolicyApproval } from "../customer-policy-approval.js";
import { describeFirstDollarVoiceHealth } from "../first-dollar-voice-readiness.js";
import { evaluatePaymentLinkConfiguration } from "../payment-link-configuration.js";

type OpsServiceStatus = {
  id: string;
  label: string;
  status: "online" | "warn" | "offline" | "unknown";
};

type SystemHealthRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: (req: Request, res: Response, next: NextFunction) => void;
  sql: any;
  env: {
    OPENROUTER_API_KEY?: string;
    OPENROUTER_ENABLED?: string;
    GEMINI_API_KEY?: string;
    CARTESIA_API_KEY?: string;
    ELEVENLABS_API_KEY?: string;
    ELEVENLABS_ENABLED?: string;
    GOOGLE_TTS_API_KEY?: string;
    GOOGLE_SERVICE_ACCOUNT_JSON?: string;
    GOOGLE_TTS_ENABLED?: string;
    OPENAI_API_KEY?: string;
    FAST_LIVE_CALLS?: string;
    TWILIO_ACCOUNT_SID?: string;
    TWILIO_AUTH_TOKEN?: string;
    TWILIO_PHONE_NUMBER?: string;
    WEBHOOK_URL?: string;
    OUTBOUND_WEBHOOK_URL?: string;
    FROM_EMAIL?: string;
    RESEND_API_KEY?: string;
    OWNER_PHONE?: string;
    STRIPE_PAYMENT_LINK_STARTER?: string;
    STRIPE_PAYMENT_LINK_STARTER_ID?: string;
    STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS?: string;
    STRIPE_PAYMENT_LINK_PRO?: string;
    STRIPE_PAYMENT_LINK_PRO_ID?: string;
    STRIPE_PAYMENT_LINK_ENTERPRISE?: string;
    STRIPE_PAYMENT_LINK_ENTERPRISE_ID?: string;
    SMIRK_CUSTOMER_POLICY_APPROVED_VERSION?: string;
  };
  getWorkspaceId: (req: Request) => number;
  getWorkspaceById: (id: number) => Promise<Workspace | null>;
  getOpenRouterModel: () => string | null;
  buildOpsMonitor: (workspaceId: number) => Promise<{ services: OpsServiceStatus[]; spend: any; config: any[]; generatedAt: string }>;
};

export function registerSystemHealthRoutes(app: Express, deps: SystemHealthRouteDeps): void {
  const {
    dashboardAuth,
    requireOperator,
    sql,
    env,
    getWorkspaceId,
    getWorkspaceById,
    getOpenRouterModel,
    buildOpsMonitor,
  } = deps;

  app.get("/api/system-health", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const checks: { id: string; label: string; status: 'pass'|'fail'|'warn'; detail: string }[] = [];
    const check = (id: string, label: string, pass: boolean, warn: boolean, detail: string) => {
      checks.push({ id, label, status: pass ? 'pass' : warn ? 'warn' : 'fail', detail });
    };
    let dbPass = false;
    let aiPass = false;
    let twilioPass = false;
    let ownerAlertsPass = false;
    let ownerAlertsWarn = false;
    let paymentPass = false;
    let paymentWarn = false;
    let callbackPass = false;

    try {
      await sql`SELECT 1`;
      dbPass = true;
      check('db', 'Database', true, false, 'Postgres connection healthy');
    } catch (e: any) {
      check('db', 'Database', false, false, `DB error: ${e.message}`);
    }

    const aiOk = !!(env.OPENROUTER_API_KEY || env.GEMINI_API_KEY);
    aiPass = aiOk;
    const aiDetail = env.OPENROUTER_API_KEY ? `OpenRouter (${getOpenRouterModel() || 'default'})` : env.GEMINI_API_KEY ? 'Gemini 2.5 Flash' : 'No AI key set — add OPENROUTER_API_KEY';
    check('ai', 'AI Brain', aiOk, false, aiDetail);

    const voiceHealth = describeFirstDollarVoiceHealth(env);
    check('voice', 'Voice Engine', voiceHealth.ready, !voiceHealth.ready, voiceHealth.detail);

    const twilioOk = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
    twilioPass = twilioOk;
    check('twilio', 'Twilio', twilioOk, false, twilioOk ? `Phone: ${env.TWILIO_PHONE_NUMBER}` : 'Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER');

    try {
      const agentRows = await sql`SELECT name FROM agent_configs WHERE is_active = TRUE LIMIT 1`;
      check('agent', 'Active Agent', agentRows.length > 0, false, agentRows.length > 0 ? `Active: ${agentRows[0].name}` : 'No active agent — go to Agents tab and activate one');
    } catch {
      check('agent', 'Active Agent', false, false, 'Could not query agent_configs');
    }

    try {
      const callRows = await sql`SELECT COUNT(*) as count FROM calls`;
      const count = Number(callRows[0].count);
      check('calls', 'Call Records', true, count === 0, count === 0 ? 'No calls yet — make a test call to verify the pipeline' : `${count} call(s) recorded`);
    } catch {
      check('calls', 'Call Records', false, false, 'Could not query calls table');
    }

    try {
      const sumRows = await sql`SELECT COUNT(*) as count FROM call_summaries`;
      const count = Number(sumRows[0].count);
      check('intelligence', 'Post-Call Intelligence', aiOk, !aiOk, count === 0 ? (aiOk ? 'AI configured — summaries will appear after first call' : 'No AI key — summaries disabled') : `${count} summary(ies) generated`);
    } catch {
      check('intelligence', 'Post-Call Intelligence', false, false, 'Could not query call_summaries');
    }

    try {
      const contactRows = await sql`SELECT COUNT(*) as count FROM contacts`;
      const fieldRows = await sql`SELECT COUNT(*) as count FROM contact_custom_fields`;
      const count = Number(contactRows[0].count);
      const fields = Number(fieldRows[0].count);
      check('contacts', 'Contacts & CRM', true, count === 0, count === 0 ? 'No contacts yet — they populate automatically from calls' : `${count} contact(s), ${fields} extracted field(s)`);
    } catch {
      check('contacts', 'Contacts & CRM', false, false, 'Could not query contacts');
    }

    const webhookUrl = env.WEBHOOK_URL || env.OUTBOUND_WEBHOOK_URL;
    check(
      'webhook',
      'Outbound Webhook',
      true,
      false,
      webhookUrl
        ? `Configured: ${webhookUrl.substring(0, 40)}...`
        : 'Optional CRM/Zapier webhook not configured — not required for Smart Voicemail go-live.'
    );

    const customerPolicyApproval = evaluateCustomerPolicyApproval(env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION);
    const paymentLinkConfiguration = evaluatePaymentLinkConfiguration(env, {
      enterpriseUsageReady: customerPolicyApproval.enterpriseUsageReady,
    });
    paymentPass = paymentLinkConfiguration.ready;
    paymentWarn = false;
    check(
      'payment_path',
      'Payment Link Configuration',
      paymentLinkConfiguration.ready,
      false,
      paymentLinkConfiguration.ready
        ? `Starter $197/month URL + exact current/historical plink_ fulfillment IDs are configured and Pro/Agency are disabled; provider verification is not checked here and remains required`
        : paymentLinkConfiguration.configuredPlans.length > 0
          ? `Payment Link configuration blocked: ${paymentLinkConfiguration.blockers.join(', ')}; provider verification is not checked here`
          : 'Paid signup blocked — configure the exact Starter $197/month URL + current/historical plink_ fulfillment IDs and keep Pro/Agency disabled; provider verification is not checked here'
    );

    try {
      const workspaceId = getWorkspaceId(req) || 1;
      const workspace = await getWorkspaceById(workspaceId).catch(() => null);
      const ownerEmail = workspace?.owner_email || null;
      const fromEmail = String(env.FROM_EMAIL || '').trim();
      const senderDomainMatch = fromEmail.match(/@([^>\s]+)>?$/);
      const senderDomain = senderDomainMatch?.[1]?.toLowerCase() || null;
      const senderReady = !!(fromEmail && !/yourdomain\.com|example\.com/i.test(fromEmail));
      const senderLooksPlaceholder = !!(fromEmail && /yourdomain\.com|example\.com/i.test(fromEmail));
      const senderIsSmirk = senderDomain === 'smirkcalls.com';
      const emailReady = !!(ownerEmail && env.RESEND_API_KEY && senderReady);
      const fallbackReady = !!(webhookUrl || env.OWNER_PHONE);
      ownerAlertsPass = emailReady;
      ownerAlertsWarn = !emailReady && fallbackReady;
      check(
        'owner_alerts',
        'Owner Alerts',
        emailReady,
        !emailReady && fallbackReady,
        emailReady
          ? `Email alerts ready for ${ownerEmail} via ${fromEmail}`
          : senderLooksPlaceholder
            ? 'Owner email blocked — FROM_EMAIL is still a placeholder sender. Run npm run cutover:sender-domain -- --dry-run, verify smirkcalls.com in Resend, then set FROM_EMAIL to alerts@smirkcalls.com'
            : senderIsSmirk
              ? 'Owner email almost ready — FROM_EMAIL is already on smirkcalls.com, but that sender still needs Resend domain verification or a workspace owner_email'
              : fallbackReady
                ? `Email alert path incomplete — fallback delivery exists, but workspace owner_email or a verified smirkcalls.com sender still needs to be configured (current sender: ${senderDomain || 'missing'})`
                : 'No owner alert delivery path configured — set workspace owner_email plus RESEND_API_KEY and a verified smirkcalls.com FROM_EMAIL'
      );
    } catch {
      check('owner_alerts', 'Owner Alerts', false, false, 'Could not verify workspace owner_email or alert configuration');
    }

    const callbackReady = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
    callbackPass = callbackReady;
    check(
      'callbacks',
      'Callback Automation',
      callbackReady,
      !callbackReady,
      callbackReady
        ? 'Callback tasks can be executed by the scheduled outbound caller'
        : 'Callback executor blocked — configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER'
    );

    const proofLoopPass = dbPass && aiPass && twilioPass && ownerAlertsPass && callbackPass && paymentPass;
    const proofLoopWarn = dbPass && aiPass && twilioPass && callbackPass && (ownerAlertsWarn || paymentWarn);
    check(
      'proof_loop',
      'Missed-Call Proof Loop',
      proofLoopPass,
      proofLoopWarn,
      proofLoopPass
        ? 'Ready to test summary + owner email + callback task + dashboard proof'
        : proofLoopWarn
          ? 'Almost ready, but paid signup or owner alerts still need final real-world configuration'
          : 'Not ready for end-to-end proof yet — fix the failed dependency checks above first'
    );

    check('auth', 'Dashboard Auth', true, false, 'Session valid — you are authenticated');

    const workspaceId = getWorkspaceId(req) || 1;
    const ops = await buildOpsMonitor(workspaceId);
    const criticalProviderFailures = ops.services.filter((s) =>
      ["twilio", "openrouter", "stripe", "resend"].includes(s.id) && s.status === "offline"
    );
    const warningProviders = ops.services.filter((s) =>
      ["twilio", "openrouter", "stripe", "resend", "google_calendar"].includes(s.id) && (s.status === "warn" || s.status === "unknown")
    );
    check(
      "provider_monitor",
      "Provider Auth Monitor",
      criticalProviderFailures.length === 0,
      criticalProviderFailures.length === 0 && warningProviders.length > 0,
      criticalProviderFailures.length > 0
        ? `Provider auth failed: ${criticalProviderFailures.map((s) => s.label).join(", ")}`
        : warningProviders.length > 0
          ? `Provider warnings: ${warningProviders.map((s) => s.label).join(", ")}`
          : "Critical provider auth probes passed"
    );

    const passed = checks.filter(c => c.status === 'pass').length;
    const warned = checks.filter(c => c.status === 'warn').length;
    const failed = checks.filter(c => c.status === 'fail').length;

    res.json({ checks, summary: { passed, warned, failed, total: checks.length }, ops });
  });
}
