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
import { sendProvisioningAlert } from "./monetization-alerts.js";
import { classifySmirkCheckoutForFulfillment, strictSmirkPaidPlan } from "./checkout-safety.js";
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
  monthly_call_limit: number;   // -1 = unlimited
  monthly_minute_limit: number; // -1 = unlimited
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
  accepted_at?: string;
  invite_token?: string;
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

export const PLAN_LIMITS = {
  free:       { calls: 50,   minutes: 100,  agents: 1,  label: "Free Trial" },
  starter:    { calls: 500,  minutes: 1000, agents: 3,  label: "Starter — $197/mo" },
  pro:        { calls: 2000, minutes: 5000, agents: 9,  label: "Pro — $397/mo" },
  enterprise: { calls: -1,   minutes: -1,   agents: -1, label: "Agency — $697/mo" },
} as const;

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

  await sql`
    CREATE TABLE IF NOT EXISTS workspace_members (
      id           SERIAL PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email        TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'viewer',
      invited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at  TIMESTAMPTZ,
      invite_token TEXT UNIQUE,
      UNIQUE(workspace_id, email)
    )
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
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS deposit_percent INTEGER NOT NULL DEFAULT 10`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS deposit_status TEXT NOT NULL DEFAULT 'not_sent'`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS balance_status TEXT NOT NULL DEFAULT 'not_ready'`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS onboarding_source TEXT`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS caller_phone TEXT`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS trusted_intake BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE provisioning_requests ADD COLUMN IF NOT EXISTS handoff_team_member_id INTEGER`;

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

export async function incrementWorkspaceUsage(
  workspaceId: number,
  callDurationSeconds: number
): Promise<void> {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const minutes = Math.ceil(callDurationSeconds / 60);

  await sql`
    INSERT INTO workspace_usage (workspace_id, month, calls, minutes)
    VALUES (${workspaceId}, ${month}, 1, ${minutes})
    ON CONFLICT (workspace_id, month) DO UPDATE SET
      calls = workspace_usage.calls + 1,
      minutes = workspace_usage.minutes + ${minutes}
  `;

  await sql`
    UPDATE workspaces SET
      calls_this_month = calls_this_month + 1,
      minutes_this_month = minutes_this_month + ${minutes}
    WHERE id = ${workspaceId}
  `;
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

  if (ws.monthly_call_limit !== -1 && ws.calls_this_month >= ws.monthly_call_limit) {
    return { allowed: false, reason: `Monthly call limit reached (${ws.monthly_call_limit} calls)`, subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
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
    INSERT INTO workspace_members (workspace_id, email, role, invite_token)
    VALUES (${workspaceId}, ${email}, ${role}, ${token})
    ON CONFLICT (workspace_id, email) DO UPDATE SET role = EXCLUDED.role, invite_token = EXCLUDED.invite_token
    RETURNING *
  `;
  return rows[0];
}

async function ensureCheckoutOwnerInvite(workspaceId: number, email: string): Promise<WorkspaceMember> {
  const token = generateInviteToken();
  const rows = await sql<WorkspaceMember[]>`
    INSERT INTO workspace_members (workspace_id, email, role, invite_token)
    VALUES (${workspaceId}, ${email}, 'owner', ${token})
    ON CONFLICT (workspace_id, email) DO UPDATE
      SET role = 'owner',
          invite_token = CASE
            WHEN workspace_members.accepted_at IS NOT NULL THEN workspace_members.invite_token
            ELSE COALESCE(workspace_members.invite_token, EXCLUDED.invite_token)
          END
    RETURNING *
  `;
  return rows[0];
}

export async function acceptInvite(token: string): Promise<WorkspaceMember | null> {
  const rows = await sql<WorkspaceMember[]>`
    UPDATE workspace_members SET accepted_at = NOW(), invite_token = NULL
    WHERE invite_token = ${token}
    RETURNING *
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

async function finishStripeCheckoutFulfillment(checkoutSessionId: string, claimToken: string, status: "complete" | "failed", error?: unknown): Promise<void> {
  const lastError = status === "failed" ? String((error as any)?.message || error || "fulfillment failed").slice(0, 500) : null;
  await sql`
    UPDATE stripe_checkout_fulfillments
    SET status = ${status},
        last_error = ${lastError},
        updated_at = NOW()
    WHERE checkout_session_id = ${checkoutSessionId}
      AND claim_token = ${claimToken}
  `;
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
  stripeEventId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await createActivationEventIfChanged({
    workspace_id: input.workspace?.id ?? null,
    event_type: input.eventType,
    status: input.status,
    actor: "system",
    detail: {
      source: input.source,
      stripe_event_id: input.stripeEventId || null,
      workspace_matched: Boolean(input.workspace?.id),
      ...(input.detail || {}),
    },
  });

  await sendProvisioningAlert({
    event: input.alertEvent,
    businessName: input.workspace?.business_name || input.workspace?.name || "Unknown Stripe buyer",
    ownerEmail: input.workspace?.owner_email || "unknown",
    ownerPhone: input.workspace?.owner_phone || null,
    plan: input.workspace?.plan || "unknown",
    source: input.source,
    status: input.status,
    workspaceId: input.workspace?.id ?? null,
    error: input.detail?.reason ? String(input.detail.reason) : null,
  });
}

async function handleCheckoutCompleted(event: any): Promise<string | null> {
  const classification = classifySmirkCheckoutForFulfillment(event, {
    starter: String(process.env.STRIPE_PAYMENT_LINK_STARTER_ID || "").trim(),
    pro: String(process.env.STRIPE_PAYMENT_LINK_PRO_ID || "").trim(),
    enterprise: String(process.env.STRIPE_PAYMENT_LINK_ENTERPRISE_ID || "").trim(),
  });
  const { session, plan } = classification;
  const metadata = session.metadata || {};
  if (!classification.approved) return null;

  const checkoutSessionId = classification.checkoutSessionId;
  if (!checkoutSessionId) return null;
  const eventId = cleanStripeId(event.id);
  const claimToken = await claimStripeCheckoutFulfillment(checkoutSessionId, eventId);
  if (!claimToken) return null;

  try {
  const ownerEmail = String(metadata.owner_email || session.customer_details?.email || session.customer_email || "").trim().toLowerCase();
  const businessName = String(metadata.business_name || session.customer_details?.name || ownerEmail || "Paid SMIRK Workspace").trim();
  const ownerPhone = String(metadata.owner_phone || session.customer_details?.phone || "").trim();
  const verifiedPlan = plan!;
  const mode = "missed_call_recovery" as const;
  // The Checkout Session is stable across event retries and async-payment events;
  // the Stripe Event ID is not. Use the Session as the durable fulfillment key.
  const requestId = checkoutSessionId;
  const stripeCustomerId = String(session.customer || "").trim() || null;
  const stripeSubscriptionId = String(session.subscription || "").trim() || null;

  if (!ownerEmail) {
    const missingEmailRows = await sql<{ id: number }[]>`
      INSERT INTO provisioning_requests (
        request_id, business_name, owner_email, requested_plan, requested_mode, status, source, error
      ) VALUES (
        ${requestId}, ${businessName}, ${"unknown"}, ${verifiedPlan}, ${mode}, 'manual_fallback_required', 'stripe_checkout_completed', 'Paid checkout completed without an owner email.'
      )
      ON CONFLICT (request_id) WHERE source = 'stripe_checkout_completed' AND request_id IS NOT NULL
      DO UPDATE SET
        status = 'manual_fallback_required',
        error = EXCLUDED.error,
        updated_at = NOW()
      RETURNING id
    `;
    await createActivationEvent({
      provisioning_request_id: missingEmailRows[0]?.id || null,
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
    await sendProvisioningAlert({
      event: "stripe_missing_owner_email",
      businessName,
      ownerEmail: "unknown",
      ownerPhone,
      plan: verifiedPlan,
      mode,
      source: "stripe_checkout_completed",
      status: "manual_fallback_required",
      error: "Paid checkout completed without an owner email.",
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
    if (checkoutEventCreated && eventId) await sql`
      UPDATE workspaces
      SET stripe_billing_event_created = ${checkoutEventCreated},
          stripe_billing_event_id = ${eventId},
          updated_at = NOW()
      WHERE id = ${existingWorkspace[0].id}
        AND (
          stripe_billing_event_created IS NULL
          OR stripe_billing_event_created < ${checkoutEventCreated}
        )
    `;
    await updateWorkspace(existingWorkspace[0].id, {
      plan: verifiedPlan,
      stripe_customer_id: stripeCustomerId || undefined,
      stripe_subscription_id: stripeSubscriptionId || undefined,
      business_name: businessName,
      owner_phone: ownerPhone || undefined,
      notification_email: ownerEmail,
    });
    const invite = await ensureCheckoutOwnerInvite(existingWorkspace[0].id, ownerEmail);
    const appBase = String(process.env.APP_URL || "").replace(/\/$/, "") || "https://ai-phone-agent-production-6811.up.railway.app";
    const inviteLink = invite.invite_token ? `${appBase}/invite/${invite.invite_token}` : (existingRequest?.invite_link || `${appBase}/dashboard`);
    const existingRequestRows = existingRequest
      ? await sql<{ id: number }[]>`
          UPDATE provisioning_requests
          SET workspace_id = ${existingWorkspace[0].id},
              business_name = ${businessName},
              owner_email = ${ownerEmail},
              requested_plan = ${verifiedPlan},
              requested_mode = ${mode},
              status = 'workspace_created',
              invite_link = ${inviteLink},
              error = NULL,
              updated_at = NOW()
          WHERE id = ${existingRequest.id}
          RETURNING id
        `
      : await sql<{ id: number }[]>`
          INSERT INTO provisioning_requests (
            request_id, workspace_id, business_name, owner_email, requested_plan, requested_mode, status, invite_link, source
          ) VALUES (
            ${requestId}, ${existingWorkspace[0].id}, ${businessName}, ${ownerEmail}, ${verifiedPlan}, ${mode}, 'workspace_created', ${inviteLink}, 'stripe_checkout_completed'
          )
          RETURNING id
        `;
    await createActivationEventIfChanged({
      workspace_id: existingWorkspace[0].id,
      provisioning_request_id: existingRequestRows[0]?.id || null,
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
    await createActivationEventIfChanged({
      workspace_id: existingWorkspace[0].id,
      provisioning_request_id: existingRequestRows[0]?.id || null,
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
    if (existingRequest?.status !== "workspace_created") await sendProvisioningAlert({
      event: "stripe_existing_workspace_updated",
      businessName,
      ownerEmail,
      ownerPhone,
      plan: verifiedPlan,
      mode,
      source: "stripe_checkout_completed",
      status: "workspace_created",
      workspaceId: existingWorkspace[0].id,
      inviteLink,
    });
    return claimToken;
  }

  const autoFulfill = String(process.env.AUTO_FULFILL_PROVISIONING_REQUESTS || "false").trim().toLowerCase() === "true";
  const auditRows = existingRequest
    ? await sql<{ id: number }[]>`
        UPDATE provisioning_requests
        SET business_name = ${businessName},
            owner_email = ${ownerEmail},
            requested_plan = ${verifiedPlan},
            requested_mode = ${mode},
            status = ${autoFulfill ? 'pending_auto_fulfillment' : 'manual_fallback_required'},
            error = NULL,
            updated_at = NOW()
        WHERE id = ${existingRequest.id}
        RETURNING id
      `
    : await sql<{ id: number }[]>`
        INSERT INTO provisioning_requests (
          request_id, business_name, owner_email, requested_plan, requested_mode, status, source
        ) VALUES (
          ${requestId}, ${businessName}, ${ownerEmail}, ${verifiedPlan}, ${mode}, ${autoFulfill ? 'pending_auto_fulfillment' : 'manual_fallback_required'}, 'stripe_checkout_completed'
        )
        RETURNING id
      `;
  const provisioningRequestId = auditRows[0]?.id || null;

  if (!autoFulfill) {
    await createActivationEvent({
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
    await createActivationEvent({
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
    await sendProvisioningAlert({
      event: "stripe_manual_fallback",
      businessName,
      ownerEmail,
      ownerPhone,
      plan: verifiedPlan,
      mode,
      source: "stripe_checkout_completed",
      status: "manual_fallback_required",
      provisioningRequestId,
    });
    return claimToken;
  }

  let provisionedWorkspace: Workspace | null = null;
  try {
    const workspace = await createWorkspace({
      name: businessName,
      owner_email: ownerEmail,
      plan: verifiedPlan,
      mode,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      stripe_billing_event_created: stripeBillingEventCreatedSeconds(event?.created),
      stripe_billing_event_id: eventId,
      subscription_status: "active",
      business_name: businessName,
      owner_phone: ownerPhone || null,
      notification_email: ownerEmail,
    });
    provisionedWorkspace = workspace;
    const ownerInvite = await ensureCheckoutOwnerInvite(workspace.id, ownerEmail);
    const inviteLink = `${String(process.env.APP_URL || "").replace(/\/$/, "") || "https://ai-phone-agent-production-6811.up.railway.app"}/invite/${ownerInvite.invite_token}`;
    if (provisioningRequestId) {
      await sql`
        UPDATE provisioning_requests
        SET workspace_id = ${workspace.id},
            invite_link = ${inviteLink},
            workspace_api_key = ${workspace.api_key},
            status = 'workspace_created',
            updated_at = NOW()
        WHERE id = ${provisioningRequestId}
      `;
    }
    await createActivationEvent({
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
    await createActivationEvent({
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
    await sendProvisioningAlert({
      event: "stripe_workspace_created",
      businessName,
      ownerEmail,
      ownerPhone,
      plan: verifiedPlan,
      mode,
      source: "stripe_checkout_completed",
      status: "workspace_created",
      provisioningRequestId,
      workspaceId: workspace.id,
      inviteLink,
    });
  } catch (err: any) {
    const errorMessage = err?.message || 'Paid checkout provisioning failed';
    if (provisioningRequestId) {
      await sql`
        UPDATE provisioning_requests
        SET status = 'manual_fallback_required',
            error = ${errorMessage},
            updated_at = NOW()
        WHERE id = ${provisioningRequestId}
      `;
    }
    await createActivationEvent({
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
    await sendProvisioningAlert({
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
    });
  }
  if (provisionedWorkspace) {
    // This is security-critical: a refund, dispute, cancellation, or payment
    // failure may have arrived before Checkout. Let reconciliation failures
    // escape so the fenced claim becomes failed and Stripe can retry.
    await reconcileStripePaymentFactsForWorkspace(provisionedWorkspace);
    await reconcileStripeSubscriptionStateForWorkspace(provisionedWorkspace);
  }
  return claimToken;
  } catch (error) {
    await finishStripeCheckoutFulfillment(checkoutSessionId, claimToken, "failed", error);
    throw error;
  }
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
    if (claimToken && checkoutSessionId) await finishStripeCheckoutFulfillment(checkoutSessionId, claimToken, "complete");
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
      if (!matchedWorkspace || (appliedWorkspace && incomingWasCurrent)) await recordStripeBillingLifecycle({
        workspace: appliedWorkspace,
        eventType: "billing_subscription_canceled",
        alertEvent: "stripe_subscription_canceled",
        status: "info",
        source: "customer.subscription.deleted",
        stripeEventId: event.id,
        detail: {
          customer_id: customerId,
          subscription_id: subscriptionId,
          exact_subscription_binding: Boolean(appliedWorkspace),
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
      if (!matchedWorkspace || (appliedWorkspace && incomingWasCurrent)) await recordStripeBillingLifecycle({
        workspace: appliedWorkspace,
        eventType: "billing_payment_failed",
        alertEvent: "stripe_payment_failed",
        status: "blocked",
        source: "invoice.payment_failed",
        stripeEventId: event.id,
        detail: {
          customer_id: customerId,
          subscription_id: subscriptionId,
          invoice_id: cleanStripeId(obj.id),
          exact_subscription_binding: Boolean(appliedWorkspace),
          amount_due: obj.amount_due ?? null,
          currency: obj.currency || null,
          hosted_invoice_url: obj.hosted_invoice_url || null,
          reason: "Stripe invoice payment failed. Billing follow-up is required before scaling paid launch.",
        },
      });
    }
  }

  if (type === "charge.refunded" && liveBillingObject) {
    const customerId = cleanStripeId(obj.customer);
    const paymentIntentId = cleanStripeId(obj.payment_intent);
    const fullyRefunded = Number(obj.amount || 0) > 0 && Number(obj.amount_refunded || 0) >= Number(obj.amount || 0);
    if (paymentIntentId) await sql`
      INSERT INTO stripe_payment_adverse_events (
        payment_intent_id, customer_id, charge_id, fully_refunded, disputed, stripe_event_id
      ) VALUES (
        ${paymentIntentId}, ${customerId}, ${cleanStripeId(obj.id)}, ${fullyRefunded}, FALSE, ${cleanStripeId(event.id)}
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
      stripeEventId: event.id,
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

  if (type === "charge.dispute.created" && liveBillingObject) {
    const paymentIntentId = cleanStripeId(obj.payment_intent);
    const chargeId = cleanStripeId(obj.charge);
    if (paymentIntentId) await sql`
      INSERT INTO stripe_payment_adverse_events (
        payment_intent_id, charge_id, fully_refunded, disputed, stripe_event_id
      ) VALUES (
        ${paymentIntentId}, ${chargeId}, FALSE, TRUE, ${cleanStripeId(event.id)}
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
      stripeEventId: event.id,
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
