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

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Workspace {
  id: number;
  slug: string;           // URL-safe identifier, e.g. "acme-plumbing"
  name: string;           // Display name, e.g. "Acme Plumbing"
  owner_email: string;
  plan: "free" | "starter" | "pro" | "enterprise";
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  subscription_status: "active" | "trialing" | "past_due" | "canceled" | "none";
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
}): Promise<Workspace> {
  const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50)
    + "-" + Math.random().toString(36).slice(2, 6);
  const apiKey = generateApiKey();
  const plan = data.plan || "free";
  const limits = PLAN_LIMITS[plan];
  const trialEndsAt = plan === "free" ? new Date(Date.now() + 14 * 86400_000).toISOString() : null;
  const mode = data.mode || "general";

  const rows = await sql<Workspace[]>`
    INSERT INTO workspaces (slug, name, owner_email, plan, subscription_status, monthly_call_limit, monthly_minute_limit, api_key, trial_ends_at, mode)
    VALUES (${slug}, ${data.name}, ${data.owner_email}, ${plan}, ${plan === "free" ? "trialing" : "active"}, ${limits.calls}, ${limits.minutes}, ${apiKey}, ${trialEndsAt}, ${mode})
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
}): Promise<{ workspace: Workspace; ownerInvite: WorkspaceMember }> {
  const workspace = await createWorkspace({
    name: data.name,
    owner_email: data.owner_email,
    plan: data.plan || "starter",
    mode: data.mode || "missed_call_recovery",
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

  if (ws.subscription_status === "canceled") {
    return { allowed: false, reason: "Subscription canceled", subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }

  if (ws.plan === "free" && ws.trial_ends_at && new Date(ws.trial_ends_at) < new Date()) {
    return { allowed: false, reason: "Free trial expired", subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }

  if (ws.monthly_call_limit !== -1 && ws.calls_this_month >= ws.monthly_call_limit) {
    return { allowed: false, reason: `Monthly call limit reached (${ws.monthly_call_limit} calls)`, subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }

  const billingWarning = ws.subscription_status === "past_due"
    ? "Subscription is past_due. Calls stay live for concierge recovery, but operator billing follow-up is required."
    : undefined;
  return { allowed: true, billingWarning, subscriptionStatus: ws.subscription_status, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
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

async function findWorkspaceByStripeIds(ids: {
  customerId?: string | null;
  subscriptionId?: string | null;
}): Promise<Workspace | null> {
  const customerId = cleanStripeId(ids.customerId);
  const subscriptionId = cleanStripeId(ids.subscriptionId);
  if (customerId && subscriptionId) {
    const rows = await sql<Workspace[]>`
      SELECT *
      FROM workspaces
      WHERE stripe_customer_id = ${customerId}
         OR stripe_subscription_id = ${subscriptionId}
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    return rows[0] || null;
  }
  if (customerId) {
    const rows = await sql<Workspace[]>`
      SELECT *
      FROM workspaces
      WHERE stripe_customer_id = ${customerId}
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    return rows[0] || null;
  }
  if (subscriptionId) {
    const rows = await sql<Workspace[]>`
      SELECT *
      FROM workspaces
      WHERE stripe_subscription_id = ${subscriptionId}
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    return rows[0] || null;
  }
  return null;
}

async function recordStripeBillingLifecycle(input: {
  workspace: Workspace | null;
  eventType: "billing_payment_failed" | "billing_subscription_canceled" | "billing_refund_recorded";
  alertEvent: "stripe_payment_failed" | "stripe_subscription_canceled" | "stripe_refund_recorded";
  status: "blocked" | "complete" | "info";
  source: string;
  stripeEventId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await createActivationEvent({
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

async function handleCheckoutCompleted(event: any): Promise<void> {
  const session = event.data?.object || {};
  const metadata = session.metadata || {};
  const ownerEmail = String(metadata.owner_email || session.customer_details?.email || session.customer_email || "").trim().toLowerCase();
  const businessName = String(metadata.business_name || session.customer_details?.name || ownerEmail || "Paid SMIRK Workspace").trim();
  const ownerPhone = String(metadata.owner_phone || session.customer_details?.phone || "").trim();
  const plan = normalizePlan(metadata.plan);
  const mode = "missed_call_recovery" as const;
  const requestId = String(event.id || session.id || "").trim() || null;
  const stripeCustomerId = String(session.customer || "").trim() || null;
  const stripeSubscriptionId = String(session.subscription || "").trim() || null;

  if (!ownerEmail) {
    const missingEmailRows = await sql<{ id: number }[]>`
      INSERT INTO provisioning_requests (
        request_id, business_name, owner_email, requested_plan, requested_mode, status, source, error
      ) VALUES (
        ${requestId}, ${businessName}, ${"unknown"}, ${plan}, ${mode}, 'manual_fallback_required', 'stripe_checkout_completed', 'Paid checkout completed without an owner email.'
      )
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
        requested_plan: plan,
      },
    });
    await sendProvisioningAlert({
      event: "stripe_missing_owner_email",
      businessName,
      ownerEmail: "unknown",
      ownerPhone,
      plan,
      mode,
      source: "stripe_checkout_completed",
      status: "manual_fallback_required",
      error: "Paid checkout completed without an owner email.",
    });
    return;
  }

  if (requestId) {
    const existingByRequest = await sql<{ id: number; workspace_id: number | null }[]>`
      SELECT id, workspace_id
      FROM provisioning_requests
      WHERE request_id = ${requestId}
      LIMIT 1
    `;
    if (existingByRequest.length > 0) return;
  }

  const existingWorkspace = await sql<{ id: number }[]>`
    SELECT id
    FROM workspaces
    WHERE lower(owner_email) = ${ownerEmail}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (existingWorkspace[0]?.id) {
    await updateWorkspace(existingWorkspace[0].id, {
      plan,
      stripe_customer_id: stripeCustomerId || undefined,
      stripe_subscription_id: stripeSubscriptionId || undefined,
      subscription_status: "active",
      business_name: businessName,
      owner_phone: ownerPhone || undefined,
      notification_email: ownerEmail,
    });
    const invite = await inviteMember(existingWorkspace[0].id, ownerEmail, "owner");
    const inviteLink = `${String(process.env.APP_URL || "").replace(/\/$/, "") || "https://ai-phone-agent-production-6811.up.railway.app"}/invite/${invite.invite_token}`;
    const existingRequestRows = await sql<{ id: number }[]>`
      INSERT INTO provisioning_requests (
        request_id, workspace_id, business_name, owner_email, requested_plan, requested_mode, status, invite_link, source
      ) VALUES (
        ${requestId}, ${existingWorkspace[0].id}, ${businessName}, ${ownerEmail}, ${plan}, ${mode}, 'workspace_created', ${inviteLink}, 'stripe_checkout_completed'
      )
      RETURNING id
    `;
    await createActivationEvent({
      workspace_id: existingWorkspace[0].id,
      provisioning_request_id: existingRequestRows[0]?.id || null,
      event_type: "checkout_completed",
      status: "complete",
      actor: "system",
      detail: {
        activation_stage: "workspace_created",
        source: "stripe_checkout_completed",
        requested_plan: plan,
        existing_workspace: true,
      },
    });
    await createActivationEvent({
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
    await sendProvisioningAlert({
      event: "stripe_existing_workspace_updated",
      businessName,
      ownerEmail,
      ownerPhone,
      plan,
      mode,
      source: "stripe_checkout_completed",
      status: "workspace_created",
      workspaceId: existingWorkspace[0].id,
      inviteLink,
    });
    return;
  }

  const autoFulfill = String(process.env.AUTO_FULFILL_PROVISIONING_REQUESTS || "false").trim().toLowerCase() === "true";
  const auditRows = await sql<{ id: number }[]>`
    INSERT INTO provisioning_requests (
      request_id, business_name, owner_email, requested_plan, requested_mode, status, source
    ) VALUES (
      ${requestId}, ${businessName}, ${ownerEmail}, ${plan}, ${mode}, ${autoFulfill ? 'pending_auto_fulfillment' : 'manual_fallback_required'}, 'stripe_checkout_completed'
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
        requested_plan: plan,
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
        requested_plan: plan,
      },
    });
    await sendProvisioningAlert({
      event: "stripe_manual_fallback",
      businessName,
      ownerEmail,
      ownerPhone,
      plan,
      mode,
      source: "stripe_checkout_completed",
      status: "manual_fallback_required",
      provisioningRequestId,
    });
    return;
  }

  try {
    const { workspace, ownerInvite } = await provisionWorkspace({
      name: businessName,
      owner_email: ownerEmail,
      plan,
      mode,
    });
    await updateWorkspace(workspace.id, {
      stripe_customer_id: stripeCustomerId || undefined,
      stripe_subscription_id: stripeSubscriptionId || undefined,
      subscription_status: "active",
      business_name: businessName,
      owner_phone: ownerPhone || undefined,
      notification_email: ownerEmail,
    });
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
        requested_plan: plan,
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
      plan,
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
        requested_plan: plan,
        error: errorMessage,
      },
    });
    await sendProvisioningAlert({
      event: "stripe_manual_fallback",
      businessName,
      ownerEmail,
      ownerPhone,
      plan,
      mode,
      source: "stripe_checkout_completed",
      status: "manual_fallback_required",
      provisioningRequestId,
      error: errorMessage,
    });
  }
}

export async function handleStripeWebhook(event: any): Promise<void> {
  const type = event.type as string;
  const obj = event.data?.object;

  if (type === "checkout.session.completed") {
    await handleCheckoutCompleted(event);
  }

  if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
    const customerId = obj.customer;
    const status = obj.status; // active, trialing, past_due, canceled
    const planSource = obj.metadata?.plan || obj.items?.data?.[0]?.price?.nickname || obj.items?.data?.[0]?.price?.lookup_key || obj.items?.data?.[0]?.price?.product?.name;
    const plan = normalizePlan(planSource);
    const limits = PLAN_LIMITS[plan];

    await sql`
      UPDATE workspaces SET
        stripe_subscription_id = ${obj.id},
        subscription_status = ${status},
        plan = ${plan},
        monthly_call_limit = ${limits.calls},
        monthly_minute_limit = ${limits.minutes},
        updated_at = NOW()
      WHERE stripe_customer_id = ${customerId}
    `;
  }

  if (type === "customer.subscription.deleted") {
    const customerId = cleanStripeId(obj.customer);
    const subscriptionId = cleanStripeId(obj.id);
    await sql`
      UPDATE workspaces SET subscription_status = 'canceled', updated_at = NOW()
      WHERE stripe_customer_id = ${customerId}
    `;
    const workspace = await findWorkspaceByStripeIds({ customerId, subscriptionId });
    await recordStripeBillingLifecycle({
      workspace,
      eventType: "billing_subscription_canceled",
      alertEvent: "stripe_subscription_canceled",
      status: "info",
      source: "customer.subscription.deleted",
      stripeEventId: event.id,
      detail: {
        customer_id: customerId,
        subscription_id: subscriptionId,
        reason: "Stripe subscription was canceled or deleted.",
      },
    });
  }

  if (type === "invoice.payment_failed") {
    const customerId = cleanStripeId(obj.customer);
    const subscriptionId = cleanStripeId(obj.subscription);
    await sql`
      UPDATE workspaces SET subscription_status = 'past_due', updated_at = NOW()
      WHERE stripe_customer_id = ${customerId}
    `;
    const workspace = await findWorkspaceByStripeIds({ customerId, subscriptionId });
    await recordStripeBillingLifecycle({
      workspace,
      eventType: "billing_payment_failed",
      alertEvent: "stripe_payment_failed",
      status: "blocked",
      source: "invoice.payment_failed",
      stripeEventId: event.id,
      detail: {
        customer_id: customerId,
        subscription_id: subscriptionId,
        invoice_id: cleanStripeId(obj.id),
        amount_due: obj.amount_due ?? null,
        currency: obj.currency || null,
        hosted_invoice_url: obj.hosted_invoice_url || null,
        reason: "Stripe invoice payment failed. Billing follow-up is required before scaling paid launch.",
      },
    });
  }

  if (type === "charge.refunded") {
    const customerId = cleanStripeId(obj.customer);
    const workspace = await findWorkspaceByStripeIds({ customerId });
    await recordStripeBillingLifecycle({
      workspace,
      eventType: "billing_refund_recorded",
      alertEvent: "stripe_refund_recorded",
      status: "info",
      source: "charge.refunded",
      stripeEventId: event.id,
      detail: {
        customer_id: customerId,
        charge_id: cleanStripeId(obj.id),
        amount_refunded: obj.amount_refunded ?? null,
        amount: obj.amount ?? null,
        currency: obj.currency || null,
        receipt_url: obj.receipt_url || null,
        reason: "Stripe charge refund was recorded. Confirm cancellation/access state manually if needed.",
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
