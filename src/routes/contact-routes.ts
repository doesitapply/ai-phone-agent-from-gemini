import type { Express, Request, RequestHandler, Response } from "express";
import { addToDNC, removeFromDNC } from "../compliance.js";
import { getMockContactDetail, getMockContacts } from "../mock-db.js";

const CONTACT_STATUSES = new Set(["active", "lead", "customer", "inactive", "bad_number"]);

type ContactRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
};

export function registerContactRoutes(app: Express, deps: ContactRouteDeps): void {
  const { dashboardAuth, requireOperator, sql, dbEnabled, getWorkspaceId } = deps;

  app.get("/api/contacts", dashboardAuth, async (req: Request, res: Response) => {
    const wsId = getWorkspaceId(req);
    const limit = Math.min(parseInt(req.query.limit as string || "50"), 100);
    const offset = parseInt(req.query.offset as string || "0");
    const includeAnonymous = req.query.include_anonymous === "true";
    if (!dbEnabled) {
      const contacts = getMockContacts(includeAnonymous);
      return res.json({ contacts: contacts.slice(offset, offset + limit), total: contacts.length });
    }
    const contacts = includeAnonymous
      ? await sql`
          SELECT
            c.id,
            c.phone_number,
            c.name,
            c.email,
            c.company_name,
            c.company_name as company,
            c.last_seen,
            c.last_summary,
            c.last_outcome,
            c.open_tasks_count,
            c.do_not_call,
            c.status,
            COUNT(ca.id) as total_calls
          FROM contacts c
          LEFT JOIN calls ca ON c.id = ca.contact_id
          WHERE c.workspace_id = ${wsId}
          GROUP BY c.id
          ORDER BY c.last_seen DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await sql`
          SELECT
            c.id,
            c.phone_number,
            c.name,
            c.email,
            c.company_name,
            c.company_name as company,
            c.last_seen,
            c.last_summary,
            c.last_outcome,
            c.open_tasks_count,
            c.do_not_call,
            c.status,
            COUNT(ca.id) as total_calls
          FROM contacts c
          LEFT JOIN calls ca ON c.id = ca.contact_id
          WHERE c.workspace_id = ${wsId}
            AND c.name IS NOT NULL
            AND TRIM(c.name) != ''
          GROUP BY c.id
          ORDER BY c.last_seen DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
    const totalRows = includeAnonymous
      ? await sql`SELECT COUNT(*) as count FROM contacts WHERE workspace_id = ${wsId}`
      : await sql`SELECT COUNT(*) as count FROM contacts WHERE workspace_id = ${wsId} AND name IS NOT NULL AND TRIM(name) != ''`;
    res.json({ contacts, total: Number(totalRows[0].count) });
  });

  app.post("/api/contacts", dashboardAuth, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Demo mode is read-only. Connect a database to create contacts." });
    const wsId = getWorkspaceId(req);
    const { name, email, notes } = req.body;
    const status = CONTACT_STATUSES.has(req.body.status) ? req.body.status : "active";
    const phone_number = (req.body.phone_number || req.body.phone || "").trim();
    if (!phone_number) return res.status(400).json({ error: "phone or phone_number is required" });
    try {
      const existing = await sql`SELECT id FROM contacts WHERE phone_number = ${phone_number.trim()} AND workspace_id = ${wsId}`;
      if (existing.length) return res.status(409).json({ error: "A contact with this phone number already exists.", id: existing[0].id });
      const rows = await sql`
        INSERT INTO contacts (phone_number, name, email, company_name, notes, workspace_id, last_seen, status)
        VALUES (${phone_number.trim()}, ${name?.trim() || null}, ${email?.trim() || null}, ${(req.body.company as string)?.trim() || null}, ${notes?.trim() || null}, ${wsId}, NOW(), ${status})
        RETURNING *
      `;
      res.status(201).json({ contact: rows[0] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/contacts/:id", dashboardAuth, async (req: Request, res: Response) => {
    const wsId = getWorkspaceId(req);
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
    if (!dbEnabled) {
      const detail = getMockContactDetail(id);
      if (!detail) return res.status(404).json({ error: "Contact not found." });
      return res.json(detail);
    }
    const contactRows = await sql`SELECT * FROM contacts WHERE id = ${id} AND workspace_id = ${wsId}`;
    if (!contactRows.length) return res.status(404).json({ error: "Contact not found." });
    const calls = await sql`SELECT * FROM calls WHERE contact_id = ${id} AND workspace_id = ${wsId} ORDER BY started_at DESC LIMIT 20`;
    const tasks = await sql`SELECT * FROM tasks WHERE contact_id = ${id} AND workspace_id = ${wsId} ORDER BY created_at DESC`;
    const appointments = await sql`SELECT * FROM appointments WHERE contact_id = ${id} AND workspace_id = ${wsId} ORDER BY scheduled_at DESC`;
    res.json({ contact: contactRows[0], calls, tasks, appointments });
  });

  app.delete("/api/contacts/:id", dashboardAuth, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Demo mode is read-only. Connect a database to delete contacts." });
    const wsId = getWorkspaceId(req);
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
    const existing = await sql`SELECT id FROM contacts WHERE id = ${id} AND workspace_id = ${wsId}`;
    if (!existing.length) return res.status(404).json({ error: "Contact not found." });
    await sql`UPDATE calls SET contact_id = NULL WHERE contact_id = ${id} AND workspace_id = ${wsId}`;
    await sql`UPDATE tasks SET contact_id = NULL WHERE contact_id = ${id} AND workspace_id = ${wsId}`;
    await sql`UPDATE call_summaries SET contact_id = NULL WHERE contact_id = ${id}`;
    await sql`UPDATE sms_messages SET contact_id = NULL WHERE contact_id = ${id}`;
    await sql`UPDATE appointments SET contact_id = NULL WHERE contact_id = ${id}`;
    await sql`UPDATE tool_executions SET contact_id = NULL WHERE contact_id = ${id}`;
    await sql`UPDATE handoffs SET contact_id = NULL WHERE contact_id = ${id}`;
    await sql`DELETE FROM contact_custom_fields WHERE contact_id = ${id} AND workspace_id = ${wsId}`;
    await sql`DELETE FROM contacts WHERE id = ${id} AND workspace_id = ${wsId}`;
    res.json({ success: true, deleted: id });
  });

  app.get("/api/contacts/:id/detail", dashboardAuth, async (req: Request, res: Response) => {
    const wsId = getWorkspaceId(req);
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
    if (!dbEnabled) {
      const detail = getMockContactDetail(id);
      if (!detail) return res.status(404).json({ error: "Contact not found." });
      return res.json(detail);
    }
    const [contactRows, calls, tasks, appointments, summaries, customFields] = await Promise.all([
      sql`
        SELECT
          c.id,
          c.phone_number,
          c.name,
          c.email,
          c.company_name,
          c.company_name as company,
          c.address,
          c.city,
          c.state,
          c.zip,
          c.notes,
          c.last_seen,
          c.last_summary,
          c.last_outcome,
          c.open_tasks_count,
          c.do_not_call,
          c.status,
          COUNT(ca.id) as total_calls
        FROM contacts c
        LEFT JOIN calls ca ON c.id = ca.contact_id AND ca.workspace_id = c.workspace_id
        WHERE c.id = ${id} AND c.workspace_id = ${wsId}
        GROUP BY c.id
      `,
      sql`
        SELECT
          c.call_sid,
          c.direction,
          c.from_number,
          c.to_number,
          c.status,
          c.started_at,
          c.ended_at,
          c.duration_seconds,
          c.agent_name,
          cs.intent,
          cs.outcome,
          cs.sentiment,
          cs.resolution_score,
          cs.summary as call_summary
        FROM calls c
        LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
        WHERE c.contact_id = ${id} AND c.workspace_id = ${wsId}
        ORDER BY c.started_at DESC LIMIT 30
      `,
      sql`
        SELECT id, contact_id, call_sid, task_type, title, description, priority, status, notes, due_at, created_at, assigned_to
        FROM tasks
        WHERE contact_id = ${id} AND workspace_id = ${wsId}
        ORDER BY created_at DESC
      `,
      sql`
        SELECT id, contact_id, scheduled_at, service_type, notes, technician, location, duration_minutes, status, created_at
        FROM appointments
        WHERE contact_id = ${id} AND workspace_id = ${wsId}
        ORDER BY scheduled_at DESC
      `,
      sql`
        SELECT id, call_sid, intent, outcome, sentiment, resolution_score, summary, next_action, created_at
        FROM call_summaries
        WHERE contact_id = ${id} AND workspace_id = ${wsId}
        ORDER BY created_at DESC LIMIT 10
      `,
      sql`
        SELECT field_key, field_value, confidence, source, transcript_snippet, updated_at
        FROM contact_custom_fields
        WHERE contact_id = ${id} AND workspace_id = ${wsId}
        ORDER BY field_key ASC
      `,
    ]);
    if (!contactRows.length) return res.status(404).json({ error: "Contact not found." });
    res.json({ contact: contactRows[0], calls, tasks, appointments, summaries, customFields });
  });

  app.patch("/api/contacts/:id", dashboardAuth, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Demo mode is read-only. Connect a database to update contacts." });
    const wsId = getWorkspaceId(req);
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
    const { name, email, company, notes, tags, address, city, state, zip } = req.body;
    const nextStatus = req.body.status === undefined ? undefined : String(req.body.status);
    if (nextStatus !== undefined && !CONTACT_STATUSES.has(nextStatus)) {
      return res.status(400).json({ error: "Invalid contact status." });
    }
    const result = await sql`
      UPDATE contacts SET
        name         = COALESCE(${name         ?? null}, name),
        email        = COALESCE(${email        ?? null}, email),
        company_name = COALESCE(${company      ?? null}, company_name),
        notes        = COALESCE(${notes        ?? null}, notes),
        address      = COALESCE(${address      ?? null}, address),
        city         = COALESCE(${city         ?? null}, city),
        state        = COALESCE(${state        ?? null}, state),
        zip          = COALESCE(${zip          ?? null}, zip),
        status       = COALESCE(${nextStatus   ?? null}, status),
        tags         = COALESCE(${tags ? sql.json(tags) : null}, tags),
        updated_at   = NOW()
      WHERE id = ${id} AND workspace_id = ${wsId}
    `;
    if (result.count === 0) return res.status(404).json({ error: "Contact not found." });
    res.json({ success: true });
  });

  app.post("/api/contacts/:id/dnc", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Demo mode is read-only. Connect a database to update DNC." });
    const wsId = getWorkspaceId(req);
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
    const reason = String(req.body.reason || "manual").trim();
    const contactRows = await sql`SELECT phone_number FROM contacts WHERE id = ${id} AND workspace_id = ${wsId} LIMIT 1`;
    if (!contactRows.length) return res.status(404).json({ error: "Contact not found." });
    await addToDNC(contactRows[0].phone_number, reason || "manual", "contact_detail", "operator");
    await sql`UPDATE contacts SET do_not_call = TRUE, updated_at = NOW() WHERE id = ${id} AND workspace_id = ${wsId}`;
    res.json({ success: true });
  });

  app.delete("/api/contacts/:id/dnc", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    if (!dbEnabled) return res.status(503).json({ error: "Demo mode is read-only. Connect a database to update DNC." });
    const wsId = getWorkspaceId(req);
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
    const consentNote = String(req.body.consent_note || req.body.reason || "").trim();
    if (consentNote.length < 8) {
      return res.status(400).json({ error: "A consent or correction note is required to remove DNC." });
    }
    const contactRows = await sql`SELECT phone_number FROM contacts WHERE id = ${id} AND workspace_id = ${wsId} LIMIT 1`;
    if (!contactRows.length) return res.status(404).json({ error: "Contact not found." });
    await removeFromDNC(contactRows[0].phone_number, consentNote);
    await sql`UPDATE contacts SET do_not_call = FALSE, updated_at = NOW() WHERE id = ${id} AND workspace_id = ${wsId}`;
    res.json({ success: true });
  });

  app.put("/api/contacts/:id/fields", dashboardAuth, async (req: Request, res: Response) => {
    const wsId = getWorkspaceId(req);
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contact ID." });
    const contactRows = await sql`SELECT id FROM contacts WHERE id = ${id} AND workspace_id = ${wsId} LIMIT 1`;
    if (!contactRows.length) return res.status(404).json({ error: "Contact not found." });
    const fields = req.body as Record<string, string>;
    for (const [key, value] of Object.entries(fields)) {
      const upd = await sql`
        UPDATE contact_custom_fields
        SET field_value = ${value}, source = 'manual', updated_at = NOW()
        WHERE contact_id = ${id} AND field_key = ${key} AND workspace_id = ${wsId}
      `;
      if (upd.count === 0) {
        await sql`
          INSERT INTO contact_custom_fields (contact_id, workspace_id, field_key, field_value, source, updated_at)
          VALUES (${id}, ${wsId}, ${key}, ${value}, 'manual', NOW())
          ON CONFLICT DO NOTHING
        `;
      }
    }
    res.json({ success: true });
  });

  app.get("/api/field-definitions", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    const fields = await sql`SELECT * FROM field_definitions ORDER BY sort_order ASC, label ASC`;
    res.json(fields);
  });

  app.post("/api/field-definitions", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const { field_key, label, field_type, description, required, capture_via } = req.body;
    if (!field_key || !label) return res.status(400).json({ error: "field_key and label are required." });
    await sql`
      INSERT INTO field_definitions (field_key, label, field_type, description, required, capture_via)
      VALUES (${field_key}, ${label}, ${field_type || 'text'}, ${description || null}, ${required || false}, ${capture_via || 'ai'})
      ON CONFLICT (field_key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description
    `;
    res.json({ success: true });
  });

  app.delete("/api/field-definitions/:key", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    await sql`DELETE FROM field_definitions WHERE field_key = ${req.params.key}`;
    res.json({ success: true });
  });
}
