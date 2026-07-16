import type { Express, Request, RequestHandler, Response } from "express";
import { insertCalendarEvent, isCalendarConfigured, listCalendarEvents } from "../gcal.js";

type CalendarRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
};

export function registerCalendarRoutes(app: Express, deps: CalendarRouteDeps): void {
  const { dashboardAuth, requireOperator, sql, dbEnabled, getWorkspaceId } = deps;

  const appointmentSelect = () => sql`
    SELECT
      a.id,
      a.contact_id,
      a.call_sid,
      a.scheduled_at,
      a.service_type,
      a.notes,
      a.technician,
      a.location,
      a.duration_minutes,
      a.status,
      a.created_at,
      c.name as contact_name,
      c.phone_number
  `;

  app.get("/api/appointments", dashboardAuth, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.json({ appointments: [], total: 0 });
    const wsId = getWorkspaceId(req);
    const { status, contact_id, limit = "50" } = req.query as Record<string, string>;
    const lim = Math.min(parseInt(limit) || 50, 200);
    let rows;
    if (status && contact_id) {
      rows = await sql`
        ${appointmentSelect()}
        FROM appointments a LEFT JOIN contacts c ON a.contact_id = c.id
        WHERE a.workspace_id = ${wsId} AND a.status = ${status} AND a.contact_id = ${parseInt(contact_id)}
        ORDER BY a.scheduled_at ASC LIMIT ${lim}
      `;
    } else if (status) {
      rows = await sql`
        ${appointmentSelect()}
        FROM appointments a LEFT JOIN contacts c ON a.contact_id = c.id
        WHERE a.workspace_id = ${wsId} AND a.status = ${status}
        ORDER BY a.scheduled_at ASC LIMIT ${lim}
      `;
    } else if (contact_id) {
      rows = await sql`
        ${appointmentSelect()}
        FROM appointments a LEFT JOIN contacts c ON a.contact_id = c.id
        WHERE a.workspace_id = ${wsId} AND a.contact_id = ${parseInt(contact_id)}
        ORDER BY a.scheduled_at ASC LIMIT ${lim}
      `;
    } else {
      rows = await sql`
        ${appointmentSelect()}
        FROM appointments a LEFT JOIN contacts c ON a.contact_id = c.id
        WHERE a.workspace_id = ${wsId}
        ORDER BY a.scheduled_at ASC LIMIT ${lim}
      `;
    }
    res.json({ appointments: rows, total: rows.length });
  });

  app.get("/api/appointments/:id", dashboardAuth, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(404).json({ error: "Appointment not found." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid appointment ID." });
    const wsId = getWorkspaceId(req);
    const rows = await sql`
      ${appointmentSelect()}
      FROM appointments a LEFT JOIN contacts c ON a.contact_id = c.id
      WHERE a.id = ${id} AND a.workspace_id = ${wsId} LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: "Appointment not found." });
    res.json({ appointment: rows[0] });
  });

  app.patch("/api/appointments/:id", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid appointment ID." });
    const { status, notes, scheduled_at, service_type, technician, location } = req.body;
    const VALID_STATUSES = ["scheduled", "confirmed", "completed", "cancelled", "no_show"];
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
    }
    await sql`
      UPDATE appointments SET
        status       = COALESCE(${status       ?? null}, status),
        notes        = COALESCE(${notes        ?? null}, notes),
        scheduled_at = COALESCE(${scheduled_at ?? null}, scheduled_at),
        service_type = COALESCE(${service_type ?? null}, service_type),
        technician   = COALESCE(${technician   ?? null}, technician),
        location     = COALESCE(${location     ?? null}, location)
      WHERE id = ${id}
    `;
    res.json({ success: true });
  });

  app.post("/api/appointments", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Database is not connected in this local environment." });
    const { contact_id, scheduled_at, service_type, notes, technician, location, duration_minutes } = req.body;
    if (!contact_id || !scheduled_at) {
      return res.status(400).json({ error: "contact_id and scheduled_at are required." });
    }
    const wsId = getWorkspaceId(req);
    const rows = await sql`
      INSERT INTO appointments (contact_id, scheduled_at, service_type, notes, technician, location, duration_minutes, status, workspace_id)
      VALUES (${contact_id}, ${scheduled_at}, ${service_type ?? null}, ${notes ?? null}, ${technician ?? null}, ${location ?? null}, ${duration_minutes ?? 60}, 'scheduled', ${wsId})
      RETURNING id
    `;
    res.json({ success: true, id: (rows as any)[0]?.id });
  });

  app.post("/api/calendar/test-booking", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!isCalendarConfigured()) {
      return res.status(400).json({ success: false, error: "Google Calendar not configured. Set GOOGLE_SA_* vars and GOOGLE_CALENDAR_ID." });
    }
    try {
      const {
        summary = "SMIRK TEST - LIVE",
        scheduled_at,
        duration_minutes = 30,
        location,
        notes,
        attendee_email,
      } = req.body as Record<string, any>;

      const startIso = scheduled_at || new Date(Date.now() + 60 * 60_000).toISOString();
      const endIso = new Date(new Date(startIso).getTime() + (duration_minutes || 30) * 60_000).toISOString();

      const result = await insertCalendarEvent({
        summary,
        description: [
          notes || "End-to-end booking verification via SMIRK API",
          `Created: ${new Date().toISOString()}`,
          `Source: /api/calendar/test-booking`,
        ].join("\n"),
        startIso,
        endIso,
        location: location || undefined,
        attendeeEmail: attendee_email || undefined,
        timeZone: "America/Los_Angeles",
      });

      if (!result.success) {
        return res.status(502).json({ success: false, error: result.error });
      }

      res.json({
        success: true,
        eventId: result.eventId,
        htmlLink: result.htmlLink,
        summary,
        start: startIso,
        end: endIso,
        message: "Calendar event created. Verify at the htmlLink above.",
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || "Unknown error" });
    }
  });

  app.get("/api/calendar/events", dashboardAuth, async (req: Request, res: Response) => {
    if (!isCalendarConfigured()) {
      return res.json({ configured: false, events: [], message: "Google Calendar not configured. Add GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_CALENDAR_ID in Settings." });
    }
    const { start, end } = req.query as Record<string, string>;
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay() + 1);
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);

    const startIso = start || startOfWeek.toISOString();
    const endIso = end || endOfWeek.toISOString();

    try {
      const result = await listCalendarEvents(startIso, endIso, 100);
      if (!result.success) {
        return res.status(502).json({ configured: true, error: result.error, events: [] });
      }
      res.json({ configured: true, events: result.events, start: startIso, end: endIso });
    } catch (err: any) {
      res.status(500).json({ configured: true, error: err.message, events: [] });
    }
  });
}
