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
      const [byEvent, bySource, recent] = await Promise.all([
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
        by_event: byEvent,
        by_source: bySource,
        recent_events: recent,
      });
    } catch (err: any) {
      log("error", "Launch summary failed", { error: err?.message });
      return res.status(500).json({ ok: false, error: "Launch summary failed" });
    }
  });
}
