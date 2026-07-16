import type { Express, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";

type LaunchRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
};

const launchEventRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  message: { ok: false, error: "Too many launch tracking events. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

const allowedEvents = new Set([
  "landing_page_view",
  "launch_page_view",
  "pricing_page_view",
  "cta_clicked",
  "checkout_started",
]);

const allowedNextStates = new Set([
  "new",
  "researched",
  "contacted",
  "replied",
  "qualified",
  "proof_requested",
  "checkout_started",
  "paid",
  "activated",
  "lost",
  "do_not_contact",
]);

const allowedProofStatuses = new Set(["not_requested", "requested", "scheduled", "booked", "completed", "missed", "cancelled"]);
const allowedCheckoutStatuses = new Set(["not_started", "started", "abandoned", "paid", "failed", "refunded"]);
const allowedActivationStatuses = new Set(["not_started", "queued", "manual_follow_up", "activated", "blocked", "cancelled"]);

const cleanText = (value: unknown, max = 240): string | null => {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, max);
};

const cleanEventName = (value: unknown): string | null => {
  const eventName = cleanText(value, 80);
  if (!eventName || !allowedEvents.has(eventName)) return null;
  return eventName;
};

const cleanEnum = (value: unknown, allowed: Set<string>, fallback: string): string => {
  const text = cleanText(value, 80)?.toLowerCase().replace(/\s+/g, "_");
  return text && allowed.has(text) ? text : fallback;
};

const cleanInt = (value: unknown, fallback = 0, max = 1_000_000): number => {
  const num = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), 0), max);
};

const cleanMetadata = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input).slice(0, 25)) {
    const safeKey = key.replace(/[^a-zA-Z0-9_:-]/g, "").slice(0, 64);
    if (!safeKey) continue;
    if (typeof raw === "string") output[safeKey] = raw.slice(0, 240);
    else if (typeof raw === "number" || typeof raw === "boolean" || raw === null) output[safeKey] = raw;
  }
  return output;
};

const buildLedgerInput = (body: Record<string, unknown>) => ({
  source: cleanText(body.source, 120) || "manual_research",
  company: cleanText(body.company, 180),
  vertical: cleanText(body.vertical, 120),
  region: cleanText(body.region, 120),
  owner_contact: cleanText(body.owner_contact, 180),
  channel: cleanText(body.channel, 120),
  message_variant: cleanText(body.message_variant, 120),
  response: cleanText(body.response, 240),
  objection: cleanText(body.objection, 240),
  proof_walkthrough_status: cleanEnum(body.proof_walkthrough_status, allowedProofStatuses, "not_requested"),
  checkout_status: cleanEnum(body.checkout_status, allowedCheckoutStatuses, "not_started"),
  activation_status: cleanEnum(body.activation_status, allowedActivationStatuses, "not_started"),
  next_state: cleanEnum(body.next_state, allowedNextStates, "new"),
  touch_count: cleanInt(body.touch_count, 0, 10_000),
  spend_cents: cleanInt(body.spend_cents, 0, 500_000),
  notes: cleanText(body.notes, 2000),
});

const loadLaunchLedgerMetrics = async (sql: any, since: string) => {
  const [metrics] = await sql`
    SELECT
      COUNT(*)::INT AS companies,
      COALESCE(SUM(touch_count), 0)::INT AS touches,
      COALESCE(SUM(spend_cents), 0)::INT AS spend_cents,
      COUNT(*) FILTER (
        WHERE next_state IN ('qualified', 'proof_requested', 'checkout_started', 'paid', 'activated')
          OR response ILIKE '%qualified%'
      )::INT AS qualified_conversations,
      COUNT(*) FILTER (
        WHERE proof_walkthrough_status IN ('scheduled', 'booked', 'completed')
      )::INT AS proof_walkthroughs,
      COUNT(*) FILTER (
        WHERE checkout_status IN ('started', 'paid')
          OR next_state IN ('checkout_started', 'paid', 'activated')
      )::INT AS checkout_starts,
      COUNT(*) FILTER (
        WHERE (checkout_status = 'paid' AND activation_status = 'activated')
          OR next_state = 'activated'
      )::INT AS paid_activations
    FROM launch_ledger
    WHERE created_at >= ${since}
  `;
  const values = metrics || {};
  const qualifiedConversations = Number(values.qualified_conversations || 0);
  const proofWalkthroughs = Number(values.proof_walkthroughs || 0);
  const paidActivations = Number(values.paid_activations || 0);
  const touches = Number(values.touches || 0);
  const spendCents = Number(values.spend_cents || 0);
  return {
    companies: Number(values.companies || 0),
    touches,
    spend_cents: spendCents,
    qualified_conversations: qualifiedConversations,
    proof_walkthroughs: proofWalkthroughs,
    checkout_starts: Number(values.checkout_starts || 0),
    paid_activations: paidActivations,
    hard_stops: {
      revenue: paidActivations >= 1,
      interaction: qualifiedConversations >= 10 || proofWalkthroughs >= 3,
      negative_signal: touches >= 500 && spendCents >= 50_000 && qualifiedConversations === 0,
    },
  };
};

export function registerLaunchRoutes(app: Express, deps: LaunchRouteDeps): void {
  const { dashboardAuth, requireOperator, sql, dbEnabled, log } = deps;

  app.post("/api/launch/events", launchEventRateLimit, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const eventName = cleanEventName((req.body as any)?.event_name);
    if (!eventName) return res.status(400).json({ ok: false, error: "Unknown launch event" });

    const body = req.body as Record<string, unknown>;
    const metadata = cleanMetadata(body.metadata);
    if (cleanText(body.source)) metadata.source = cleanText(body.source);
    if (cleanText(body.medium)) metadata.medium = cleanText(body.medium);
    if (cleanText(body.campaign)) metadata.campaign = cleanText(body.campaign);

    if (!dbEnabled) {
      log("warn", "Launch event accepted without DB persistence", { eventName });
      return res.status(202).json({ ok: true, stored: false });
    }

    try {
      await sql`
        INSERT INTO launch_events (
          event_name,
          page_path,
          source,
          medium,
          campaign,
          content,
          term,
          referrer,
          plan,
          cta,
          channel,
          metadata,
          user_agent
        ) VALUES (
          ${eventName},
          ${cleanText(body.page_path, 180)},
          ${cleanText(body.source, 120)},
          ${cleanText(body.medium, 120)},
          ${cleanText(body.campaign, 180)},
          ${cleanText(body.content, 180)},
          ${cleanText(body.term, 180)},
          ${cleanText(body.referrer, 300)},
          ${cleanText(body.plan, 80)},
          ${cleanText(body.cta, 120)},
          ${cleanText(body.channel, 120)},
          ${JSON.stringify(metadata)},
          ${cleanText(req.headers["user-agent"], 300)}
        )
      `;
      return res.status(202).json({ ok: true, stored: true });
    } catch (err: any) {
      log("error", "Launch event tracking failed", { error: err?.message, eventName });
      return res.status(202).json({ ok: true, stored: false });
    }
  });

  app.get("/api/launch/summary", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });

    const daysRaw = Number.parseInt(String(req.query.days || "30"), 10);
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    try {
      const [byEvent, bySource, recent, traction] = await Promise.all([
        sql`
          SELECT event_name, COUNT(*)::INT AS count
          FROM launch_events
          WHERE occurred_at >= ${since}
          GROUP BY event_name
          ORDER BY count DESC, event_name ASC
        `,
        sql`
          SELECT COALESCE(source, 'direct') AS source, event_name, COUNT(*)::INT AS count
          FROM launch_events
          WHERE occurred_at >= ${since}
          GROUP BY COALESCE(source, 'direct'), event_name
          ORDER BY source ASC, event_name ASC
        `,
        sql`
          SELECT occurred_at, event_name, page_path, source, medium, campaign, plan, cta, channel
          FROM launch_events
          WHERE occurred_at >= ${since}
          ORDER BY occurred_at DESC
          LIMIT 50
        `,
        loadLaunchLedgerMetrics(sql, since),
      ]);

      const checkoutStarted = byEvent.find((row: any) => row.event_name === "checkout_started")?.count || 0;
      const landingViews = byEvent.find((row: any) => row.event_name === "landing_page_view")?.count || 0;
      const launchViews = byEvent.find((row: any) => row.event_name === "launch_page_view")?.count || 0;
      const pricingViews = byEvent.find((row: any) => row.event_name === "pricing_page_view")?.count || 0;

      return res.json({
        ok: true,
        window_days: days,
        spend_gate: {
          landing_page_analytics_working: landingViews + launchViews + pricingViews > 0,
          checkout_events_trackable: checkoutStarted > 0,
          paid_spend_cap_cents: 50_000,
          paid_spend_allowed: false,
          note: "Paid spend still needs human approval plus self-serve activation proof.",
        },
        traction,
        by_event: byEvent,
        by_source: bySource,
        recent_events: recent,
      });
    } catch (err: any) {
      log("error", "Launch summary failed", { error: err?.message });
      return res.status(500).json({ ok: false, error: "Launch summary failed" });
    }
  });

  app.get("/api/launch/ledger", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });

    const limitRaw = Number.parseInt(String(req.query.limit || "200"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200;
    const daysRaw = Number.parseInt(String(req.query.days || "30"), 10);
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    try {
      const [rows, traction] = await Promise.all([
        sql`
          SELECT *
          FROM launch_ledger
          WHERE created_at >= ${since}
          ORDER BY updated_at DESC, created_at DESC
          LIMIT ${limit}
        `,
        loadLaunchLedgerMetrics(sql, since),
      ]);
      return res.json({ ok: true, window_days: days, rows, traction });
    } catch (err: any) {
      log("error", "Launch ledger list failed", { error: err?.message });
      return res.status(500).json({ ok: false, error: "Launch ledger list failed" });
    }
  });

  app.post("/api/launch/ledger", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });

    const input = buildLedgerInput(req.body as Record<string, unknown>);
    if (!input.company) return res.status(400).json({ ok: false, error: "Company is required" });

    try {
      const [row] = await sql`
        INSERT INTO launch_ledger (
          source, company, vertical, region, owner_contact, channel, message_variant,
          response, objection, proof_walkthrough_status, checkout_status, activation_status,
          next_state, touch_count, spend_cents, last_touch_at, notes
        ) VALUES (
          ${input.source}, ${input.company}, ${input.vertical}, ${input.region}, ${input.owner_contact}, ${input.channel}, ${input.message_variant},
          ${input.response}, ${input.objection}, ${input.proof_walkthrough_status}, ${input.checkout_status}, ${input.activation_status},
          ${input.next_state}, ${input.touch_count}, ${input.spend_cents}, ${input.touch_count > 0 ? new Date().toISOString() : null}, ${input.notes}
        )
        RETURNING *
      `;
      return res.status(201).json({ ok: true, row });
    } catch (err: any) {
      log("error", "Launch ledger create failed", { error: err?.message });
      return res.status(500).json({ ok: false, error: "Launch ledger create failed" });
    }
  });

  app.patch("/api/launch/ledger/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });

    const id = Number.parseInt(String(req.params.id || ""), 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "Invalid ledger id" });

    const body = req.body as Record<string, unknown>;
    const input = buildLedgerInput(body);
    const bumpTouch = Boolean(body.bump_touch);
    const proofStatusPatch = body.proof_walkthrough_status === undefined ? null : input.proof_walkthrough_status;
    const checkoutStatusPatch = body.checkout_status === undefined ? null : input.checkout_status;
    const activationStatusPatch = body.activation_status === undefined ? null : input.activation_status;
    const nextStatePatch = body.next_state === undefined ? null : input.next_state;

    try {
      const [row] = await sql`
        UPDATE launch_ledger
        SET
          source = COALESCE(${cleanText(body.source, 120)}, source),
          company = COALESCE(${cleanText(body.company, 180)}, company),
          vertical = COALESCE(${cleanText(body.vertical, 120)}, vertical),
          region = COALESCE(${cleanText(body.region, 120)}, region),
          owner_contact = COALESCE(${cleanText(body.owner_contact, 180)}, owner_contact),
          channel = COALESCE(${cleanText(body.channel, 120)}, channel),
          message_variant = COALESCE(${cleanText(body.message_variant, 120)}, message_variant),
          response = COALESCE(${cleanText(body.response, 240)}, response),
          objection = COALESCE(${cleanText(body.objection, 240)}, objection),
          proof_walkthrough_status = COALESCE(${proofStatusPatch}, proof_walkthrough_status),
          checkout_status = COALESCE(${checkoutStatusPatch}, checkout_status),
          activation_status = COALESCE(${activationStatusPatch}, activation_status),
          next_state = COALESCE(${nextStatePatch}, next_state),
          touch_count = CASE WHEN ${bumpTouch} THEN touch_count + 1 ELSE COALESCE(${body.touch_count === undefined ? null : input.touch_count}, touch_count) END,
          spend_cents = COALESCE(${body.spend_cents === undefined ? null : input.spend_cents}, spend_cents),
          last_touch_at = CASE WHEN ${bumpTouch} THEN NOW() ELSE last_touch_at END,
          notes = COALESCE(${cleanText(body.notes, 2000)}, notes),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      if (!row) return res.status(404).json({ ok: false, error: "Ledger row not found" });
      return res.json({ ok: true, row });
    } catch (err: any) {
      log("error", "Launch ledger update failed", { error: err?.message, id });
      return res.status(500).json({ ok: false, error: "Launch ledger update failed" });
    }
  });
}
