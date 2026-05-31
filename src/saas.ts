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

import { sql } from "./db.js";

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
  business_hours?: string;
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
  await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS business_hours TEXT`;
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
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let key = "smirk_";
  for (let i = 0; i < 32; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

function generateInviteToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 48; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
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
    "business_address", "business_hours", "agent_name", "agent_persona",
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
  callsUsed: number;
  callsLimit: number;
  minutesUsed: number;
  minutesLimit: number;
}> {
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return { allowed: false, reason: "Workspace not found", callsUsed: 0, callsLimit: 0, minutesUsed: 0, minutesLimit: 0 };

  if (ws.subscription_status === "canceled") {
    return { allowed: false, reason: "Subscription canceled", callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }

  if (ws.plan === "free" && ws.trial_ends_at && new Date(ws.trial_ends_at) < new Date()) {
    return { allowed: false, reason: "Free trial expired", callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }

  if (ws.monthly_call_limit !== -1 && ws.calls_this_month >= ws.monthly_call_limit) {
    return { allowed: false, reason: `Monthly call limit reached (${ws.monthly_call_limit} calls)`, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
  }

  return { allowed: true, callsUsed: ws.calls_this_month, callsLimit: ws.monthly_call_limit, minutesUsed: ws.minutes_this_month, minutesLimit: ws.monthly_minute_limit };
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
  return (["free", "starter", "pro", "enterprise"].includes(value) ? value : "starter") as Workspace["plan"];
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
    await sql`
      INSERT INTO provisioning_requests (
        request_id, business_name, owner_email, requested_plan, requested_mode, status, source, error
      ) VALUES (
        ${requestId}, ${businessName}, ${"unknown"}, ${plan}, ${mode}, 'manual_fallback_required', 'stripe_checkout_completed', 'Paid checkout completed without an owner email.'
      )
    `;
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
    await sql`
      INSERT INTO provisioning_requests (
        request_id, workspace_id, business_name, owner_email, requested_plan, requested_mode, status, invite_link, source
      ) VALUES (
        ${requestId}, ${existingWorkspace[0].id}, ${businessName}, ${ownerEmail}, ${plan}, ${mode}, 'workspace_created', ${inviteLink}, 'stripe_checkout_completed'
      )
    `;
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

  if (!autoFulfill) return;

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
  } catch (err: any) {
    if (provisioningRequestId) {
      await sql`
        UPDATE provisioning_requests
        SET status = 'manual_fallback_required',
            error = ${err?.message || 'Paid checkout provisioning failed'},
            updated_at = NOW()
        WHERE id = ${provisioningRequestId}
      `;
    }
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
    const planNickname = obj.items?.data?.[0]?.price?.nickname?.toLowerCase() || "starter";
    const plan = (["free", "starter", "pro", "enterprise"].includes(planNickname) ? planNickname : "starter") as Workspace["plan"];
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
    const customerId = obj.customer;
    await sql`
      UPDATE workspaces SET subscription_status = 'canceled', updated_at = NOW()
      WHERE stripe_customer_id = ${customerId}
    `;
  }

  if (type === "invoice.payment_failed") {
    const customerId = obj.customer;
    await sql`
      UPDATE workspaces SET subscription_status = 'past_due', updated_at = NOW()
      WHERE stripe_customer_id = ${customerId}
    `;
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
      SELECT c.call_sid, c.from_number, c.started_at, c.duration, c.status,
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
