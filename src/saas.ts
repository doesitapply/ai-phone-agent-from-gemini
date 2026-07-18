/**
 * SaaS Multi-Tenant Layer
 *
 * Transforms SMIRK from a single-operator tool into a sellable product.
 * Each "workspace" is a business that has purchased SMIRK.
 *
 * Architecture:
 *   - Workspaces: isolated business accounts with their own agents, contacts, calls
 *   - Plans: free (demo), starter ($197/mo), pro ($397/mo), enterprise ($697/mo)
 *   - Invites: workspace owners can invite team members
 *   - Billing: Stripe subscription hooks (create, update, cancel)
 *   - Usage: track call minutes, AI tokens, TTS characters per workspace per month
 *
 * In single-operator mode (WORKSPACE_ID not set), everything runs as workspace 1.
 * In SaaS mode, each request carries a workspace token in the Authorization header.
 */

import { randomBytes } from "crypto";
import { sql } from "./db.js";
import { PLAN_LIMITS } from "./plan-limits.js";
import { sendBuyerActivationEmail, sendProvisioningAlert } from "./monetization-alerts.js";
import { normalizeTrustedProductionAppUrl, resolveTrustedProductionAppOrigin } from "./public-url-safety.js";
import { classifySmirkCheckoutForFulfillment, paymentLinkFulfillmentBindingsFromEnv, strictSmirkPaidPlan } from "./checkout-safety.js";
import { customerPolicyReadyForPlan, evaluateCustomerPolicyApproval } from "./customer-policy-approval.js";
import { extractPaidCheckoutException } from "./paid-checkout-exception.js";
import { candidateStarterPaymentLinkFulfillmentIds } from "./payment-link-fulfillment-ids.js";
import {
  checkoutFulfillmentLeaseCutoff,
  hasWorkspaceBillingEntitlement,
  isRestrictiveWorkspaceBillingStatus,
  matchesExactStripeWorkspaceBinding,
  normalizeStripeSubscriptionStatus,
  stripeBillingEventCreatedSeconds,
  type WorkspaceBillingStatus,
} from "./billing-safety.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Workspace {
  id: number;
  slug: string;           // URL-safe identifier, e.g. "acme-plumbing"
  name: string;           // Display name, e.g. "Acme Plumbing"
  owner_email: string;
  plan: "free" | "starter" | "pro" | "enterprise";
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  stripe_billing_event_created?: number;
  stripe_billing_event_id?: string;
  subscription_status: WorkspaceBillingStatus;
  trial_ends_at?: string;
  monthly_call_limit: number;   // positive hard cap; non-positive fails closed
  monthly_minute_limit: number; // positive hard cap; non-positive fails closed
  calls_this_month: number;
  minutes_this_month: number;
  api_key: string;        // Bearer token for API access
  dashboard_password_hash?: string;
  twilio_account_sid?: string;
  twilio_auth_token?: string;
  twilio_phone_number?: string;
  openrouter_api_key?: string;
  elevenlabs_api_key?: string;
  gemini_api_key?: string;
  webhook_url?: string;
  timezone: string;
  mode?: "general" | "missed_call_recovery";
  // Per-workspace business identity
  business_name?: string;
  business_tagline?: string;
  business_phone?: string;
  business_website?: string;
  business_address?: string;
  service_area?: string;
  business_hours?: string;
  escalation_preference?: string;
  proof_call_target?: string;
  agent_name?: string;
  agent_persona?: string;
  inbound_greeting?: string;
  outbound_greeting?: string;
  owner_phone?: string;
  notification_email?: string;
  setup_completed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: number;
  workspace_id: number;
  email: string;
  role: "owner" | "admin" | "viewer";
  invited_at: string;
  accepted_at?: string | null;
  invite_token?: string | null;
  invite_expires_at?: string | null;
}

export interface ActivationEvent {
  id: number;
  workspace_id?: number | null;
  provisioning_request_id?: number | null;
  event_type: string;
  status: "open" | "blocked" | "complete" | "info";
  actor: "customer" | "operator" | "system";
  detail: Record<string, unknown>;
  created_at: string;
}

export { PLAN_LIMITS };

// ── DB Schema ──────────────────────────────────────────────────────────────────

export async function initSaasSchema(): Promise<void> {
  console.log("[saas] Initializing SaaS schema...");
  await sql`
    CREATE TABLE IF NOT EXISTS workspaces (
      id                      SERIAL PRIMARY KEY,
      slug                    TEXT UNIQUE NOT NULL,
      name                    TEXT NOT NULL,
      owner_email             TEXT NOT NULL,
      plan                    TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id      TEXT,
      stripe_subscription_id  TEXT,
      subscription_status     TEXT NOT NULL DEFAULT 'none',
      trial_ends_at           TIMESTAMPTZ,
      monthly_call_limit      INTEGER NOT NULL DEFAULT 50,
      monthly_minute_limit    INTEGER NOT NULL DEFAULT 100,
      calls_this_month        INTEGER NOT NULL DEFAULT 0,
      minutes_this_month      INTEGER NOT NULL DEFAULT 0,
      api_key                 TEXT UNIQUE NOT NULL,
      dashboard_password_hash TEXT,
      twilio_account_sid      TEXT,
      twilio_auth_token       TEXT,
      twilio_phone_number     TEXT,
      openrouter_api_key      TEXT,
      elevenlabs_api_key      TEXT,
      gemini_api_key          TEXT,
      webhook_url             TEXT,
      timezone                TEXT NOT NULL DEFAULT 'America/New_York',
      mode                    TEXT NOT NULL DEFAULT 'general',
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Mode is a product-shape switch (not a feature grab bag).
  // It locks defaults and routing so "Missed-Call Recovery" can be sold as a wedge.
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'general'`;

  // Per-workspace business identity — replaces global env vars for multi-tenant
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS business_name TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS business_tagline TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS business_phone TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS business_website TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS business_address TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS service_area TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS business_hours TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS escalation_preference TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS proof_call_target TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_name TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_persona TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS inbound_greeting TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS outbound_greeting TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_phone TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS notification_email TEXT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS setup_completed_at TIMESTAMPTZ`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_billing_event_created BIGINT`;
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_billing_event_id TEXT`;

  // Durable, resumable managed-Twilio provisioning. A per-workspace lease
  // serializes concurrent activation requests, while provider identifiers are
  // checkpointed independently so a retry can reconcile provider success
  // instead of purchasing another subaccount or phone number.
  await sql`
    CREATE TABLE IF NOT EXISTS workspace_telephony_provisioning (
      workspace_id          INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      status                TEXT NOT NULL DEFAULT 'pending',
      lease_token           TEXT,
      lease_expires_at      TIMESTAMPTZ,
      subaccount_sid        TEXT,
      encrypted_auth_token  TEXT,
      phone_number          TEXT,
      phone_number_sid      TEXT,
      area_code_used        TEXT,
      last_error            TEXT,
      completed_at          TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (status IN ('pending', 'running', 'failed', 'completed'))
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_telephony_subaccount_unique
    ON workspace_telephony_provisioning(subaccount_sid)
    WHERE subaccount_sid IS NOT NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_telephony_phone_sid_unique
    ON workspace_telephony_provisioning(phone_number_sid)
    WHERE phone_number_sid IS NOT NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_telephony_phone_unique
    ON workspace_telephony_provisioning(phone_number)
    WHERE phone_number IS NOT NULL
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS workspace_members (
      id           SERIAL PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email        TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'viewer',
      invited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at  TIMESTAMPTZ,
      invite_token TEXT UNIQUE,
      invite_expires_at TIMESTAMPTZ,
      UNIQUE(workspace_id, email)
    )
  `;
  await sql`ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ`;
  await sql`
    UPDATE workspace_members
    SET invite_expires_at = NOW() + INTERVAL '7 days'
    WHERE invite_token IS NOT NULL AND invite_expires_at IS NULL
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS workspace_usage (
      id           SERIAL PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      month        TEXT NOT NULL,  -- YYYY-MM
      calls        INTEGER NOT NULL DEFAULT 0,
      minutes      INTEGER NOT NULL DEFAULT 0,
      ai_tokens    INTEGER NOT NULL DEFAULT 0,
      tts_chars    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(workspace_id, month)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS provisioning_requests (
      id                  SERIAL PRIMARY KEY,
      request_id          TEXT,
      workspace_id        INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      business_name       TEXT NOT NULL,
      owner_email         TEXT NOT NULL,
      requested_plan      TEXT NOT NULL DEFAULT 'starter',
      requested_mode      TEXT NOT NULL DEFAULT 'missed_call_recovery',
      requested_slug      TEXT,
      status              TEXT NOT NULL DEFAULT 'manual_fallback_required',
      invite_link         TEXT,
      workspace_api_key   TEXT,
      source              TEXT NOT NULL DEFAULT 'signup',
      ip                  TEXT,
      error               TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_provisioning_requests_owner_email ON provisioning_requests(owner_email, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_provisioning_requests_status ON provisioning_requests(status, created_at DESC)`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS owner_name TEXT`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS owner_phone TEXT`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS business_phone TEXT`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS business_website TEXT`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS business_type TEXT`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS service_area TEXT`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS intake_notes TEXT`;
  // Legacy columns remain for backward compatibility. New intakes use one full,
  // secure recurring checkout rather than an unapproved deposit/balance split.
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS deposit_percent INTEGER NOT NULL DEFAULT 100`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS deposit_status TEXT NOT NULL DEFAULT 'checkout_required'`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS balance_status TEXT NOT NULL DEFAULT 'not_applicable'`;
  await sql`ALTER TABLE provisioning_requests ALTER COLUMN deposit_percent SET DEFAULT 100`;
  await sql`ALTER TABLE provisioning_requests ALTER COLUMN deposit_status SET DEFAULT 'checkout_required'`;
  await sql`ALTER TABLE provisioning_requests ALTER COLUMN balance_status SET DEFAULT 'not_applicable'`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS onboarding_source TEXT`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS caller_phone TEXT`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS trusted_intake BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS handoff_team_member_id INTEGER`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS buyer_activation_email_status TEXT NOT NULL DEFAULT 'not_sent'`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS buyer_activation_email_sent_at TIMESTAMPTZ`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS buyer_activation_email_provider_id TEXT`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS buyer_activation_email_error TEXT`;

  await sql`
    CREATE TABLE IF NOT EXISTS activation_events (
      id                       SERIAL PRIMARY KEY,
      workspace_id             INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      provisioning_request_id  INTEGER REFERENCES provisioning_requests(id) ON DELETE SET NULL,
      event_type               TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'info',
      actor                    TEXT NOT NULL DEFAULT 'system',
      detail                   JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE activation_events ALTER COLUMN workspace_id DROP NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_activation_events_workspace ON activation_events(workspace_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_activation_events_type ON activation_events(event_type, created_at DESC)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activation_events_checkout_invite_accept_unique
    ON activation_events(provisioning_request_id, ((detail ->> 'accepted_at')))
    WHERE event_type = 'buyer_invite_accepted'
      AND status = 'complete'
      AND provisioning_request_id IS NOT NULL
      AND detail ->> 'accepted_at' IS NOT NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activation_events_proof_request_terminal_unique
    ON activation_events(((detail ->> 'proof_request_event_id')))
    WHERE event_type IN ('proof_call_dispatch_claimed', 'proof_call_dispatched')
      AND status IN ('open', 'outcome_unknown', 'in_progress', 'complete')
      AND detail ->> 'proof_request_event_id' IS NOT NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activation_events_workspace_active_proof_unique
    ON activation_events(workspace_id)
    WHERE event_type IN ('proof_call_dispatch_claimed', 'proof_call_dispatched')
      AND status IN ('open', 'outcome_unknown', 'in_progress')
      AND workspace_id IS NOT NULL
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS stripe_checkout_fulfillments (
      checkout_session_id  TEXT PRIMARY KEY,
      event_id             TEXT,
      claim_token          TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'processing',
      last_error           TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE stripe_checkout_fulfillments ADD COLUMN IF NOT EXISTS claim_token TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_stripe_checkout_fulfillments_status ON stripe_checkout_fulfillments(status, updated_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS stripe_paid_checkout_exceptions (
      checkout_session_id   TEXT PRIMARY KEY,
      stripe_event_id       TEXT NOT NULL,
      payment_link_id       TEXT,
      stripe_customer_id    TEXT,
      stripe_subscription_id TEXT,
      buyer_email           TEXT NOT NULL,
      business_name         TEXT NOT NULL,
      owner_phone           TEXT,
      plan                  TEXT NOT NULL,
      amount_subtotal       BIGINT NOT NULL DEFAULT 0,
      amount_total          BIGINT NOT NULL DEFAULT 0,
      currency              TEXT NOT NULL,
      reason                TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'manual_review_required',
      first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_stripe_paid_checkout_exceptions_status ON stripe_paid_checkout_exceptions(status, updated_at DESC)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_stripe_subscription_unique
    ON workspaces(stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_requests_stripe_session_unique
    ON provisioning_requests(request_id)
    WHERE source = 'stripe_checkout_completed' AND request_id IS NOT NULL
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_requests_stripe_exception_unique
    ON provisioning_requests(request_id)
    WHERE source = 'stripe_checkout_exception' AND request_id IS NOT NULL
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS stripe_invoice_payment_facts (
      payment_intent_id  TEXT PRIMARY KEY,
      invoice_id         TEXT NOT NULL,
      customer_id        TEXT NOT NULL,
      subscription_id    TEXT NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_stripe_invoice_payment_facts_subscription ON stripe_invoice_payment_facts(customer_id, subscription_id, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS stripe_subscription_state_facts (
      subscription_id  TEXT PRIMARY KEY,
      customer_id      TEXT NOT NULL,
      status           TEXT NOT NULL,
      source_event_type TEXT NOT NULL,
      event_created    BIGINT NOT NULL,
      event_id         TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_stripe_subscription_state_facts_customer ON stripe_subscription_state_facts(customer_id, event_created DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS stripe_payment_bindings (
      payment_intent_id  TEXT PRIMARY KEY,
      workspace_id       INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
      invoice_id         TEXT NOT NULL,
      customer_id        TEXT NOT NULL,
      subscription_id    TEXT NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE stripe_payment_bindings ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE`;
  await sql`CREATE INDEX IF NOT EXISTS idx_stripe_payment_bindings_subscription ON stripe_payment_bindings(subscription_id, updated_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS stripe_payment_adverse_events (
      payment_intent_id  TEXT PRIMARY KEY,
      customer_id        TEXT,
      charge_id          TEXT,
      fully_refunded     BOOLEAN NOT NULL DEFAULT FALSE,
      disputed           BOOLEAN NOT NULL DEFAULT FALSE,
      stripe_event_id    TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Seed a default workspace if none exists (single-operator mode)
  const existing = await sql`SELECT id FROM workspaces LIMIT 1`;
  if (existing.length === 0) {
    const apiKey = generateApiKey();
    const ownerEmail = process.env.OWNER_EMAIL || 'owner@example.com';
    await sql`
      INSERT INTO workspaces (slug, name, owner_email, plan, subscription_status, monthly_call_limit, monthly_minute_limit, api_key)
      VALUES ('default', 'My Business', ${ownerEmail}, 'pro', 'active', -1, -1, ${apiKey})
    `;
  } else if (process.env.OWNER_EMAIL) {
    // Update placeholder email if OWNER_EMAIL is now configured
    await sql`UPDATE workspaces SET owner_email = ${process.env.OWNER_EMAIL} WHERE owner_email = 'owner@example.com'`;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function generateApiKey(): string {
  return `smirk_${randomBytes(32).toString("hex")}`;
}

function generateInviteToken(): string {
  return randomBytes(32).toString("hex");
}

// ── Workspace CRUD ─────────────────────────────────────────────────────────────

export async function getWorkspaces(): Promise<Workspace[]> {
  return sql<Workspace[]>`SELECT * FROM workspaces ORDER BY created_at DESC`;
}

export async function getWorkspaceById(id: number): Promise<Workspace | null> {
  const rows = await sql<Workspace[]>`SELECT * FROM workspaces WHERE id = ${id}`;
  return rows[0] || null;
}

export async function getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  const rows = await sql<Workspace[]>`SELECT * FROM workspaces WHERE slug = ${slug}`;
  return rows[0] || null;
}

export async function getWorkspaceByApiKey(apiKey: string): Promise<Workspace | null> {
  const rows = await sql<Workspace[]>`SELECT * FROM workspaces WHERE api_key = ${apiKey}`;
  return rows[0] || null;
}

export async function createWorkspace(data: {
  name: string;
  owner_email: string;
  plan?: "free" | "starter" | "pro" | "enterprise";
  mode?: "general" | "missed_call_recovery";
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  stripe_billing_event_created?: number | null;
  stripe_billing_event_id?: string | null;
  subscription_status?: WorkspaceBillingStatus;
  business_name?: string | null;
  owner_phone?: string | null;
  notification_email?: string | null;
}): Promise<Workspace> {
  const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50)
    + "-" + Math.random().toString(36).slice(2, 6);
  const apiKey = generateApiKey();
  const plan = data.plan || "free";
  const limits = PLAN_LIMITS[plan];
  const trialEndsAt = plan === "free" ? new Date(Date.now() + 14 * 86400_000).toISOString() : null;
  const mode = data.mode || "general";

  const rows = await sql<Workspace[]>`
    INSERT INTO workspaces (
      slug, name, owner_email, plan, subscription_status,
      monthly_call_limit, monthly_minute_limit, api_key, trial_ends_at, mode,
      stripe_customer_id, stripe_subscription_id, stripe_billing_event_created, stripe_billing_event_id,
      business_name, owner_phone, notification_email
    )
    VALUES (
      ${slug}, ${data.name}, ${data.owner_email}, ${plan}, ${data.subscription_status || (plan === "free" ? "trialing" : "active")},
      ${limits.calls}, ${limits.minutes}, ${apiKey}, ${trialEndsAt}, ${mode},
      ${data.stripe_customer_id || null}, ${data.stripe_subscription_id || null},
      ${data.stripe_billing_event_created || null}, ${data.stripe_billing_event_id || null}, ${data.business_name || null},
      ${data.owner_phone || null}, ${data.notification_email || null}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function provisionWorkspace(data: {
  name: string;
  owner_email: string;
  plan?: "free" | "starter" | "pro" | "enterprise";
  slug?: string;
  mode?: "general" | "missed_call_recovery";
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  stripe_billing_event_created?: number | null;
  stripe_billing_event_id?: string | null;
  subscription_status?: WorkspaceBillingStatus;
  business_name?: string | null;
  owner_phone?: string | null;
  notification_email?: string | null;
}): Promise<{ workspace: Workspace; ownerInvite: WorkspaceMember }> {
  const workspace = await createWorkspace({
    name: data.name,
    owner_email: data.owner_email,
    plan: data.plan || "starter",
    mode: data.mode || "missed_call_recovery",
    stripe_customer_id: data.stripe_customer_id,
    stripe_subscription_id: data.stripe_subscription_id,
    stripe_billing_event_created: data.stripe_billing_event_created,
    stripe_billing_event_id: data.stripe_billing_event_id,
    subscription_status: data.subscription_status,
    business_name: data.business_name,
    owner_phone: data.owner_phone,
    notification_email: data.notification_email,
  });
  const ownerInvite = await inviteMember(workspace.id, data.owner_email, "owner");
  return { workspace, ownerInvite };
}

export async function updateWorkspace(id: number, data: Partial<Workspace>): Promise<void> {
  const allowed = ["name", "plan", "owner_email", "stripe_customer_id", "stripe_subscription_id",
    "subscription_status", "monthly_call_limit", "monthly_minute_limit",
    "twilio_account_sid", "twilio_auth_token", "twilio_phone_number",
    "openrouter_api_key", "elevenlabs_api_key", "gemini_api_key",
    "webhook_url", "timezone", "dashboard_password_hash", "mode",
    // Per-workspace business identity
    "business_name", "business_tagline", "business_phone", "business_website",
    "business_address", "service_area", "business_hours", "escalation_preference",
    "proof_call_target", "agent_name", "agent_persona",
    "inbound_greeting", "outbound_greeting", "owner_phone", "notification_email",
    "setup_completed_at", "trial_ends_at"];
  const updates: Record<string, any> = {};
  for (const key of allowed) {
    if (key in data) updates[key] = (data as any)[key];
  }
  if (Object.keys(updates).length === 0) return;

  // Build dynamic update — use raw SQL for safety
  await sql`UPDATE workspaces SET updated_at = NOW() WHERE id = ${id}`;
  for (const [key, value] of Object.entries(updates)) {
    await sql`UPDATE workspaces SET ${sql.unsafe(key)} = ${value} WHERE id = ${id}`;
  }
}

export async function deleteWorkspace(id: number): Promise<void> {
  await sql`DELETE FROM workspaces WHERE id = ${id}`;
}

// ── Activation Events ─────────────────────────────────────────────────────────

export async function createActivationEvent(data: {
  workspace_id?: number | null;
  provisioning_request_id?: number | null;
  event_type: string;
  status?: ActivationEvent["status"];
  actor?: ActivationEvent["actor"];
  detail?: Record<string, unknown>;
}): Promise<ActivationEvent> {
  const rows = await sql<ActivationEvent[]>`
    INSERT INTO activation_events (
      workspace_id,
      provisioning_request_id,
      event_type,
      status,
      actor,
      detail
    ) VALUES (
      ${data.workspace_id ?? null},
      ${data.provisioning_request_id ?? null},
      ${data.event_type},
      ${data.status || "info"},
      ${data.actor || "system"},
      ${JSON.stringify(data.detail || {})}::jsonb
    )
    RETURNING *
  `;
  return rows[0];
}

export async function createActivationEventIfChanged(data: {
  workspace_id?: number | null;
  provisioning_request_id?: number | null;
  event_type: string;
  status?: ActivationEvent["status"];
  actor?: ActivationEvent["actor"];
  detail?: Record<string, unknown>;
}): Promise<ActivationEvent | null> {
  const status = data.status || "info";
  const actor = data.actor || "system";
  const detail = data.detail || {};
  const latest = await sql<ActivationEvent[]>`
    SELECT *
    FROM activation_events
    WHERE workspace_id IS NOT DISTINCT FROM ${data.workspace_id ?? null}
      AND event_type = ${data.event_type}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const latestDetail = latest[0]?.detail || {};
  if (
    latest[0]?.status === status &&
    latest[0]?.actor === actor &&
    JSON.stringify(latestDetail) === JSON.stringify(detail)
  ) {
    return null;
  }
  return createActivationEvent({
    workspace_id: data.workspace_id ?? null,
    provisioning_request_id: data.provisioning_request_id,
    event_type: data.event_type,
    status,
    actor,
    detail,
  });
}

export async function listActivationEvents(workspaceId: number, limit = 25): Promise<ActivationEvent[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return sql<ActivationEvent[]>`
    SELECT *
    FROM activation_events
    WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `;
}

// ── Usage Tracking ─────────────────────────────────────────────────────────────

export async function recordWorkspaceCallUsage(
  callSid: string,
  workspaceId: number,
  callDurationSeconds: number
): Promise<boolean> {
  if (!/^CA[A-Za-z0-9]{8,80}$/.test(String(callSid || "").trim())) {
    throw new Error("Cannot record usage without a valid call SID.");
  }
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error("Cannot record usage without a valid workspace.");
  }
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const safeDurationSeconds = Number.isFinite(callDurationSeconds) && callDurationSeconds >= 0
    ? Math.floor(callDurationSeconds)
    : 60;
  const minutes = Math.max(1, Math.ceil(safeDurationSeconds / 60));

  const rows = await sql<{ call_found: boolean; already_recorded: boolean; usage_claimed: boolean; usage_row_updated: boolean; workspace_updated: boolean; atomic_guard: number }[]>`
    WITH call_state AS MATERIALIZED (
      SELECT usage_recorded_at
      FROM calls
      WHERE call_sid = ${callSid} AND workspace_id = ${workspaceId}
    ), usage_claim AS (
      UPDATE calls c
      SET usage_recorded_at = NOW(), usage_recorded_minutes = ${minutes}
      FROM workspaces w
      WHERE c.call_sid = ${callSid}
        AND c.workspace_id = ${workspaceId}
        AND c.usage_recorded_at IS NULL
        AND w.id = c.workspace_id
      RETURNING c.workspace_id
    ), usage_upsert AS (
      INSERT INTO workspace_usage (workspace_id, month, calls, minutes)
      SELECT workspace_id, ${month}, 1, ${minutes}
      FROM usage_claim
      ON CONFLICT (workspace_id, month) DO UPDATE SET
        calls = workspace_usage.calls + 1,
        minutes = workspace_usage.minutes + EXCLUDED.minutes
      RETURNING workspace_id
    ), workspace_update AS (
      UPDATE workspaces w
      SET calls_this_month = w.calls_this_month + 1,
          minutes_this_month = w.minutes_this_month + ${minutes}
      FROM usage_claim
      WHERE w.id = usage_claim.workspace_id
      RETURNING w.id
    )
    SELECT
      EXISTS(SELECT 1 FROM call_state) AS call_found,
      EXISTS(SELECT 1 FROM call_state WHERE usage_recorded_at IS NOT NULL) AS already_recorded,
      EXISTS(SELECT 1 FROM usage_claim) AS usage_claimed,
      EXISTS(SELECT 1 FROM usage_upsert) AS usage_row_updated,
      EXISTS(SELECT 1 FROM workspace_update) AS workspace_updated,
      1 / CASE
        WHEN EXISTS(SELECT 1 FROM usage_claim)
          AND (
            NOT EXISTS(SELECT 1 FROM usage_upsert)
            OR NOT EXISTS(SELECT 1 FROM workspace_update)
          )
        THEN 0 ELSE 1
      END AS atomic_guard
  `;
  const result = rows[0];
  if (result?.already_recorded) return false;
  if (!result?.call_found || !result.usage_claimed) throw new Error("Call usage fact could not be claimed for the persisted workspace.");
  return true;
}

export async function checkUsageLimits(workspaceId: number): Promise<{
  allowed: boolean;
  reason?: string;
  billingWarning?: string;
  subscriptionStatus?: Workspace["subscription_status"];
  callsUsed: number;
  callsLimit: number;
  minutesUsed: number;
  minutesLimit: number;
}> {
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return { allowed: false, reason: "Workspace not found", callsUsed: 0, callsLimit: 0, minutesUsed: 0, minutesLimit: 0 };

  if (!hasWorkspaceBillingEntitlement(ws.plan, ws.subscription_status)) {
    const reason = ws.subscription_status === "refunded"
      ? "Payment fully refunded"
      : ws.subscription_status === "disputed"
        ? "Payment disputed"
        : ws.subscription_status === "canceled"
          ? "Subscription canceled"
          : `Subscription is not entitled (${ws.subscription_status})`;
    return { allowed: false, reason, subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }

  if (ws.plan === "free" && ws.trial_ends_at && new Date(ws.trial_ends_at) < new Date()) {
    return { allowed: false, reason: "Free trial expired", subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }

  if (!Number.isSafeInteger(ws.monthly_call_limit) || ws.monthly_call_limit <= 0) {
    return { allowed: false, reason: "Monthly call hard cap is not configured", subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }
  if (!Number.isSafeInteger(ws.monthly_minute_limit) || ws.monthly_minute_limit <= 0) {
    return { allowed: false, reason: "Monthly minute hard cap is not configured", subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }
  if (ws.calls_this_month >= ws.monthly_call_limit) {
    return { allowed: false, reason: `Monthly call limit reached (${ws.monthly_call_limit} calls)`, subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }

  if (ws.minutes_this_month >= ws.monthly_minute_limit) {
    return { allowed: false, reason: `Monthly minute limit reached (${ws.monthly_minute_limit} minutes)`, subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }

  return { allowed: true, subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
}

export async function resetMonthlyUsage(): Promise<void> {
  await sql`UPDATE workspaces SET calls_this_month = 0, minutes_this_month = 0`;
}

// ── Team Members & Invites ─────────────────────────────────────────────────────

export async function getWorkspaceMembers(workspaceId: number): Promise<WorkspaceMember[]> {
  return sql<WorkspaceMember[]>`SELECT * FROM workspace_members WHERE workspace_id = ${workspaceId} ORDER BY invited_at DESC`;
}

export async function inviteMember(workspaceId: number, email: string, role: "owner" | "admin" | "viewer" = "viewer"): Promise<WorkspaceMember> {
  const token = generateInviteToken();
  const rows = await sql<WorkspaceMember[]>`
    INSERT INTO workspace_members (workspace_id, email, role, invite_token, invite_expires_at)
    VALUES (${workspaceId}, ${email}, ${role}, ${token}, NOW() + INTERVAL '7 days')
    ON CONFLICT (workspace_id, email) DO UPDATE SET
      role = EXCLUDED.role,
      invite_token = EXCLUDED.invite_token,
      invite_expires_at = EXCLUDED.invite_expires_at,
      invited_at = NOW(),
      accepted_at = NULL
    RETURNING *
  `;
  return rows[0];
}

async function ensureCheckoutOwnerInvite(
  workspaceId: number,
  email: string,
  claim?: StripeCheckoutFulfillmentClaim,
  rotateExistingInvite = true,
): Promise<WorkspaceMember> {
  const token = generateInviteToken();
  if (claim) {
    const claimedRows = await sql<WorkspaceMember[]>`
      WITH owned_claim AS (
        UPDATE stripe_checkout_fulfillments
        SET updated_at = NOW()
        WHERE checkout_session_id = ${claim.checkoutSessionId}
          AND claim_token = ${claim.claimToken}
          AND status = 'processing'
        RETURNING checkout_session_id
      )
      INSERT INTO workspace_members (workspace_id, email, role, invite_token, invite_expires_at)
      SELECT ${workspaceId}, ${email}, 'owner', ${token}, NOW() + INTERVAL '7 days'
      FROM owned_claim
      ON CONFLICT (workspace_id, email) DO UPDATE
        SET role = 'owner',
            invite_token = CASE
              WHEN workspace_members.invite_token IS NOT NULL
                AND (
                  ${!rotateExistingInvite}
                  OR (
                    workspace_members.invite_expires_at > NOW()
                    AND (workspace_members.accepted_at IS NULL OR workspace_members.accepted_at > NOW() - INTERVAL '10 minutes')
                  )
                )
                THEN workspace_members.invite_token
              ELSE EXCLUDED.invite_token
            END,
            invite_expires_at = CASE
              WHEN workspace_members.invite_token IS NOT NULL
                AND (
                  ${!rotateExistingInvite}
                  OR (
                    workspace_members.invite_expires_at > NOW()
                    AND (workspace_members.accepted_at IS NULL OR workspace_members.accepted_at > NOW() - INTERVAL '10 minutes')
                  )
                )
                THEN workspace_members.invite_expires_at
              ELSE EXCLUDED.invite_expires_at
            END,
            invited_at = CASE
              WHEN workspace_members.invite_token IS NOT NULL
                AND (
                  ${!rotateExistingInvite}
                  OR (
                    workspace_members.invite_expires_at > NOW()
                    AND (workspace_members.accepted_at IS NULL OR workspace_members.accepted_at > NOW() - INTERVAL '10 minutes')
                  )
                )
                THEN workspace_members.invited_at
              ELSE NOW()
            END,
            accepted_at = CASE
              WHEN workspace_members.invite_token IS NOT NULL
                AND (
                  ${!rotateExistingInvite}
                  OR (
                    workspace_members.invite_expires_at > NOW()
                    AND (workspace_members.accepted_at IS NULL OR workspace_members.accepted_at > NOW() - INTERVAL '10 minutes')
                  )
                )
                THEN workspace_members.accepted_at
              ELSE NULL
            END
      RETURNING *
    `;
    if (claimedRows.length !== 1) throw checkoutClaimLostError();
    return claimedRows[0];
  }
  const rows = await sql<WorkspaceMember[]>`
    INSERT INTO workspace_members (workspace_id, email, role, invite_token, invite_expires_at)
    VALUES (${workspaceId}, ${email}, 'owner', ${token}, NOW() + INTERVAL '7 days')
    ON CONFLICT (workspace_id, email) DO UPDATE
      SET role = 'owner',
          invite_token = CASE
            WHEN workspace_members.invite_token IS NOT NULL
              AND (
                ${!rotateExistingInvite}
                OR (
                  workspace_members.invite_expires_at > NOW()
                  AND (workspace_members.accepted_at IS NULL OR workspace_members.accepted_at > NOW() - INTERVAL '10 minutes')
                )
              )
              THEN workspace_members.invite_token
            ELSE EXCLUDED.invite_token
          END,
          invite_expires_at = CASE
            WHEN workspace_members.invite_token IS NOT NULL
              AND (
                ${!rotateExistingInvite}
                OR (
                  workspace_members.invite_expires_at > NOW()
                  AND (workspace_members.accepted_at IS NULL OR workspace_members.accepted_at > NOW() - INTERVAL '10 minutes')
                )
              )
              THEN workspace_members.invite_expires_at
            ELSE EXCLUDED.invite_expires_at
          END,
          invited_at = CASE
            WHEN workspace_members.invite_token IS NOT NULL
              AND (
                ${!rotateExistingInvite}
                OR (
                  workspace_members.invite_expires_at > NOW()
                  AND (workspace_members.accepted_at IS NULL OR workspace_members.accepted_at > NOW() - INTERVAL '10 minutes')
                )
              )
              THEN workspace_members.invited_at
            ELSE NOW()
          END,
          accepted_at = CASE
            WHEN workspace_members.invite_token IS NOT NULL
              AND (
                ${!rotateExistingInvite}
                OR (
                  workspace_members.invite_expires_at > NOW()
                  AND (workspace_members.accepted_at IS NULL OR workspace_members.accepted_at > NOW() - INTERVAL '10 minutes')
                )
              )
              THEN workspace_members.accepted_at
            ELSE NULL
          END
    RETURNING *
  `;
  return rows[0];
}

export async function inspectInvite(token: string): Promise<WorkspaceMember | null> {
  const rows = await sql<WorkspaceMember[]>`
    SELECT *
    FROM workspace_members
    WHERE invite_token = ${token}
      AND invite_expires_at > NOW()
      AND (accepted_at IS NULL OR accepted_at > NOW() - INTERVAL '10 minutes')
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function inspectInviteRecovery(token: string): Promise<{ checkout_session_id: string } | null> {
  const rows = await sql<{ checkout_session_id: string }[]>`
    SELECT pr.request_id AS checkout_session_id
    FROM workspace_members wm
    JOIN provisioning_requests pr
      ON pr.workspace_id = wm.workspace_id
     AND lower(pr.owner_email) = lower(wm.email)
    WHERE wm.invite_token = ${token}
      AND wm.role = 'owner'
      AND pr.source = 'stripe_checkout_completed'
      AND pr.request_id IS NOT NULL
      AND pr.invite_link LIKE '%/invite/' || wm.invite_token
    ORDER BY pr.updated_at DESC, pr.id DESC
    LIMIT 1
  `;
  const checkoutSessionId = String(rows[0]?.checkout_session_id || "").trim();
  return /^cs_(test|live)_[A-Za-z0-9_]{8,240}$/.test(checkoutSessionId)
    ? { checkout_session_id: checkoutSessionId }
    : null;
}

export async function acceptInvite(token: string): Promise<WorkspaceMember | null> {
  const rows = await sql<WorkspaceMember[]>`
    WITH accepted_member AS MATERIALIZED (
      UPDATE workspace_members
      SET accepted_at = COALESCE(accepted_at, NOW())
      WHERE invite_token = ${token}
        AND invite_expires_at > NOW()
        AND (accepted_at IS NULL OR accepted_at > NOW() - INTERVAL '10 minutes')
      RETURNING *
    ), exact_checkout_request AS MATERIALIZED (
      SELECT
        am.workspace_id,
        am.email,
        am.role,
        am.accepted_at,
        pr.id AS provisioning_request_id,
        pr.request_id AS checkout_session_id
      FROM accepted_member am
      JOIN provisioning_requests pr
        ON pr.workspace_id = am.workspace_id
       AND lower(pr.owner_email) = lower(am.email)
       AND pr.source = 'stripe_checkout_completed'
       AND pr.request_id IS NOT NULL
       AND pr.invite_link LIKE '%/invite/' || ${token}
      ORDER BY pr.updated_at DESC, pr.id DESC
      LIMIT 1
    ), recorded_acceptance AS (
      INSERT INTO activation_events (
        workspace_id,
        provisioning_request_id,
        event_type,
        status,
        actor,
        detail
      )
      SELECT
        ecr.workspace_id,
        ecr.provisioning_request_id,
        'buyer_invite_accepted',
        'complete',
        'customer',
        ${JSON.stringify({
          auth_mode: "invite",
          auth_provenance: "buyer_email_invite_token",
        })}::jsonb || jsonb_build_object(
          'checkout_session_id', ecr.checkout_session_id,
          'member_role', ecr.role,
          'accepted_at', ecr.accepted_at
        )
      FROM exact_checkout_request ecr
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    SELECT am.*
    FROM accepted_member am
    LEFT JOIN (SELECT COUNT(*) AS recorded_count FROM recorded_acceptance) recorded ON TRUE
  `;
  return rows[0] || null;
}

export async function removeMember(workspaceId: number, email: string): Promise<void> {
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId} AND email = ${email}`;
}

// ── Stripe Billing Hooks ───────────────────────────────────────────────────────

function normalizePlan(raw: unknown): Workspace["plan"] {
  const value = String(raw || "starter").trim().toLowerCase();
  if (["free", "trial"].includes(value)) return "free";
  if (["starter", "basic"].includes(value)) return "starter";
  if (value === "pro") return "pro";
  if (["enterprise", "agency"].includes(value)) return "enterprise";
  if (value.includes("agency") || value.includes("enterprise")) return "enterprise";
  if (value.includes("pro")) return "pro";
  if (value.includes("starter") || value.includes("basic")) return "starter";
  return "starter";
}

function strictPaidPlan(raw: unknown): Exclude<Workspace["plan"], "free"> | null {
  return strictSmirkPaidPlan(raw);
}

function cleanStripeId(raw: unknown): string | null {
  if (typeof raw === "string") {
    const value = raw.trim();
    return value || null;
  }
  if (raw && typeof raw === "object" && "id" in raw) {
    const value = String((raw as { id?: unknown }).id || "").trim();
    return value || null;
  }
  return null;
}

function stripeInvoiceSubscriptionId(invoice: any): string | null {
  return cleanStripeId(invoice?.parent?.subscription_details?.subscription || invoice?.subscription);
}

async function recordStripeInvoicePaymentBindings(invoice: any): Promise<void> {
  const invoiceId = cleanStripeId(invoice?.id);
  const customerId = cleanStripeId(invoice?.customer);
  const subscriptionId = stripeInvoiceSubscriptionId(invoice);
  if (!invoiceId || !customerId || !subscriptionId || invoice?.livemode !== true || invoice?.status !== "paid" || Number(invoice?.amount_paid || 0) <= 0) return;
  const embeddedPayments = Array.isArray(invoice?.payments?.data) ? invoice.payments.data : [];
  const paymentIntentIds = new Set<string>();
  for (const payment of embeddedPayments) {
    const paymentIntentId = cleanStripeId(payment?.payment?.payment_intent);
    if (paymentIntentId && payment?.status === "paid") paymentIntentIds.add(paymentIntentId);
  }
  const legacyPaymentIntentId = cleanStripeId(invoice?.payment_intent);
  if (legacyPaymentIntentId) paymentIntentIds.add(legacyPaymentIntentId);
  for (const paymentIntentId of paymentIntentIds) {
    const factRows = await sql<{ payment_intent_id: string }[]>`
      INSERT INTO stripe_invoice_payment_facts (payment_intent_id, invoice_id, customer_id, subscription_id)
      VALUES (${paymentIntentId}, ${invoiceId}, ${customerId}, ${subscriptionId})
      ON CONFLICT (payment_intent_id) DO UPDATE
        SET updated_at = NOW()
        WHERE stripe_invoice_payment_facts.invoice_id = EXCLUDED.invoice_id
          AND stripe_invoice_payment_facts.customer_id = EXCLUDED.customer_id
          AND stripe_invoice_payment_facts.subscription_id = EXCLUDED.subscription_id
      RETURNING payment_intent_id
    `;
    if (factRows.length !== 1) continue;
    await bindKnownStripePaymentFact({ paymentIntentId, invoiceId, customerId, subscriptionId });
  }
}

async function claimStripeCheckoutFulfillment(checkoutSessionId: string, eventId: string | null): Promise<string | null> {
  const claimToken = randomBytes(24).toString("hex");
  const staleBefore = checkoutFulfillmentLeaseCutoff();
  const rows = await sql<{ checkout_session_id: string; claim_token: string }[]>`
    INSERT INTO stripe_checkout_fulfillments (checkout_session_id, event_id, claim_token, status)
    VALUES (${checkoutSessionId}, ${eventId}, ${claimToken}, 'processing')
    ON CONFLICT (checkout_session_id) DO UPDATE
      SET event_id = EXCLUDED.event_id,
          claim_token = EXCLUDED.claim_token,
          status = 'processing',
          last_error = NULL,
          updated_at = NOW()
      WHERE stripe_checkout_fulfillments.status = 'failed'
         OR (
           stripe_checkout_fulfillments.status = 'processing'
           AND stripe_checkout_fulfillments.updated_at < ${staleBefore}
         )
    RETURNING checkout_session_id, claim_token
  `;
  if (rows[0]?.claim_token) return rows[0].claim_token;
  const existing = await sql<{ status: string }[]>`
    SELECT status
    FROM stripe_checkout_fulfillments
    WHERE checkout_session_id = ${checkoutSessionId}
    LIMIT 1
  `;
  if (existing[0]?.status === "complete") return null;
  throw new Error("Checkout fulfillment is already processing; retry later.");
}

type StripeCheckoutFulfillmentClaim = {
  checkoutSessionId: string;
  claimToken: string;
};

const checkoutClaimLostError = (): Error & { code?: string } => {
  const error = new Error("Checkout fulfillment claim is no longer owned by this worker.") as Error & { code?: string };
  error.code = "CHECKOUT_FULFILLMENT_CLAIM_LOST";
  return error;
};

async function renewStripeCheckoutFulfillmentClaim(claim: StripeCheckoutFulfillmentClaim): Promise<void> {
  const rows = await sql<{ checkout_session_id: string }[]>`
    UPDATE stripe_checkout_fulfillments
    SET updated_at = NOW()
    WHERE checkout_session_id = ${claim.checkoutSessionId}
      AND claim_token = ${claim.claimToken}
      AND status = 'processing'
    RETURNING checkout_session_id
  `;
  if (rows.length !== 1) throw checkoutClaimLostError();
}

async function finishStripeCheckoutFulfillment(checkoutSessionId: string, claimToken: string, status: "complete" | "failed", error?: unknown): Promise<boolean> {
  const lastError = status === "failed" ? String((error as any)?.message || error || "fulfillment failed").slice(0, 500) : null;
  const rows = await sql<{ checkout_session_id: string }[]>`
    UPDATE stripe_checkout_fulfillments
    SET status = ${status},
        last_error = ${lastError},
        updated_at = NOW()
    WHERE checkout_session_id = ${checkoutSessionId}
      AND claim_token = ${claimToken}
      AND status = 'processing'
    RETURNING checkout_session_id
  `;
  return rows.length === 1;
}

async function updateWorkspaceForCheckoutClaim(
  claim: StripeCheckoutFulfillmentClaim,
  workspaceId: number,
  data: Partial<Workspace>,
): Promise<void> {
  const allowed = new Set([
    "name", "plan", "owner_email", "stripe_customer_id", "stripe_subscription_id",
    "stripe_billing_event_created", "stripe_billing_event_id",
    "subscription_status", "monthly_call_limit", "monthly_minute_limit",
    "business_name", "owner_phone", "notification_email",
  ]);
  const updates = Object.entries(data).filter(([key, value]) => allowed.has(key) && value !== undefined);
  for (const [key, value] of updates) {
    const rows = await sql<{ id: number }[]>`
      WITH owned_claim AS (
        UPDATE stripe_checkout_fulfillments
        SET updated_at = NOW()
        WHERE checkout_session_id = ${claim.checkoutSessionId}
          AND claim_token = ${claim.claimToken}
          AND status = 'processing'
        RETURNING checkout_session_id
      )
      UPDATE workspaces
      SET ${sql.unsafe(key)} = ${value}, updated_at = NOW()
      WHERE id = ${workspaceId}
        AND EXISTS (SELECT 1 FROM owned_claim)
      RETURNING id
    `;
    if (rows.length !== 1) throw checkoutClaimLostError();
  }
}

async function upsertCheckoutProvisioningRequest(input: {
  claim: StripeCheckoutFulfillmentClaim;
  businessName: string;
  ownerEmail: string;
  plan: Workspace["plan"];
  mode: NonNullable<Workspace["mode"]>;
  status: string;
  workspaceId?: number | null;
  inviteLink?: string | null;
  workspaceApiKey?: string | null;
  error?: string | null;
}): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    WITH owned_claim AS (
      UPDATE stripe_checkout_fulfillments
      SET updated_at = NOW()
      WHERE checkout_session_id = ${input.claim.checkoutSessionId}
        AND claim_token = ${input.claim.claimToken}
        AND status = 'processing'
      RETURNING checkout_session_id
    )
    INSERT INTO provisioning_requests (
      request_id, workspace_id, business_name, owner_email, requested_plan,
      requested_mode, status, invite_link, workspace_api_key, source, error
    )
    SELECT
      ${input.claim.checkoutSessionId}, ${input.workspaceId || null}, ${input.businessName}, ${input.ownerEmail}, ${input.plan},
      ${input.mode}, ${input.status}, ${input.inviteLink || null}, ${input.workspaceApiKey || null}, 'stripe_checkout_completed', ${input.error || null}
    FROM owned_claim
    ON CONFLICT (request_id) WHERE source = 'stripe_checkout_completed' AND request_id IS NOT NULL
    DO UPDATE SET
      workspace_id = COALESCE(EXCLUDED.workspace_id, provisioning_requests.workspace_id),
      business_name = EXCLUDED.business_name,
      owner_email = EXCLUDED.owner_email,
      requested_plan = EXCLUDED.requested_plan,
      requested_mode = EXCLUDED.requested_mode,
      status = EXCLUDED.status,
      invite_link = COALESCE(EXCLUDED.invite_link, provisioning_requests.invite_link),
      workspace_api_key = COALESCE(EXCLUDED.workspace_api_key, provisioning_requests.workspace_api_key),
      error = EXCLUDED.error,
      updated_at = NOW()
    RETURNING id
  `;
  if (rows.length !== 1) throw checkoutClaimLostError();
  return rows[0].id;
}

async function setCheckoutProvisioningFallback(
  claim: StripeCheckoutFulfillmentClaim,
  provisioningRequestId: number,
  error: string,
): Promise<void> {
  const rows = await sql<{ id: number }[]>`
    WITH owned_claim AS (
      UPDATE stripe_checkout_fulfillments
      SET updated_at = NOW()
      WHERE checkout_session_id = ${claim.checkoutSessionId}
        AND claim_token = ${claim.claimToken}
        AND status = 'processing'
      RETURNING checkout_session_id
    )
    UPDATE provisioning_requests
    SET status = 'manual_fallback_required', error = ${error}, updated_at = NOW()
    WHERE id = ${provisioningRequestId}
      AND EXISTS (SELECT 1 FROM owned_claim)
    RETURNING id
  `;
  if (rows.length !== 1) throw checkoutClaimLostError();
}

async function createWorkspaceForCheckoutClaim(
  claim: StripeCheckoutFulfillmentClaim,
  data: {
    name: string;
    ownerEmail: string;
    plan: "starter" | "pro" | "enterprise";
    mode: NonNullable<Workspace["mode"]>;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    stripeBillingEventCreated: number | null;
    stripeBillingEventId: string | null;
    businessName: string;
    ownerPhone: string | null;
  },
): Promise<Workspace> {
  const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50)
    + "-" + Math.random().toString(36).slice(2, 6);
  const apiKey = generateApiKey();
  const limits = PLAN_LIMITS[data.plan];
  const rows = await sql<Workspace[]>`
    WITH owned_claim AS (
      UPDATE stripe_checkout_fulfillments
      SET updated_at = NOW()
      WHERE checkout_session_id = ${claim.checkoutSessionId}
        AND claim_token = ${claim.claimToken}
        AND status = 'processing'
      RETURNING checkout_session_id
    )
    INSERT INTO workspaces (
      slug, name, owner_email, plan, subscription_status,
      monthly_call_limit, monthly_minute_limit, api_key, trial_ends_at, mode,
      stripe_customer_id, stripe_subscription_id, stripe_billing_event_created, stripe_billing_event_id,
      business_name, owner_phone, notification_email
    )
    SELECT
      ${slug}, ${data.name}, ${data.ownerEmail}, ${data.plan}, 'active',
      ${limits.calls}, ${limits.minutes}, ${apiKey}, NULL, ${data.mode},
      ${data.stripeCustomerId}, ${data.stripeSubscriptionId}, ${data.stripeBillingEventCreated}, ${data.stripeBillingEventId},
      ${data.businessName}, ${data.ownerPhone}, ${data.ownerEmail}
    FROM owned_claim
    RETURNING *
  `;
  if (rows.length !== 1) throw checkoutClaimLostError();
  return rows[0];
}

async function createCheckoutActivationEventIfChanged(
  claim: StripeCheckoutFulfillmentClaim,
  data: {
    workspace_id?: number | null;
    provisioning_request_id?: number | null;
    event_type: string;
    status?: ActivationEvent["status"];
    actor?: ActivationEvent["actor"];
    detail?: Record<string, unknown>;
  },
): Promise<ActivationEvent | null> {
  const status = data.status || "info";
  const actor = data.actor || "system";
  const detail = data.detail || {};
  const ownership = await sql<{ owned: boolean; event: ActivationEvent | null }[]>`
    WITH owned_claim AS (
      UPDATE stripe_checkout_fulfillments
      SET updated_at = NOW()
      WHERE checkout_session_id = ${claim.checkoutSessionId}
        AND claim_token = ${claim.claimToken}
        AND status = 'processing'
      RETURNING checkout_session_id
    ),
    latest AS (
      SELECT status, actor, detail
      FROM activation_events
      WHERE workspace_id IS NOT DISTINCT FROM ${data.workspace_id ?? null}
        AND event_type = ${data.event_type}
      ORDER BY created_at DESC
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO activation_events (
        workspace_id, provisioning_request_id, event_type, status, actor, detail
      )
      SELECT
        ${data.workspace_id ?? null}, ${data.provisioning_request_id ?? null}, ${data.event_type},
        ${status}, ${actor}, ${JSON.stringify(detail)}::jsonb
      FROM owned_claim
      WHERE NOT EXISTS (
        SELECT 1 FROM latest
        WHERE latest.status = ${status}
          AND latest.actor = ${actor}
          AND latest.detail = ${JSON.stringify(detail)}::jsonb
      )
      RETURNING *
    )
    SELECT
      EXISTS (SELECT 1 FROM owned_claim) AS owned,
      (SELECT row_to_json(inserted)::jsonb FROM inserted LIMIT 1) AS event
  `;
  if (ownership[0]?.owned !== true) throw checkoutClaimLostError();
  return ownership[0]?.event || null;
}

async function sendCheckoutProvisioningAlert(
  claim: StripeCheckoutFulfillmentClaim,
  input: Parameters<typeof sendProvisioningAlert>[0],
) {
  await renewStripeCheckoutFulfillmentClaim(claim);
  const result = await sendProvisioningAlert({ ...input, deliveryScope: claim.checkoutSessionId });
  if (!result.sent && result.skippedReason !== "approved synthetic smoke") {
    const error = new Error(result.error || result.skippedReason || "Operator alert delivery failed.") as Error & { code?: string };
    error.code = "OPERATOR_ALERT_DELIVERY_RETRYABLE";
    throw error;
  }
  return result;
}

async function findWorkspaceByStripeIds(ids: {
  customerId?: string | null;
  subscriptionId?: string | null;
}): Promise<Workspace | null> {
  const customerId = cleanStripeId(ids.customerId);
  const subscriptionId = cleanStripeId(ids.subscriptionId);
  if (subscriptionId) {
    const rows = await sql<Workspace[]>`
      SELECT *
      FROM workspaces
      WHERE stripe_subscription_id = ${subscriptionId}
      ORDER BY updated_at DESC
      LIMIT 2
    `;
    if (rows.length === 1 && (!customerId || rows[0].stripe_customer_id === customerId)) return rows[0];
    return null;
  }
  if (customerId) {
    const rows = await sql<Workspace[]>`
      SELECT *
      FROM workspaces
      WHERE stripe_customer_id = ${customerId}
      ORDER BY updated_at DESC
      LIMIT 2
    `;
    return rows.length === 1 ? rows[0] : null;
  }
  return null;
}

async function applyAdversePaymentState(input: {
  paymentIntentId: string;
  workspace: Workspace;
  customerId: string;
  subscriptionId: string;
}): Promise<void> {
  const adverseRows = await sql<{
    customer_id: string | null;
    fully_refunded: boolean;
    disputed: boolean;
    charge_id: string | null;
    stripe_event_id: string | null;
  }[]>`
    SELECT customer_id, fully_refunded, disputed, charge_id, stripe_event_id
    FROM stripe_payment_adverse_events
    WHERE payment_intent_id = ${input.paymentIntentId}
    LIMIT 1
  `;
  const adverse = adverseRows[0];
  if (!adverse?.fully_refunded && !adverse?.disputed) return;
  if (adverse.customer_id && adverse.customer_id !== input.customerId) return;
  const suspensionStatus: WorkspaceBillingStatus = adverse.disputed ? "disputed" : "refunded";
  await sql`
    UPDATE workspaces
    SET subscription_status = ${suspensionStatus}, updated_at = NOW()
    WHERE id = ${input.workspace.id}
      AND stripe_customer_id = ${input.customerId}
      AND stripe_subscription_id = ${input.subscriptionId}
  `;
  await createActivationEventIfChanged({
    workspace_id: input.workspace.id,
    event_type: adverse.disputed ? "billing_dispute_recorded" : "billing_refund_recorded",
    status: "blocked",
    actor: "system",
    detail: {
      source: adverse.disputed ? "stripe_adverse_payment_reconciliation" : "stripe_refund_reconciliation",
      stripe_event_id: adverse.stripe_event_id,
      workspace_matched: true,
      payment_intent_id: input.paymentIntentId,
      charge_id: adverse.charge_id,
      customer_id: input.customerId,
      subscription_id: input.subscriptionId,
      exact_subscription_binding: true,
      fully_refunded: adverse.fully_refunded,
      disputed: adverse.disputed,
    },
  });
}

async function bindKnownStripePaymentFact(input: {
  paymentIntentId: string;
  invoiceId: string;
  customerId: string;
  subscriptionId: string;
}): Promise<void> {
  const workspace = await findWorkspaceByStripeIds({ customerId: input.customerId, subscriptionId: input.subscriptionId });
  if (!workspace) return;
  const bindingRows = await sql<{ payment_intent_id: string }[]>`
    INSERT INTO stripe_payment_bindings (payment_intent_id, workspace_id, invoice_id, customer_id, subscription_id)
    VALUES (${input.paymentIntentId}, ${workspace.id}, ${input.invoiceId}, ${input.customerId}, ${input.subscriptionId})
    ON CONFLICT (payment_intent_id) DO UPDATE
      SET updated_at = NOW()
      WHERE stripe_payment_bindings.workspace_id = EXCLUDED.workspace_id
        AND stripe_payment_bindings.invoice_id = EXCLUDED.invoice_id
        AND stripe_payment_bindings.customer_id = EXCLUDED.customer_id
        AND stripe_payment_bindings.subscription_id = EXCLUDED.subscription_id
    RETURNING payment_intent_id
  `;
  if (bindingRows.length !== 1) return;
  await applyAdversePaymentState({
    paymentIntentId: input.paymentIntentId,
    workspace,
    customerId: input.customerId,
    subscriptionId: input.subscriptionId,
  });
}

async function reconcileStripePaymentFactsForWorkspace(workspace: Workspace): Promise<void> {
  const customerId = cleanStripeId(workspace.stripe_customer_id);
  const subscriptionId = cleanStripeId(workspace.stripe_subscription_id);
  if (!customerId || !subscriptionId) return;
  const facts = await sql<{
    payment_intent_id: string;
    invoice_id: string;
    customer_id: string;
    subscription_id: string;
  }[]>`
    SELECT payment_intent_id, invoice_id, customer_id, subscription_id
    FROM stripe_invoice_payment_facts
    WHERE customer_id = ${customerId}
      AND subscription_id = ${subscriptionId}
    ORDER BY updated_at ASC
  `;
  for (const fact of facts) {
    await bindKnownStripePaymentFact({
      paymentIntentId: fact.payment_intent_id,
      invoiceId: fact.invoice_id,
      customerId: fact.customer_id,
      subscriptionId: fact.subscription_id,
    });
  }
}

type StripeSubscriptionStateFact = {
  subscription_id: string;
  customer_id: string;
  status: WorkspaceBillingStatus;
  source_event_type: string;
  event_created: number | string;
  event_id: string;
};

async function recordStripeSubscriptionStateFact(input: {
  subscriptionId: string;
  customerId: string;
  status: WorkspaceBillingStatus;
  sourceEventType: string;
  eventCreated: number;
  eventId: string;
}): Promise<StripeSubscriptionStateFact | null> {
  const restrictiveStatus = isRestrictiveWorkspaceBillingStatus(input.status);
  const recorded = await sql<StripeSubscriptionStateFact[]>`
    INSERT INTO stripe_subscription_state_facts (
      subscription_id, customer_id, status, source_event_type, event_created, event_id
    ) VALUES (
      ${input.subscriptionId}, ${input.customerId}, ${input.status}, ${input.sourceEventType}, ${input.eventCreated}, ${input.eventId}
    )
    ON CONFLICT (subscription_id) DO UPDATE
      SET status = EXCLUDED.status,
          source_event_type = EXCLUDED.source_event_type,
          event_created = EXCLUDED.event_created,
          event_id = EXCLUDED.event_id,
          updated_at = NOW()
      WHERE stripe_subscription_state_facts.customer_id = EXCLUDED.customer_id
        AND (
          stripe_subscription_state_facts.event_created < EXCLUDED.event_created
          OR (
            stripe_subscription_state_facts.event_created = EXCLUDED.event_created
            AND ${restrictiveStatus}
            AND stripe_subscription_state_facts.event_id IS DISTINCT FROM EXCLUDED.event_id
          )
        )
    RETURNING subscription_id, customer_id, status, source_event_type, event_created, event_id
  `;
  if (recorded[0]) return recorded[0];
  const existing = await sql<StripeSubscriptionStateFact[]>`
    SELECT subscription_id, customer_id, status, source_event_type, event_created, event_id
    FROM stripe_subscription_state_facts
    WHERE subscription_id = ${input.subscriptionId}
      AND customer_id = ${input.customerId}
    LIMIT 1
  `;
  return existing[0] || null;
}

async function applyStripeSubscriptionStateFactToWorkspace(
  workspace: Workspace,
  fact: StripeSubscriptionStateFact,
  recordReconciliationEvent = true,
): Promise<Workspace | null> {
  if (workspace.stripe_customer_id !== fact.customer_id || workspace.stripe_subscription_id !== fact.subscription_id) return null;
  const status = normalizeStripeSubscriptionStatus(fact.status);
  const restrictiveStatus = isRestrictiveWorkspaceBillingStatus(status);
  const applied = await sql<Workspace[]>`
    UPDATE workspaces
    SET subscription_status = CASE
          WHEN subscription_status IN ('refunded', 'disputed') THEN subscription_status
          ELSE ${status}
        END,
        stripe_billing_event_created = ${fact.event_created},
        stripe_billing_event_id = ${fact.event_id},
        updated_at = NOW()
    WHERE id = ${workspace.id}
      AND stripe_customer_id = ${fact.customer_id}
      AND stripe_subscription_id = ${fact.subscription_id}
      AND (
        stripe_billing_event_created IS NULL
        OR stripe_billing_event_created < ${fact.event_created}
        OR (
          stripe_billing_event_created = ${fact.event_created}
          AND ${restrictiveStatus}
          AND stripe_billing_event_id IS DISTINCT FROM ${fact.event_id}
        )
      )
    RETURNING *
  `;
  const updated = applied[0] || null;
  if (updated && restrictiveStatus && recordReconciliationEvent) {
    const canceled = status === "canceled";
    await createActivationEventIfChanged({
      workspace_id: updated.id,
      event_type: canceled ? "billing_subscription_canceled" : "billing_payment_failed",
      status: "blocked",
      actor: "system",
      detail: {
        source: "stripe_subscription_state_reconciliation",
        stripe_event_id: fact.event_id,
        stripe_event_type: fact.source_event_type,
        customer_id: fact.customer_id,
        subscription_id: fact.subscription_id,
        subscription_status: status,
        exact_subscription_binding: true,
        reason: canceled
          ? "Stripe subscription was canceled before or during workspace activation."
          : `Stripe billing state ${status} does not permit paid access.`,
      },
    });
  }
  return updated;
}

async function reconcileStripeSubscriptionStateForWorkspace(workspace: Workspace): Promise<void> {
  const customerId = cleanStripeId(workspace.stripe_customer_id);
  const subscriptionId = cleanStripeId(workspace.stripe_subscription_id);
  if (!customerId || !subscriptionId) return;
  const facts = await sql<StripeSubscriptionStateFact[]>`
    SELECT subscription_id, customer_id, status, source_event_type, event_created, event_id
    FROM stripe_subscription_state_facts
    WHERE subscription_id = ${subscriptionId}
      AND customer_id = ${customerId}
    LIMIT 1
  `;
  if (facts[0]) await applyStripeSubscriptionStateFactToWorkspace(workspace, facts[0]);
}

async function recordStripeBillingLifecycle(input: {
  workspace: Workspace | null;
  eventType: "billing_payment_failed" | "billing_subscription_canceled" | "billing_refund_recorded" | "billing_dispute_recorded";
  alertEvent: "stripe_payment_failed" | "stripe_subscription_canceled" | "stripe_refund_recorded" | "stripe_dispute_recorded";
  status: "blocked" | "complete" | "info";
  source: string;
  stripeEventId: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await createActivationEventIfChanged({
    workspace_id: input.workspace?.id ?? null,
    event_type: input.eventType,
    status: input.status,
    actor: "system",
    detail: {
      source: input.source,
      stripe_event_id: input.stripeEventId,
      workspace_matched: Boolean(input.workspace?.id),
      ...(input.detail || {}),
    },
  });

  const alertDelivery = await sendProvisioningAlert({
    event: input.alertEvent,
    businessName: input.workspace?.business_name || input.workspace?.name || "Unknown Stripe buyer",
    ownerEmail: input.workspace?.owner_email || "unknown",
    ownerPhone: input.workspace?.owner_phone || null,
    plan: input.workspace?.plan || "unknown",
    source: input.source,
    status: input.status,
    workspaceId: input.workspace?.id ?? null,
    error: input.detail?.reason ? String(input.detail.reason) : null,
    deliveryScope: input.stripeEventId,
  });
  if (!alertDelivery.sent && alertDelivery.retryable) {
    const error = new Error(alertDelivery.error || alertDelivery.skippedReason || "Stripe billing alert delivery needs retry.") as Error & { code?: string };
    error.code = "STRIPE_BILLING_ALERT_RETRYABLE";
    throw error;
  }
}

async function deliverCheckoutBuyerActivation(input: {
  provisioningRequestId: number;
  workspaceId: number;
  checkoutSessionId: string;
  claimToken: string;
  businessName: string;
  ownerEmail: string;
  plan: string;
  inviteLink: string;
  inviteExpiresAt: string;
  approvedSyntheticSmoke: boolean;
}): Promise<{ sent: boolean; status: "sent" | "failed" | "retryable_failed" | "skipped_smoke"; error: string | null; retryable: boolean }> {
  const claim = { checkoutSessionId: input.checkoutSessionId, claimToken: input.claimToken };
  const prior = await sql<{ buyer_activation_email_status: string; buyer_activation_email_error: string | null }[]>`
    SELECT pr.buyer_activation_email_status, pr.buyer_activation_email_error
    FROM provisioning_requests pr
    JOIN stripe_checkout_fulfillments scf ON scf.checkout_session_id = pr.request_id
    WHERE pr.id = ${input.provisioningRequestId}
      AND scf.checkout_session_id = ${input.checkoutSessionId}
      AND scf.claim_token = ${input.claimToken}
      AND scf.status = 'processing'
    LIMIT 1
  `;
  if (!prior[0]) throw new Error("Checkout fulfillment claim no longer owns buyer email delivery.");
  if (prior[0]?.buyer_activation_email_status === "sent") {
    return { sent: true, status: "sent", error: null, retryable: false };
  }

  if (input.approvedSyntheticSmoke) {
    const smokeRows = await sql<{ id: number }[]>`
      WITH owned_claim AS (
        UPDATE stripe_checkout_fulfillments
        SET updated_at = NOW()
        WHERE checkout_session_id = ${input.checkoutSessionId}
          AND claim_token = ${input.claimToken}
          AND status = 'processing'
        RETURNING checkout_session_id
      )
      UPDATE provisioning_requests
      SET buyer_activation_email_status = 'skipped_smoke',
          buyer_activation_email_error = NULL,
          updated_at = NOW()
      WHERE id = ${input.provisioningRequestId}
        AND buyer_activation_email_status <> 'sent'
        AND EXISTS (SELECT 1 FROM owned_claim)
      RETURNING id
    `;
    if (smokeRows.length !== 1) throw checkoutClaimLostError();
    await createCheckoutActivationEventIfChanged(claim, {
      workspace_id: input.workspaceId,
      provisioning_request_id: input.provisioningRequestId,
      event_type: "buyer_activation_email",
      status: "info",
      actor: "system",
      detail: { delivery_status: "skipped_smoke", source: "gate3-stripe-webhook-smoke" },
    });
    return { sent: false, status: "skipped_smoke", error: null, retryable: false };
  }

  await renewStripeCheckoutFulfillmentClaim(claim);
  const delivery = await sendBuyerActivationEmail({
    checkoutSessionId: input.checkoutSessionId,
    businessName: input.businessName,
    ownerEmail: input.ownerEmail,
    plan: input.plan,
    inviteLink: input.inviteLink,
    inviteExpiresAt: input.inviteExpiresAt,
    source: "stripe_checkout_completed",
  });
  const error = delivery.sent
    ? null
    : String(delivery.error || delivery.skippedReason || "Buyer activation email was not delivered.").slice(0, 500);
  const deliveryStatus = delivery.sent ? "sent" : delivery.retryable ? "retryable_failed" : "failed";
  const updated = await sql<{ id: number }[]>`
    WITH owned_claim AS (
      UPDATE stripe_checkout_fulfillments
      SET updated_at = NOW()
      WHERE checkout_session_id = ${input.checkoutSessionId}
        AND claim_token = ${input.claimToken}
        AND status = 'processing'
      RETURNING checkout_session_id
    )
    UPDATE provisioning_requests
    SET buyer_activation_email_status = ${deliveryStatus},
        buyer_activation_email_sent_at = ${delivery.sent ? new Date().toISOString() : null},
        buyer_activation_email_provider_id = ${delivery.providerMessageId || null},
        buyer_activation_email_error = ${error},
        status = CASE WHEN ${delivery.sent} THEN status ELSE 'manual_fallback_required' END,
        error = CASE WHEN ${delivery.sent} THEN error ELSE ${error} END,
        updated_at = NOW()
    WHERE id = ${input.provisioningRequestId}
      AND EXISTS (SELECT 1 FROM owned_claim)
    RETURNING id
  `;
  if (updated.length !== 1) throw new Error("Checkout fulfillment claim changed before buyer email delivery was recorded.");
  await createCheckoutActivationEventIfChanged(claim, {
    workspace_id: input.workspaceId,
    provisioning_request_id: input.provisioningRequestId,
    event_type: "buyer_activation_email",
    status: delivery.sent ? "complete" : "blocked",
    actor: "system",
    detail: {
      delivery_status: deliveryStatus,
      recipient_count: delivery.recipientCount,
      provider_message_id: delivery.providerMessageId || null,
      reason: error,
    },
  });
  return { sent: delivery.sent, status: deliveryStatus, error, retryable: delivery.retryable === true };
}

export async function resendCheckoutOwnerInvite(input: {
  checkoutSessionId: string;
  ownerEmail: string;
  appUrl: string;
}): Promise<{
  ok: boolean;
  status: "sent" | "not_found" | "billing_inactive" | "delivery_failed";
  retryable: boolean;
  inviteExpiresAt?: string | null;
}> {
  const rows = await sql<{
    provisioning_request_id: number;
    workspace_id: number;
    business_name: string;
    requested_plan: string;
    workspace_plan: string;
    subscription_status: string;
  }[]>`
    SELECT pr.id AS provisioning_request_id,
           pr.workspace_id,
           pr.business_name,
           pr.requested_plan,
           w.plan AS workspace_plan,
           w.subscription_status
    FROM provisioning_requests pr
    JOIN workspaces w ON w.id = pr.workspace_id
    WHERE pr.request_id = ${input.checkoutSessionId}
      AND lower(pr.owner_email) = ${input.ownerEmail.toLowerCase()}
      AND pr.source = 'stripe_checkout_completed'
    LIMIT 2
  `;
  if (rows.length !== 1) return { ok: false, status: "not_found", retryable: false };
  const row = rows[0];
  if (!hasWorkspaceBillingEntitlement(row.workspace_plan, row.subscription_status)) {
    return { ok: false, status: "billing_inactive", retryable: false };
  }

  const ownerInvite = await ensureCheckoutOwnerInvite(row.workspace_id, input.ownerEmail);
  if (!ownerInvite.invite_token || !ownerInvite.invite_expires_at) {
    return { ok: false, status: "delivery_failed", retryable: true };
  }
  const appUrl = resolveTrustedProductionAppOrigin(input.appUrl, process.env.APP_URL);
  const inviteLink = `${appUrl}/invite/${ownerInvite.invite_token}`;
  const delivery = await sendBuyerActivationEmail({
    checkoutSessionId: input.checkoutSessionId,
    businessName: row.business_name,
    ownerEmail: input.ownerEmail,
    plan: row.workspace_plan || row.requested_plan,
    inviteLink,
    inviteExpiresAt: ownerInvite.invite_expires_at,
    source: "stripe_checkout_invite_resend",
  });
  const error = delivery.sent
    ? null
    : String(delivery.error || delivery.skippedReason || "Buyer activation email was not delivered.").slice(0, 500);
  const deliveryStatus = delivery.sent ? "sent" : delivery.retryable ? "retryable_failed" : "failed";
  await sql`
    UPDATE provisioning_requests
    SET invite_link = ${inviteLink},
        buyer_activation_email_status = ${deliveryStatus},
        buyer_activation_email_sent_at = ${delivery.sent ? new Date().toISOString() : null},
        buyer_activation_email_provider_id = ${delivery.providerMessageId || null},
        buyer_activation_email_error = ${error},
        status = CASE WHEN ${delivery.sent} THEN 'workspace_created' ELSE 'manual_fallback_required' END,
        error = CASE WHEN ${delivery.sent} THEN NULL ELSE ${error} END,
        updated_at = NOW()
    WHERE id = ${row.provisioning_request_id}
      AND request_id = ${input.checkoutSessionId}
      AND lower(owner_email) = ${input.ownerEmail.toLowerCase()}
      AND source = 'stripe_checkout_completed'
  `;
  await createActivationEventIfChanged({
    workspace_id: row.workspace_id,
    provisioning_request_id: row.provisioning_request_id,
    event_type: "buyer_activation_email_resend",
    status: delivery.sent ? "complete" : "blocked",
    actor: "customer",
    detail: {
      delivery_status: deliveryStatus,
      provider_message_id: delivery.providerMessageId || null,
      reason: error,
    },
  });
  return {
    ok: delivery.sent,
    status: delivery.sent ? "sent" : "delivery_failed",
    retryable: delivery.retryable === true,
    inviteExpiresAt: ownerInvite.invite_expires_at,
  };
}

async function handleCheckoutCompleted(event: any): Promise<string | null> {
  const classification = classifySmirkCheckoutForFulfillment(
    event,
    paymentLinkFulfillmentBindingsFromEnv(process.env),
    String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim(),
  );
  const { session, plan } = classification;
  const metadata = session.metadata || {};
  if (!classification.approved) return null;
  const customerPolicyVersion = String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || "").trim();
  const customerPolicy = evaluateCustomerPolicyApproval(customerPolicyVersion);
  if (!classification.approvedSyntheticSmoke && !customerPolicyReadyForPlan(customerPolicy, plan)) return null;

  const checkoutSessionId = classification.checkoutSessionId;
  if (!checkoutSessionId) return null;
  const eventId = cleanStripeId(event.id);
  const claimToken = await claimStripeCheckoutFulfillment(checkoutSessionId, eventId);
  if (!claimToken) return null;
  const claim = { checkoutSessionId, claimToken };

  try {
  const ownerEmail = String(session.customer_details?.email || metadata.owner_email || session.customer_email || "").trim().toLowerCase();
  const businessName = String(
    session.customer_details?.business_name
      || metadata.business_name
      || session.customer_details?.name
      || ownerEmail
      || "Paid SMIRK Workspace",
  ).trim();
  const ownerPhone = String(session.customer_details?.phone || metadata.owner_phone || "").trim();
  const verifiedPlan = plan!;
  const mode = "missed_call_recovery" as const;
  // The Checkout Session is stable across event retries and async-payment events;
  // the Stripe Event ID is not. Use the Session as the durable fulfillment key.
  const requestId = checkoutSessionId;
  const stripeCustomerId = String(session.customer || "").trim() || null;
  const stripeSubscriptionId = String(session.subscription || "").trim() || null;

  if (!ownerEmail) {
    const missingEmailRequestId = await upsertCheckoutProvisioningRequest({
      claim,
      businessName,
      ownerEmail: "unknown",
      plan: verifiedPlan,
      mode,
      status: "manual_fallback_required",
      error: "Paid checkout completed without an owner email.",
    });
    await createCheckoutActivationEventIfChanged(claim, {
      provisioning_request_id: missingEmailRequestId,
      event_type: "operator_exception",
      status: "blocked",
      actor: "system",
      detail: {
        activation_stage: "operator_exception",
        source: "stripe_checkout_completed",
        reason: "Paid checkout completed without an owner email.",
        requested_plan: verifiedPlan,
        stripe_livemode: event?.livemode === true,
        payment_status: session?.payment_status || null,
        amount_total: Number(session?.amount_total || 0),
        currency: session?.currency || null,
      },
    });
    await sendCheckoutProvisioningAlert(claim, {
      event: "stripe_missing_owner_email",
      businessName,
      ownerEmail: "unknown",
      ownerPhone,
      plan: verifiedPlan,
      mode,
      source: "stripe_checkout_completed",
      status: "manual_fallback_required",
      error: "Paid checkout completed without an owner email.",
      approvedSyntheticSmoke: classification.approvedSyntheticSmoke,
    });
    return claimToken;
  }

  const existingByRequest = await sql<{
    id: number;
    workspace_id: number | null;
    invite_link: string | null;
    status: string;
  }[]>`
    SELECT id, workspace_id, invite_link, status
    FROM provisioning_requests
    WHERE request_id = ${requestId}
      AND source = 'stripe_checkout_completed'
    LIMIT 2
  `;
  if (existingByRequest.length > 1) throw new Error("Multiple provisioning requests share one Checkout Session.");
  const existingRequest = existingByRequest[0] || null;

  const existingWorkspace = await sql<Workspace[]>`
    SELECT *
    FROM workspaces
    WHERE stripe_customer_id = ${stripeCustomerId}
      AND stripe_subscription_id = ${stripeSubscriptionId}
    ORDER BY created_at DESC
    LIMIT 2
  `;
  if (existingWorkspace.length > 1) throw new Error("Multiple workspaces share the same Stripe subscription binding.");
  if (existingWorkspace.length === 1 && existingWorkspace[0]?.id) {
    const checkoutEventCreated = stripeBillingEventCreatedSeconds(event?.created);
    const shouldAdvanceBillingEvent = Boolean(
      checkoutEventCreated
      && eventId
      && (!existingWorkspace[0].stripe_billing_event_created
        || Number(existingWorkspace[0].stripe_billing_event_created) < checkoutEventCreated),
    );
    await updateWorkspaceForCheckoutClaim(claim, existingWorkspace[0].id, {
      plan: verifiedPlan,
      stripe_customer_id: stripeCustomerId || undefined,
      stripe_subscription_id: stripeSubscriptionId || undefined,
      stripe_billing_event_created: shouldAdvanceBillingEvent ? checkoutEventCreated! : undefined,
      stripe_billing_event_id: shouldAdvanceBillingEvent ? eventId! : undefined,
      business_name: businessName,
      owner_phone: ownerPhone || undefined,
      notification_email: ownerEmail,
    });
    const invite = await ensureCheckoutOwnerInvite(existingWorkspace[0].id, ownerEmail, claim, false);
    const appBase = resolveTrustedProductionAppOrigin(process.env.APP_URL);
    const storedInviteLink = normalizeTrustedProductionAppUrl(existingRequest?.invite_link);
    const inviteLink = invite.invite_token
      ? `${appBase}/invite/${invite.invite_token}`
      : (storedInviteLink && new URL(storedInviteLink).pathname.startsWith("/invite/") ? storedInviteLink : `${appBase}/dashboard`);
    const existingProvisioningRequestId = await upsertCheckoutProvisioningRequest({
      claim,
      workspaceId: existingWorkspace[0].id,
      businessName,
      ownerEmail,
      plan: verifiedPlan,
      mode,
      status: "workspace_created",
      inviteLink,
    });
    await createCheckoutActivationEventIfChanged(claim, {
      workspace_id: existingWorkspace[0].id,
      provisioning_request_id: existingProvisioningRequestId,
      event_type: "checkout_completed",
      status: "complete",
      actor: "system",
      detail: {
        activation_stage: "workspace_created",
        source: "stripe_checkout_completed",
        requested_plan: verifiedPlan,
        existing_workspace: true,
        stripe_livemode: event?.livemode === true,
        payment_status: session?.payment_status || null,
        amount_total: Number(session?.amount_total || 0),
        currency: session?.currency || null,
      },
    });
    await createCheckoutActivationEventIfChanged(claim, {
      workspace_id: existingWorkspace[0].id,
      provisioning_request_id: existingProvisioningRequestId,
      event_type: "workspace_created",
      status: "complete",
      actor: "system",
      detail: {
        activation_stage: "workspace_created",
        invite_link: inviteLink,
        existing_workspace: true,
      },
    });
    const refreshedWorkspace = await getWorkspaceById(existingWorkspace[0].id);
    if (refreshedWorkspace) {
      await reconcileStripePaymentFactsForWorkspace(refreshedWorkspace);
      await reconcileStripeSubscriptionStateForWorkspace(refreshedWorkspace);
    }
    await renewStripeCheckoutFulfillmentClaim(claim);
    const reconciledWorkspace = await getWorkspaceById(existingWorkspace[0].id);
    if (!reconciledWorkspace || !hasWorkspaceBillingEntitlement(reconciledWorkspace.plan, reconciledWorkspace.subscription_status)) {
      const reason = `Paid workspace billing state ${reconciledWorkspace?.subscription_status || "unknown"} does not permit buyer activation email delivery.`;
      await setCheckoutProvisioningFallback(claim, existingProvisioningRequestId, reason);
      await createCheckoutActivationEventIfChanged(claim, {
        workspace_id: existingWorkspace[0].id,
        provisioning_request_id: existingProvisioningRequestId,
        event_type: "buyer_activation_email",
        status: "blocked",
        actor: "system",
        detail: { delivery_status: "blocked_billing", reason },
      });
      await sendCheckoutProvisioningAlert(claim, {
        event: "stripe_manual_fallback",
        businessName,
        ownerEmail,
        ownerPhone,
        plan: verifiedPlan,
        mode,
        source: "stripe_checkout_completed",
        status: "manual_fallback_required",
        provisioningRequestId: existingProvisioningRequestId,
        workspaceId: existingWorkspace[0].id,
        error: reason,
        approvedSyntheticSmoke: classification.approvedSyntheticSmoke,
      });
      return claimToken;
    }
    const buyerDelivery = await deliverCheckoutBuyerActivation({
      provisioningRequestId: existingProvisioningRequestId,
      workspaceId: existingWorkspace[0].id,
      checkoutSessionId,
      claimToken,
      businessName,
      ownerEmail,
      plan: verifiedPlan,
      inviteLink,
      inviteExpiresAt: invite.invite_expires_at || "",
      approvedSyntheticSmoke: classification.approvedSyntheticSmoke,
    });
    if (existingRequest?.status !== "workspace_created" || (buyerDelivery.status !== "sent" && buyerDelivery.status !== "skipped_smoke")) await sendCheckoutProvisioningAlert(claim, {
      event: "stripe_existing_workspace_updated",
      businessName,
      ownerEmail,
      ownerPhone,
      plan: verifiedPlan,
      mode,
      source: "stripe_checkout_completed",
      status: buyerDelivery.status === "sent" || buyerDelivery.status === "skipped_smoke" ? "workspace_created" : "manual_fallback_required",
      workspaceId: existingWorkspace[0].id,
      inviteLink,
      error: buyerDelivery.error,
      approvedSyntheticSmoke: classification.approvedSyntheticSmoke,
    });
    if (buyerDelivery.retryable) {
      const retryableError = new Error(buyerDelivery.error || "Buyer activation email delivery needs retry.") as Error & { code?: string };
      retryableError.code = "BUYER_ACTIVATION_EMAIL_RETRYABLE";
      throw retryableError;
    }
    return claimToken;
  }

  const autoFulfill = String(process.env.AUTO_FULFILL_PROVISIONING_REQUESTS || "false").trim().toLowerCase() === "true";
  const provisioningRequestId = await upsertCheckoutProvisioningRequest({
    claim,
    businessName,
    ownerEmail,
    plan: verifiedPlan,
    mode,
    status: autoFulfill ? "pending_auto_fulfillment" : "manual_fallback_required",
  });

  if (!autoFulfill) {
    await createCheckoutActivationEventIfChanged(claim, {
      provisioning_request_id: provisioningRequestId,
      event_type: "checkout_completed",
      status: "complete",
      actor: "system",
      detail: {
        activation_stage: "operator_exception",
        source: "stripe_checkout_completed",
        requested_plan: verifiedPlan,
        stripe_livemode: event?.livemode === true,
        payment_status: session?.payment_status || null,
        amount_total: Number(session?.amount_total || 0),
        currency: session?.currency || null,
      },
    });
    await createCheckoutActivationEventIfChanged(claim, {
      provisioning_request_id: provisioningRequestId,
      event_type: "operator_exception",
      status: "blocked",
      actor: "system",
      detail: {
        activation_stage: "operator_exception",
        reason: "Automatic fulfillment is disabled.",
        requested_plan: verifiedPlan,
      },
    });
    await sendCheckoutProvisioningAlert(claim, {
      event: "stripe_manual_fallback",
      businessName,
      ownerEmail,
      ownerPhone,
      plan: verifiedPlan,
      mode,
      source: "stripe_checkout_completed",
      status: "manual_fallback_required",
      provisioningRequestId,
      approvedSyntheticSmoke: classification.approvedSyntheticSmoke,
    });
    return claimToken;
  }

  try {
    const workspace = await createWorkspaceForCheckoutClaim(claim, {
      name: businessName,
      ownerEmail,
      plan: verifiedPlan,
      mode,
      stripeCustomerId,
      stripeSubscriptionId,
      stripeBillingEventCreated: stripeBillingEventCreatedSeconds(event?.created),
      stripeBillingEventId: eventId,
      businessName,
      ownerPhone: ownerPhone || null,
    });
    const ownerInvite = await ensureCheckoutOwnerInvite(workspace.id, ownerEmail, claim, false);
    const appBase = resolveTrustedProductionAppOrigin(process.env.APP_URL);
    const inviteLink = `${appBase}/invite/${ownerInvite.invite_token}`;
    const createdProvisioningRequestId = await upsertCheckoutProvisioningRequest({
      claim,
      workspaceId: workspace.id,
      businessName,
      ownerEmail,
      plan: verifiedPlan,
      mode,
      status: "workspace_created",
      inviteLink,
      workspaceApiKey: workspace.api_key,
    });
    if (createdProvisioningRequestId !== provisioningRequestId) throw new Error("Checkout provisioning request identity changed during fulfillment.");
    await createCheckoutActivationEventIfChanged(claim, {
      workspace_id: workspace.id,
      provisioning_request_id: provisioningRequestId,
      event_type: "checkout_completed",
      status: "complete",
      actor: "system",
      detail: {
        activation_stage: "workspace_created",
        source: "stripe_checkout_completed",
        requested_plan: verifiedPlan,
        stripe_livemode: event?.livemode === true,
        payment_status: session?.payment_status || null,
        amount_total: Number(session?.amount_total || 0),
        currency: session?.currency || null,
      },
    });
    await createCheckoutActivationEventIfChanged(claim, {
      workspace_id: workspace.id,
      provisioning_request_id: provisioningRequestId,
      event_type: "workspace_created",
      status: "complete",
      actor: "system",
      detail: {
        activation_stage: "workspace_created",
        invite_link: inviteLink,
      },
    });
    try {
      await reconcileStripePaymentFactsForWorkspace(workspace);
      await reconcileStripeSubscriptionStateForWorkspace(workspace);
    } catch (error) {
      const reconciliationError = error instanceof Error ? error : new Error(String(error));
      (reconciliationError as Error & { code?: string }).code = "STRIPE_BILLING_RECONCILIATION_RETRYABLE";
      throw reconciliationError;
    }
    await renewStripeCheckoutFulfillmentClaim(claim);
    const reconciledWorkspace = await getWorkspaceById(workspace.id);
    if (!reconciledWorkspace || !hasWorkspaceBillingEntitlement(reconciledWorkspace.plan, reconciledWorkspace.subscription_status)) {
      const reason = `Paid workspace billing state ${reconciledWorkspace?.subscription_status || "unknown"} does not permit buyer activation email delivery.`;
      await setCheckoutProvisioningFallback(claim, provisioningRequestId, reason);
      await createCheckoutActivationEventIfChanged(claim, {
        workspace_id: workspace.id,
        provisioning_request_id: provisioningRequestId,
        event_type: "buyer_activation_email",
        status: "blocked",
        actor: "system",
        detail: { delivery_status: "blocked_billing", reason },
      });
      await sendCheckoutProvisioningAlert(claim, {
        event: "stripe_manual_fallback",
        businessName,
        ownerEmail,
        ownerPhone,
        plan: verifiedPlan,
        mode,
        source: "stripe_checkout_completed",
        status: "manual_fallback_required",
        provisioningRequestId,
        workspaceId: workspace.id,
        error: reason,
        approvedSyntheticSmoke: classification.approvedSyntheticSmoke,
      });
      return claimToken;
    }
    const buyerDelivery = await deliverCheckoutBuyerActivation({
      provisioningRequestId,
      workspaceId: workspace.id,
      checkoutSessionId,
      claimToken,
      businessName,
      ownerEmail,
      plan: verifiedPlan,
      inviteLink,
      inviteExpiresAt: ownerInvite.invite_expires_at || "",
      approvedSyntheticSmoke: classification.approvedSyntheticSmoke,
    });
    await sendCheckoutProvisioningAlert(claim, {
      event: "stripe_workspace_created",
      businessName,
      ownerEmail,
      ownerPhone,
      plan: verifiedPlan,
      mode,
      source: "stripe_checkout_completed",
      status: buyerDelivery.status === "sent" || buyerDelivery.status === "skipped_smoke" ? "workspace_created" : "manual_fallback_required",
      provisioningRequestId,
      workspaceId: workspace.id,
      inviteLink,
      error: buyerDelivery.error,
      approvedSyntheticSmoke: classification.approvedSyntheticSmoke,
    });
    if (buyerDelivery.retryable) {
      const retryableError = new Error(buyerDelivery.error || "Buyer activation email delivery needs retry.") as Error & { code?: string };
      retryableError.code = "BUYER_ACTIVATION_EMAIL_RETRYABLE";
      throw retryableError;
    }
  } catch (err: any) {
    const errorMessage = err?.message || 'Paid checkout provisioning failed';
    await setCheckoutProvisioningFallback(claim, provisioningRequestId, errorMessage);
    await createCheckoutActivationEventIfChanged(claim, {
      provisioning_request_id: provisioningRequestId,
      event_type: "operator_exception",
      status: "blocked",
      actor: "system",
      detail: {
        activation_stage: "operator_exception",
        source: "stripe_checkout_completed",
        requested_plan: verifiedPlan,
        error: errorMessage,
      },
    });
    await sendCheckoutProvisioningAlert(claim, {
      event: "stripe_manual_fallback",
      businessName,
      ownerEmail,
      ownerPhone,
      plan: verifiedPlan,
      mode,
      source: "stripe_checkout_completed",
      status: "manual_fallback_required",
      provisioningRequestId,
      error: errorMessage,
      approvedSyntheticSmoke: classification.approvedSyntheticSmoke,
    });
    throw err;
  }
  return claimToken;
  } catch (error) {
    await finishStripeCheckoutFulfillment(checkoutSessionId, claimToken, "failed", error);
    throw error;
  }
}

export async function recordPaidCheckoutException(
  event: any,
  input: { reason?: string | null; plan?: "starter" | "pro" | "enterprise" | null } = {},
): Promise<{ recorded: boolean; checkoutSessionId?: string; alertSent?: boolean }> {
  const allowedPaymentLinkIds = candidateStarterPaymentLinkFulfillmentIds({
    currentId: process.env.STRIPE_PAYMENT_LINK_STARTER_ID,
    rawIds: process.env.STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS,
  });
  for (const key of ["STRIPE_PAYMENT_LINK_PRO_ID", "STRIPE_PAYMENT_LINK_ENTERPRISE_ID"] as const) {
    const candidate = String(process.env[key] || "").trim();
    if (/^plink_[A-Za-z0-9_]+$/.test(candidate) && !allowedPaymentLinkIds.includes(candidate)) {
      allowedPaymentLinkIds.push(candidate);
    }
  }
  const fact = extractPaidCheckoutException(event, { ...input, allowedPaymentLinkIds });
  if (!fact) return { recorded: false };
  const rows = await sql<{ checkout_session_id: string }[]>`
    INSERT INTO stripe_paid_checkout_exceptions (
      checkout_session_id, stripe_event_id, payment_link_id, stripe_customer_id,
      stripe_subscription_id, buyer_email, business_name, owner_phone, plan,
      amount_subtotal, amount_total, currency, reason, status
    ) VALUES (
      ${fact.checkoutSessionId}, ${fact.stripeEventId}, ${fact.paymentLinkId}, ${fact.stripeCustomerId},
      ${fact.stripeSubscriptionId}, ${fact.buyerEmail}, ${fact.businessName}, ${fact.ownerPhone}, ${fact.plan},
      ${fact.amountSubtotal}, ${fact.amountTotal}, ${fact.currency}, ${fact.reason}, 'manual_review_required'
    )
    ON CONFLICT (checkout_session_id) DO UPDATE SET
      stripe_event_id = EXCLUDED.stripe_event_id,
      payment_link_id = COALESCE(EXCLUDED.payment_link_id, stripe_paid_checkout_exceptions.payment_link_id),
      stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, stripe_paid_checkout_exceptions.stripe_customer_id),
      stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, stripe_paid_checkout_exceptions.stripe_subscription_id),
      buyer_email = EXCLUDED.buyer_email,
      business_name = EXCLUDED.business_name,
      owner_phone = COALESCE(EXCLUDED.owner_phone, stripe_paid_checkout_exceptions.owner_phone),
      plan = EXCLUDED.plan,
      amount_subtotal = EXCLUDED.amount_subtotal,
      amount_total = EXCLUDED.amount_total,
      currency = EXCLUDED.currency,
      reason = EXCLUDED.reason,
      status = 'manual_review_required',
      updated_at = NOW()
    RETURNING checkout_session_id
  `;
  if (rows.length !== 1) throw new Error("Paid checkout exception was not durably recorded.");

  const rescueError = `Paid live checkout could not be safely auto-fulfilled: ${fact.reason}. Review the exact Stripe payment and either activate safely or prepare an approved refund.`;
  const provisioningRows = await sql<{ id: number }[]>`
    INSERT INTO provisioning_requests (
      request_id, business_name, owner_email, owner_phone, requested_plan,
      requested_mode, status, source, error
    ) VALUES (
      ${fact.checkoutSessionId}, ${fact.businessName}, ${fact.buyerEmail}, ${fact.ownerPhone}, ${fact.plan},
      'missed_call_recovery', 'manual_fallback_required', 'stripe_checkout_exception', ${rescueError}
    )
    ON CONFLICT (request_id) WHERE source = 'stripe_checkout_exception' AND request_id IS NOT NULL
    DO UPDATE SET
      business_name = EXCLUDED.business_name,
      owner_email = EXCLUDED.owner_email,
      owner_phone = COALESCE(EXCLUDED.owner_phone, provisioning_requests.owner_phone),
      requested_plan = EXCLUDED.requested_plan,
      status = 'manual_fallback_required',
      error = EXCLUDED.error,
      updated_at = NOW()
    RETURNING id
  `;
  if (provisioningRows.length !== 1) throw new Error("Paid checkout exception was not added to the operator rescue queue.");

  const alert = await sendProvisioningAlert({
    event: "stripe_paid_checkout_exception",
    businessName: fact.businessName,
    ownerEmail: fact.buyerEmail,
    ownerPhone: fact.ownerPhone,
    plan: fact.plan,
    mode: "missed_call_recovery",
    source: "stripe_checkout_verification_exception",
    status: "manual_review_required",
    provisioningRequestId: provisioningRows[0].id,
    error: `Paid live Checkout Session ${fact.checkoutSessionId} could not be auto-fulfilled: ${fact.reason}. Review the payment immediately and either safely activate the buyer or prepare an approved refund.`,
    deliveryScope: fact.checkoutSessionId,
  });
  if (!alert.sent) {
    const error = new Error(alert.error || alert.skippedReason || "Paid checkout exception alert was not delivered.") as Error & { code?: string };
    error.code = "PAID_CHECKOUT_EXCEPTION_ALERT_RETRYABLE";
    throw error;
  }
  return { recorded: true, checkoutSessionId: fact.checkoutSessionId, alertSent: true };
}

export async function handleStripeWebhook(event: any): Promise<void> {
  const type = event.type as string;
  const obj = event.data?.object;
  const liveBillingObject = event?.livemode === true && obj?.livemode === true;
  const billingEventCreated = stripeBillingEventCreatedSeconds(event?.created);
  const billingEventId = cleanStripeId(event?.id);

  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    const checkoutSessionId = cleanStripeId(obj?.id);
    const claimToken = await handleCheckoutCompleted(event);
    if (claimToken && checkoutSessionId) {
      const finished = await finishStripeCheckoutFulfillment(checkoutSessionId, claimToken, "complete");
      if (!finished) throw checkoutClaimLostError();
    }
  }

  if ((type === "customer.subscription.created" || type === "customer.subscription.updated") && liveBillingObject) {
    const customerId = cleanStripeId(obj.customer);
    const subscriptionId = cleanStripeId(obj.id);
    const status = normalizeStripeSubscriptionStatus(obj.status);
    const planSource = obj.metadata?.plan || obj.items?.data?.[0]?.price?.nickname || obj.items?.data?.[0]?.price?.lookup_key || obj.items?.data?.[0]?.price?.product?.name;
    const plan = strictPaidPlan(planSource);
    if (customerId && subscriptionId && billingEventCreated && billingEventId) {
      const fact = await recordStripeSubscriptionStateFact({
        subscriptionId,
        customerId,
        status,
        sourceEventType: type,
        eventCreated: billingEventCreated,
        eventId: billingEventId,
      });
      const workspace = await findWorkspaceByStripeIds({ customerId, subscriptionId });
      if (fact && workspace) await applyStripeSubscriptionStateFactToWorkspace(workspace, fact, false);
      const incomingIsLatest = fact?.event_id === billingEventId && Number(fact.event_created) === billingEventCreated;
      if (plan && workspace && incomingIsLatest) {
        const limits = PLAN_LIMITS[plan];
        await sql`
          UPDATE workspaces
          SET plan = ${plan},
            monthly_call_limit = ${limits.calls},
            monthly_minute_limit = ${limits.minutes},
            updated_at = NOW()
          WHERE id = ${workspace.id}
            AND stripe_subscription_id = ${subscriptionId}
            AND stripe_customer_id = ${customerId}
        `;
      }
    }
  }

  if ((type === "invoice.paid" || type === "invoice.payment_succeeded") && liveBillingObject) {
    await recordStripeInvoicePaymentBindings(obj);
  }

  if (type === "customer.subscription.deleted" && liveBillingObject) {
    const customerId = cleanStripeId(obj.customer);
    const subscriptionId = cleanStripeId(obj.id);
    if (customerId && subscriptionId && billingEventCreated && billingEventId) {
      const fact = await recordStripeSubscriptionStateFact({
        subscriptionId,
        customerId,
        status: "canceled",
        sourceEventType: type,
        eventCreated: billingEventCreated,
        eventId: billingEventId,
      });
      const matchedWorkspace = await findWorkspaceByStripeIds({ customerId, subscriptionId });
      const appliedWorkspace = fact && matchedWorkspace
        ? await applyStripeSubscriptionStateFactToWorkspace(matchedWorkspace, fact, false)
        : null;
      const incomingWasCurrent = fact?.event_id === billingEventId && Number(fact.event_created) === billingEventCreated;
      const lifecycleWorkspace = appliedWorkspace || (incomingWasCurrent ? matchedWorkspace : null);
      if (!matchedWorkspace || incomingWasCurrent) await recordStripeBillingLifecycle({
        workspace: lifecycleWorkspace,
        eventType: "billing_subscription_canceled",
        alertEvent: "stripe_subscription_canceled",
        status: "info",
        source: "customer.subscription.deleted",
        stripeEventId: billingEventId,
        detail: {
          customer_id: customerId,
          subscription_id: subscriptionId,
          exact_subscription_binding: Boolean(lifecycleWorkspace),
          reason: "Stripe subscription was canceled or deleted.",
        },
      });
    }
  }

  if (type === "invoice.payment_failed" && liveBillingObject) {
    const customerId = cleanStripeId(obj.customer);
    const subscriptionId = stripeInvoiceSubscriptionId(obj);
    if (customerId && subscriptionId && billingEventCreated && billingEventId) {
      const fact = await recordStripeSubscriptionStateFact({
        subscriptionId,
        customerId,
        status: "past_due",
        sourceEventType: type,
        eventCreated: billingEventCreated,
        eventId: billingEventId,
      });
      const matchedWorkspace = await findWorkspaceByStripeIds({ customerId, subscriptionId });
      const appliedWorkspace = fact && matchedWorkspace
        ? await applyStripeSubscriptionStateFactToWorkspace(matchedWorkspace, fact, false)
        : null;
      const incomingWasCurrent = fact?.event_id === billingEventId && Number(fact.event_created) === billingEventCreated;
      const lifecycleWorkspace = appliedWorkspace || (incomingWasCurrent ? matchedWorkspace : null);
      if (!matchedWorkspace || incomingWasCurrent) await recordStripeBillingLifecycle({
        workspace: lifecycleWorkspace,
        eventType: "billing_payment_failed",
        alertEvent: "stripe_payment_failed",
        status: "blocked",
        source: "invoice.payment_failed",
        stripeEventId: billingEventId,
        detail: {
          customer_id: customerId,
          subscription_id: subscriptionId,
          invoice_id: cleanStripeId(obj.id),
          exact_subscription_binding: Boolean(lifecycleWorkspace),
          amount_due: obj.amount_due ?? null,
          currency: obj.currency || null,
          hosted_invoice_url: obj.hosted_invoice_url || null,
          reason: "Stripe invoice payment failed. Billing follow-up is required before scaling paid launch.",
        },
      });
    }
  }

  if (type === "charge.refunded" && liveBillingObject && billingEventId) {
    const customerId = cleanStripeId(obj.customer);
    const paymentIntentId = cleanStripeId(obj.payment_intent);
    const fullyRefunded = Number(obj.amount || 0) > 0 && Number(obj.amount_refunded || 0) >= Number(obj.amount || 0);
    if (paymentIntentId) await sql`
      INSERT INTO stripe_payment_adverse_events (
        payment_intent_id, customer_id, charge_id, fully_refunded, disputed, stripe_event_id
      ) VALUES (
        ${paymentIntentId}, ${customerId}, ${cleanStripeId(obj.id)}, ${fullyRefunded}, FALSE, ${billingEventId}
      )
      ON CONFLICT (payment_intent_id) DO UPDATE
        SET customer_id = COALESCE(stripe_payment_adverse_events.customer_id, EXCLUDED.customer_id),
            charge_id = COALESCE(EXCLUDED.charge_id, stripe_payment_adverse_events.charge_id),
            fully_refunded = stripe_payment_adverse_events.fully_refunded OR EXCLUDED.fully_refunded,
            stripe_event_id = EXCLUDED.stripe_event_id,
            updated_at = NOW()
    `;
    const bindingRows = paymentIntentId && customerId ? await sql<{ workspace_id: number; customer_id: string; subscription_id: string }[]>`
      SELECT workspace_id, customer_id, subscription_id
      FROM stripe_payment_bindings
      WHERE payment_intent_id = ${paymentIntentId}
        AND customer_id = ${customerId}
        AND workspace_id IS NOT NULL
      LIMIT 2
    ` : [];
    const exactBinding = bindingRows.length === 1 ? bindingRows[0] : null;
    const workspace = exactBinding ? await getWorkspaceById(exactBinding.workspace_id) : null;
    const exactWorkspace = matchesExactStripeWorkspaceBinding(workspace, exactBinding) ? workspace : null;
    if (fullyRefunded && exactWorkspace?.id) {
      await sql`
        UPDATE workspaces
        SET subscription_status = 'refunded', updated_at = NOW()
        WHERE id = ${exactWorkspace.id}
          AND stripe_customer_id = ${exactBinding!.customer_id}
          AND stripe_subscription_id = ${exactBinding!.subscription_id}
      `;
    }
    await recordStripeBillingLifecycle({
      workspace: exactWorkspace,
      eventType: "billing_refund_recorded",
      alertEvent: "stripe_refund_recorded",
      status: "info",
      source: "charge.refunded",
      stripeEventId: billingEventId,
      detail: {
        customer_id: customerId,
        charge_id: cleanStripeId(obj.id),
        payment_intent_id: paymentIntentId,
        exact_subscription_binding: Boolean(exactBinding && exactWorkspace?.id),
        amount_refunded: obj.amount_refunded ?? null,
        amount: obj.amount ?? null,
        fully_refunded: fullyRefunded,
        currency: obj.currency || null,
        receipt_url: obj.receipt_url || null,
        reason: "Stripe charge refund was recorded. Confirm cancellation/access state manually if needed.",
      },
    });
  }

  if (type === "charge.dispute.created" && liveBillingObject && billingEventId) {
    const paymentIntentId = cleanStripeId(obj.payment_intent);
    const chargeId = cleanStripeId(obj.charge);
    if (paymentIntentId) await sql`
      INSERT INTO stripe_payment_adverse_events (
        payment_intent_id, charge_id, fully_refunded, disputed, stripe_event_id
      ) VALUES (
        ${paymentIntentId}, ${chargeId}, FALSE, TRUE, ${billingEventId}
      )
      ON CONFLICT (payment_intent_id) DO UPDATE
        SET charge_id = COALESCE(EXCLUDED.charge_id, stripe_payment_adverse_events.charge_id),
            disputed = TRUE,
            stripe_event_id = EXCLUDED.stripe_event_id,
            updated_at = NOW()
    `;
    const bindingRows = paymentIntentId ? await sql<{ workspace_id: number; customer_id: string; subscription_id: string }[]>`
      SELECT workspace_id, customer_id, subscription_id
      FROM stripe_payment_bindings
      WHERE payment_intent_id = ${paymentIntentId}
        AND workspace_id IS NOT NULL
      LIMIT 2
    ` : [];
    const exactBinding = bindingRows.length === 1 ? bindingRows[0] : null;
    const workspace = exactBinding ? await getWorkspaceById(exactBinding.workspace_id) : null;
    const exactWorkspace = matchesExactStripeWorkspaceBinding(workspace, exactBinding) ? workspace : null;
    if (exactWorkspace?.id) await sql`
      UPDATE workspaces
      SET subscription_status = 'disputed', updated_at = NOW()
      WHERE id = ${exactWorkspace.id}
        AND stripe_customer_id = ${exactBinding!.customer_id}
        AND stripe_subscription_id = ${exactBinding!.subscription_id}
    `;
    await recordStripeBillingLifecycle({
      workspace: exactWorkspace,
      eventType: "billing_dispute_recorded",
      alertEvent: "stripe_dispute_recorded",
      status: "blocked",
      source: "charge.dispute.created",
      stripeEventId: billingEventId,
      detail: {
        charge_id: chargeId,
        payment_intent_id: paymentIntentId,
        exact_subscription_binding: Boolean(exactBinding && exactWorkspace?.id),
        amount: obj.amount ?? null,
        currency: obj.currency || null,
        disputed: true,
        reason: "Stripe reported a payment dispute. Access remains suspended pending operator review.",
      },
    });
  }
}

// ── Workspace Stats ────────────────────────────────────────────────────────────

export async function getWorkspaceStats(workspaceId: number): Promise<{
  totalCalls: number;
  callsThisMonth: number;
  minutesThisMonth: number;
  totalContacts: number;
  openTasks: number;
  upcomingAppointments: number;
  recentCalls: any[];
}> {
  const [stats, recentCalls] = await Promise.all([
    sql`
      SELECT
        (SELECT COUNT(*) FROM calls WHERE workspace_id = ${workspaceId}) as total_calls,
        (SELECT calls_this_month FROM workspaces WHERE id = ${workspaceId}) as calls_this_month,
        (SELECT minutes_this_month FROM workspaces WHERE id = ${workspaceId}) as minutes_this_month,
        (SELECT COUNT(*) FROM contacts WHERE workspace_id = ${workspaceId}) as total_contacts,
        (SELECT COUNT(*) FROM tasks WHERE workspace_id = ${workspaceId} AND status = 'open') as open_tasks,
        (SELECT COUNT(*) FROM appointments WHERE workspace_id = ${workspaceId} AND scheduled_at > NOW()) as upcoming_appointments
    `,
    sql`
      SELECT c.call_sid, c.from_number, c.started_at, c.duration_seconds AS duration, c.status,
             cs.intent, cs.outcome, cs.sentiment
      FROM calls c
      LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
      WHERE c.workspace_id = ${workspaceId}
      ORDER BY c.started_at DESC LIMIT 5
    `,
  ]);

  const s = stats[0] || {};
  return {
    totalCalls: parseInt(s.total_calls) || 0,
    callsThisMonth: parseInt(s.calls_this_month) || 0,
    minutesThisMonth: parseInt(s.minutes_this_month) || 0,
    totalContacts: parseInt(s.total_contacts) || 0,
    openTasks: parseInt(s.open_tasks) || 0,
    upcomingAppointments: parseInt(s.upcoming_appointments) || 0,
    recentCalls,
  };
}
