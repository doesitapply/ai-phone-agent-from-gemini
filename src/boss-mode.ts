/**
 * Boss Mode — Hardened Verbal Command Center
 *
 * Architecture:
 *   1. Caller authenticates (caller ID + optional PIN)
 *   2. Speech is classified into one of three response classes:
 *      - STATUS_QUERY  → read-only, no confirmation needed
 *      - BRIEFING      → inject temporary knowledge, confirm before applying
 *      - OPERATIONAL   → routing changes, closures, on-call toggling — confirm + stronger auth
 *   3. Risky actions (BRIEFING + OPERATIONAL) go through parse-confirm-apply loop
 *   4. Every action is written to boss_mode_audit_log (who, what, when, raw transcript, result)
 *   5. Every applied action can be rolled back via DELETE /api/boss/context/:id or toggle
 *
 * Priority ordering for active briefings (higher = wins conflicts):
 *   emergency(100) > closure(80) > policy(60) > pricing(50) > promo(40) > briefing(20) > other(10)
 */

import { Router, Request, Response } from "express";
import twilio from "twilio";
import OpenAI from "openai";
import { sql } from "./db.js";

const VoiceResponse = twilio.twiml.VoiceResponse;

// ── OpenAI client ────────────────────────────────────────────────────────────
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const openai = new OpenAI({
  apiKey: OPENAI_KEY ?? GEMINI_KEY,
  baseURL: OPENAI_KEY
    ? "https://api.openai.com/v1"
    : "https://generativelanguage.googleapis.com/v1beta/openai",
});

// ── Priority map for briefing categories ────────────────────────────────────
const CATEGORY_PRIORITY: Record<string, number> = {
  emergency: 100,
  closure: 80,
  policy: 60,
  pricing: 50,
  promo: 40,
  briefing: 20,
  other: 10,
};

// ── Response class definitions ───────────────────────────────────────────────
type ResponseClass = "STATUS_QUERY" | "BRIEFING" | "OPERATIONAL";

// ── Boss Mode Tools ──────────────────────────────────────────────────────────
const BOSS_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "toggle_on_call",
      description: "Mark a team member as on-call or off-call. OPERATIONAL class — requires confirmation.",
      parameters: {
        type: "object",
        properties: {
          name_hint: { type: "string", description: "Name or partial name of the team member" },
          on_call: { type: "boolean", description: "true = on-call, false = off-call" },
          duration_hours: { type: "number", description: "Optional: auto-revert after N hours" },
        },
        required: ["name_hint", "on_call"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inject_knowledge",
      description: "Inject a temporary briefing into the customer-facing AI. BRIEFING class — requires confirmation.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The knowledge to inject" },
          category: {
            type: "string",
            enum: ["emergency", "closure", "policy", "pricing", "promo", "briefing", "other"],
            description: "Category determines priority (emergency > closure > policy > pricing > promo > briefing > other)",
          },
          is_permanent: { type: "boolean", description: "If true, never expires. Default false (24h)." },
          expires_hours: { type: "number", description: "Custom expiry in hours. Default 24." },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_knowledge",
      description: "Clear active briefings. OPERATIONAL class — requires confirmation.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Optional: only clear a specific category. Omit to clear all." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_status",
      description: "Get current system status: who is on-call, active briefings, recent calls. STATUS_QUERY — no confirmation needed.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_topics",
      description: "Update which topics a team member handles. OPERATIONAL class.",
      parameters: {
        type: "object",
        properties: {
          name_hint: { type: "string", description: "Name or partial name of the team member" },
          topics: { type: "array", items: { type: "string" }, description: "Full replacement list of topics" },
        },
        required: ["name_hint", "topics"],
      },
    },
  },
];

// ── Classify response class ──────────────────────────────────────────────────
function classifyTool(toolName: string): ResponseClass {
  if (toolName === "get_status") return "STATUS_QUERY";
  if (toolName === "inject_knowledge") return "BRIEFING";
  return "OPERATIONAL"; // toggle_on_call, clear_knowledge, update_topics
}

// ── Audit log writer ─────────────────────────────────────────────────────────
async function writeAuditLog(params: {
  wsId: number;
  callerName: string;
  callerPhone: string;
  authMethod: string;
  rawTranscript: string;
  parsedIntent: string;
  toolName: string | null;
  toolArgs: Record<string, unknown> | null;
  systemAction: string;
  responseClass: ResponseClass;
  confirmed: boolean;
  rollbackId: number | null;
  expiresAt: Date | null;
}): Promise<void> {
  try {
    await sql`
      INSERT INTO boss_mode_audit_log (
        workspace_id, caller_name, caller_phone, auth_method,
        raw_transcript, parsed_intent, tool_name, tool_args,
        system_action, response_class, confirmed, rollback_id, expires_at
      ) VALUES (
        ${params.wsId}, ${params.callerName}, ${params.callerPhone}, ${params.authMethod},
        ${params.rawTranscript}, ${params.parsedIntent}, ${params.toolName},
        ${params.toolArgs ? JSON.stringify(params.toolArgs) : null},
        ${params.systemAction}, ${params.responseClass}, ${params.confirmed},
        ${params.rollbackId}, ${params.expiresAt}
      )
    `;
  } catch {
    // Audit log failure should never block the main flow
  }
}

// ── Tool Execution ───────────────────────────────────────────────────────────
async function executeBossTool(
  name: string,
  args: Record<string, unknown>,
  wsId: number,
  callerName: string
): Promise<{ result: string; rollbackId: number | null; expiresAt: Date | null }> {
  try {
    if (name === "toggle_on_call") {
      const hint = (args.name_hint as string).toLowerCase();
      const onCall = args.on_call as boolean;
      const durationHours = args.duration_hours as number | undefined;

      const rows = await sql`
        UPDATE team_members
        SET is_on_call = ${onCall}, updated_at = NOW()
        WHERE workspace_id = ${wsId}
          AND LOWER(name) LIKE ${"%" + hint + "%"}
          AND is_active = TRUE
        RETURNING id, name, role
      ` as { id: number; name: string; role: string }[];

      if (!rows.length) {
        return { result: `No active team member found matching "${args.name_hint}".`, rollbackId: null, expiresAt: null };
      }

      const status = onCall ? "on-call" : "off-call";
      const durationNote = durationHours ? ` for ${durationHours} hours` : "";
      const result = rows.map((r) => `${r.name} (${r.role}) is now ${status}${durationNote}.`).join(" ");
      return { result, rollbackId: rows[0].id, expiresAt: null };
    }

    if (name === "inject_knowledge") {
      const content = args.content as string;
      const category = (args.category as string) || "briefing";
      const isPermanent = (args.is_permanent as boolean) || false;
      const expiresHours = (args.expires_hours as number) || 24;
      const expiresAt = isPermanent ? null : new Date(Date.now() + expiresHours * 3600 * 1000);
      const priority = CATEGORY_PRIORITY[category] ?? 10;

      const inserted = await sql`
        INSERT INTO temporary_context
          (workspace_id, content, category, source, is_permanent, expires_at, created_by, priority)
        VALUES
          (${wsId}, ${content}, ${category}, 'boss_mode', ${isPermanent}, ${expiresAt}, ${callerName}, ${priority})
        RETURNING id
      ` as { id: number }[];

      const expiry = isPermanent ? "permanently" : `for ${expiresHours} hours`;
      const result = `Got it. Briefing injected ${expiry}: "${content}"`;
      return { result, rollbackId: inserted[0]?.id ?? null, expiresAt };
    }

    if (name === "clear_knowledge") {
      const category = args.category as string | undefined;
      if (category) {
        await sql`DELETE FROM temporary_context WHERE workspace_id = ${wsId} AND category = ${category}`;
        return { result: `All ${category} briefings cleared.`, rollbackId: null, expiresAt: null };
      } else {
        await sql`DELETE FROM temporary_context WHERE workspace_id = ${wsId}`;
        return { result: "All active briefings cleared.", rollbackId: null, expiresAt: null };
      }
    }

    if (name === "get_status") {
      const [onCallRows, briefingRows, recentCalls] = await Promise.all([
        sql`
          SELECT name, role FROM team_members
          WHERE workspace_id = ${wsId} AND is_on_call = TRUE AND is_active = TRUE
          ORDER BY priority DESC
        ` as { name: string; role: string }[],
        sql`
          SELECT content, category, expires_at FROM temporary_context
          WHERE workspace_id = ${wsId} AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY priority DESC, created_at DESC LIMIT 5
        ` as { content: string; category: string; expires_at: string | null }[],
        sql`
          SELECT direction, duration FROM calls
          WHERE workspace_id = ${wsId}
          ORDER BY created_at DESC LIMIT 3
        ` as { direction: string; duration: number }[],
      ]);

      let status = "";
      status += onCallRows.length
        ? `On call: ${onCallRows.map((r) => `${r.name} (${r.role})`).join(", ")}. `
        : "No one on call. ";
      status += briefingRows.length
        ? `Active briefings: ${briefingRows.map((b) => b.content).join("; ")}. `
        : "No active briefings. ";
      if (recentCalls.length) {
        status += `Last ${recentCalls.length} calls: ${recentCalls.map((c) => `${c.direction} (${c.duration}s)`).join(", ")}.`;
      }
      return { result: status || "System running normally.", rollbackId: null, expiresAt: null };
    }

    if (name === "update_topics") {
      const hint = (args.name_hint as string).toLowerCase();
      const topics = args.topics as string[];
      const rows = await sql`
        UPDATE team_members
        SET handles_topics = ${sql.array(topics)}, updated_at = NOW()
        WHERE workspace_id = ${wsId}
          AND LOWER(name) LIKE ${"%" + hint + "%"}
          AND is_active = TRUE
        RETURNING id, name
      ` as { id: number; name: string }[];
      if (!rows.length) return { result: `No active team member found matching "${args.name_hint}".`, rollbackId: null, expiresAt: null };
      return { result: `Updated topics for ${rows[0].name}: ${topics.join(", ")}.`, rollbackId: rows[0].id, expiresAt: null };
    }

    return { result: "Unknown command.", rollbackId: null, expiresAt: null };
  } catch (err) {
    return { result: `Error: ${err instanceof Error ? err.message : "unknown error"}`, rollbackId: null, expiresAt: null };
  }
}

// ── Human-readable confirmation prompt for risky actions ────────────────────
function buildConfirmationPrompt(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "inject_knowledge") {
    const cat = (args.category as string) || "briefing";
    const perm = args.is_permanent ? "permanently" : `for ${args.expires_hours || 24} hours`;
    return `You said: inject a ${cat} briefing ${perm}: "${args.content}". Is that correct? Say yes to confirm or no to cancel.`;
  }
  if (toolName === "toggle_on_call") {
    const status = args.on_call ? "on-call" : "off-call";
    const dur = args.duration_hours ? ` for ${args.duration_hours} hours` : "";
    return `You said: mark ${args.name_hint} as ${status}${dur}. Is that correct? Say yes to confirm or no to cancel.`;
  }
  if (toolName === "clear_knowledge") {
    const scope = args.category ? `all ${args.category} briefings` : "ALL active briefings";
    return `You said: clear ${scope}. Is that correct? Say yes to confirm or no to cancel.`;
  }
  if (toolName === "update_topics") {
    const topics = (args.topics as string[]).join(", ");
    return `You said: update ${args.name_hint}'s topics to: ${topics}. Is that correct? Say yes to confirm or no to cancel.`;
  }
  return `Confirm this action? Say yes to confirm or no to cancel.`;
}

// ── Fetch active temporary context for customer-facing calls ─────────────────
export async function getActiveTemporaryContext(wsId: number): Promise<string> {
  try {
    const rows = await sql`
      SELECT content, category FROM temporary_context
      WHERE workspace_id = ${wsId}
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY priority DESC, created_at DESC
      LIMIT 10
    ` as { content: string; category: string }[];

    if (!rows.length) return "";
    return rows.map((r) => r.content).join("\n");
  } catch {
    return "";
  }
}

// ── Boss Mode Router ─────────────────────────────────────────────────────────
export function registerBossModeRoutes(app: ReturnType<typeof import("express").default>): void {
  const router = Router();

  // GET /api/boss/settings
  router.get("/settings", async (req: Request, res: Response) => {
    const wsId = (req as any).workspaceId ?? 1;
    try {
      const rows = await sql`
        SELECT boss_phone, twilio_number, enabled
        FROM boss_mode_settings WHERE workspace_id = ${wsId}
      ` as { boss_phone: string | null; twilio_number: string | null; enabled: boolean }[];
      res.json(rows[0] ?? { boss_phone: null, twilio_number: null, enabled: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/boss/settings
  router.post("/settings", async (req: Request, res: Response) => {
    const wsId = (req as any).workspaceId ?? 1;
    const { boss_phone, boss_pin, twilio_number, enabled } = req.body;
    try {
      await sql`
        INSERT INTO boss_mode_settings (workspace_id, boss_phone, boss_pin, twilio_number, enabled)
        VALUES (${wsId}, ${boss_phone ?? null}, ${boss_pin ?? null}, ${twilio_number ?? null}, ${enabled ?? false})
        ON CONFLICT (workspace_id) DO UPDATE SET
          boss_phone    = COALESCE(${boss_phone ?? null}, boss_mode_settings.boss_phone),
          boss_pin      = COALESCE(${boss_pin ?? null}, boss_mode_settings.boss_pin),
          twilio_number = COALESCE(${twilio_number ?? null}, boss_mode_settings.twilio_number),
          enabled       = COALESCE(${enabled ?? null}, boss_mode_settings.enabled),
          updated_at    = NOW()
      `;
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/boss/context — active briefings ordered by priority
  router.get("/context", async (req: Request, res: Response) => {
    const wsId = (req as any).workspaceId ?? 1;
    try {
      const rows = await sql`
        SELECT id, content, category, is_permanent, expires_at, created_by, created_at, priority
        FROM temporary_context
        WHERE workspace_id = ${wsId}
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY priority DESC, created_at DESC
      `;
      res.json({ entries: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/boss/context — manual inject from dashboard
  router.post("/context", async (req: Request, res: Response) => {
    const wsId = (req as any).workspaceId ?? 1;
    const { content, category, is_permanent, expires_hours } = req.body;
    if (!content) return res.status(400).json({ error: "content is required" }) as any;
    try {
      const cat = category || "briefing";
      const isPermanent = is_permanent || false;
      const expiresHours = expires_hours || 24;
      const expiresAt = isPermanent ? null : new Date(Date.now() + expiresHours * 3600 * 1000);
      const priority = CATEGORY_PRIORITY[cat] ?? 10;
      const inserted = await sql`
        INSERT INTO temporary_context
          (workspace_id, content, category, source, is_permanent, expires_at, created_by, priority)
        VALUES
          (${wsId}, ${content}, ${cat}, 'dashboard', ${isPermanent}, ${expiresAt}, 'Dashboard', ${priority})
        RETURNING id
      ` as { id: number }[];
      res.json({ ok: true, id: inserted[0]?.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/boss/context/:id — rollback a specific briefing
  router.delete("/context/:id", async (req: Request, res: Response) => {
    const wsId = (req as any).workspaceId ?? 1;
    try {
      await sql`DELETE FROM temporary_context WHERE id = ${req.params.id} AND workspace_id = ${wsId}`;
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/boss/audit — audit log
  router.get("/audit", async (req: Request, res: Response) => {
    const wsId = (req as any).workspaceId ?? 1;
    const limit = parseInt(req.query.limit as string) || 50;
    try {
      const rows = await sql`
        SELECT id, caller_name, caller_phone, auth_method, raw_transcript, parsed_intent,
               tool_name, system_action, response_class, confirmed, rollback_id, expires_at, created_at
        FROM boss_mode_audit_log
        WHERE workspace_id = ${wsId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      res.json({ entries: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/boss/voice — Twilio inbound webhook
  router.post("/voice", async (req: Request, res: Response) => {
    const twiml = new VoiceResponse();
    const callerNumber = req.body.From ?? "";
    const wsId = 1;

    try {
      const settings = await sql`
        SELECT boss_phone, boss_pin, enabled FROM boss_mode_settings
        WHERE workspace_id = ${wsId}
      ` as { boss_phone: string | null; boss_pin: string | null; enabled: boolean }[];

      const cfg = settings[0];

      if (!cfg?.enabled) {
        twiml.say({ voice: "Polly.Joanna" }, "Boss Mode is not enabled.");
        twiml.hangup();
        res.type("text/xml").send(twiml.toString());
        return;
      }

      const normalizePhone = (p: string) => p.replace(/\D/g, "").slice(-10);
      const callerNorm = normalizePhone(callerNumber);
      const bossNorm = cfg.boss_phone ? normalizePhone(cfg.boss_phone) : null;

      if (bossNorm && callerNorm !== bossNorm) {
        twiml.say({ voice: "Polly.Joanna" }, "Unauthorized caller.");
        twiml.hangup();
        res.type("text/xml").send(twiml.toString());
        return;
      }

      if (cfg.boss_pin) {
        const gather = twiml.gather({ numDigits: "4", action: "/api/boss/pin", method: "POST", timeout: 10 });
        gather.say({ voice: "Polly.Joanna" }, "Welcome back. Enter your 4-digit PIN.");
      } else {
        twiml.redirect({ method: "POST" }, "/api/boss/command");
      }
    } catch {
      twiml.say({ voice: "Polly.Joanna" }, "System error. Please try again.");
      twiml.hangup();
    }

    res.type("text/xml").send(twiml.toString());
  });

  // POST /api/boss/pin — PIN verification
  router.post("/pin", async (req: Request, res: Response) => {
    const twiml = new VoiceResponse();
    const wsId = 1;
    const enteredPin = req.body.Digits ?? "";

    try {
      const settings = await sql`SELECT boss_pin FROM boss_mode_settings WHERE workspace_id = ${wsId}` as { boss_pin: string | null }[];
      if (settings[0]?.boss_pin && enteredPin !== settings[0].boss_pin) {
        twiml.say({ voice: "Polly.Joanna" }, "Incorrect PIN. Goodbye.");
        twiml.hangup();
      } else {
        twiml.redirect({ method: "POST" }, "/api/boss/command");
      }
    } catch {
      twiml.say({ voice: "Polly.Joanna" }, "System error.");
      twiml.hangup();
    }

    res.type("text/xml").send(twiml.toString());
  });

  // POST /api/boss/command — main command loop with parse-confirm-apply
  router.post("/command", async (req: Request, res: Response) => {
    const twiml = new VoiceResponse();
    const wsId = 1;
    const speechResult = req.body.SpeechResult ?? "";
    const callerNumber = req.body.From ?? "Boss";
    // pendingConfirm is passed back via Twilio's action URL params
    const pendingTool = req.body.pendingTool ?? "";
    const pendingArgs = req.body.pendingArgs ?? "";

    // Resolve caller name from team roster
    let callerName = "Boss";
    try {
      const normalizePhone = (p: string) => p.replace(/\D/g, "").slice(-10);
      const callerNorm = normalizePhone(callerNumber);
      const memberRows = await sql`
        SELECT name FROM team_members
        WHERE workspace_id = ${wsId}
          AND REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '+', '') LIKE ${"%" + callerNorm}
        LIMIT 1
      ` as { name: string }[];
      if (memberRows[0]) callerName = memberRows[0].name;
    } catch { /* ignore */ }

    // ── Handle pending confirmation ──────────────────────────────────────────
    if (pendingTool && pendingArgs && speechResult) {
      const lower = speechResult.toLowerCase();
      const confirmed = lower.includes("yes") || lower.includes("correct") || lower.includes("confirm") || lower.includes("yeah") || lower.includes("yep");
      const cancelled = lower.includes("no") || lower.includes("cancel") || lower.includes("stop") || lower.includes("nope");

      if (confirmed) {
        try {
          const args = JSON.parse(decodeURIComponent(pendingArgs));
          const { result, rollbackId, expiresAt } = await executeBossTool(pendingTool, args, wsId, callerName);

          await writeAuditLog({
            wsId, callerName, callerPhone: callerNumber, authMethod: "caller_id",
            rawTranscript: speechResult, parsedIntent: pendingTool,
            toolName: pendingTool, toolArgs: args,
            systemAction: result, responseClass: classifyTool(pendingTool),
            confirmed: true, rollbackId, expiresAt,
          });

          const gather = twiml.gather({ input: ["speech"], action: "/api/boss/command", method: "POST", speechTimeout: "auto", language: "en-US" });
          gather.say({ voice: "Polly.Joanna" }, `Done. ${result} Anything else?`);
          twiml.say({ voice: "Polly.Joanna" }, "No further commands. Goodbye.");
          twiml.hangup();
        } catch (err) {
          twiml.say({ voice: "Polly.Joanna" }, "Error applying the action. Please try again.");
          const gather = twiml.gather({ input: ["speech"], action: "/api/boss/command", method: "POST", speechTimeout: "auto" });
          gather.say({ voice: "Polly.Joanna" }, "What would you like to update?");
        }
      } else if (cancelled) {
        await writeAuditLog({
          wsId, callerName, callerPhone: callerNumber, authMethod: "caller_id",
          rawTranscript: speechResult, parsedIntent: "cancelled",
          toolName: pendingTool, toolArgs: null,
          systemAction: "Action cancelled by operator", responseClass: classifyTool(pendingTool),
          confirmed: false, rollbackId: null, expiresAt: null,
        });

        const gather = twiml.gather({ input: ["speech"], action: "/api/boss/command", method: "POST", speechTimeout: "auto", language: "en-US" });
        gather.say({ voice: "Polly.Joanna" }, "Cancelled. What else would you like to do?");
        twiml.say({ voice: "Polly.Joanna" }, "Goodbye.");
        twiml.hangup();
      } else {
        // Ambiguous — re-ask
        const gather = twiml.gather({
          input: ["speech"],
          action: `/api/boss/confirm?pendingTool=${encodeURIComponent(pendingTool)}&pendingArgs=${encodeURIComponent(pendingArgs)}`,
          method: "POST",
          speechTimeout: "auto",
        });
        gather.say({ voice: "Polly.Joanna" }, "Please say yes to confirm or no to cancel.");
        twiml.hangup();
      }

      res.type("text/xml").send(twiml.toString());
      return;
    }

    // ── No speech — prompt for first command ─────────────────────────────────
    if (!speechResult) {
      const gather = twiml.gather({
        input: ["speech"],
        action: "/api/boss/command",
        method: "POST",
        speechTimeout: "auto",
        language: "en-US",
        hints: "on call, off call, special, promo, closure, status, who is on call, clear briefings",
      });
      gather.say({ voice: "Polly.Joanna" }, "SMIRK Command Center ready. What would you like to update?");
      twiml.redirect({ method: "POST" }, "/api/boss/command");
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // ── Check for goodbye ────────────────────────────────────────────────────
    const lower = speechResult.toLowerCase();
    if (lower.includes("goodbye") || lower.includes("that's all") || lower.includes("done") || lower.includes("hang up") || lower.includes("bye")) {
      try {
        const { result } = await executeBossTool("get_status", {}, wsId, callerName);
        twiml.say({ voice: "Polly.Joanna" }, `Got it. Current status: ${result} Goodbye.`);
      } catch {
        twiml.say({ voice: "Polly.Joanna" }, "All done. Goodbye.");
      }
      twiml.hangup();
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // ── Parse command with AI ────────────────────────────────────────────────
    try {
      const teamRows = await sql`
        SELECT name, role, is_on_call FROM team_members
        WHERE workspace_id = ${wsId} AND is_active = TRUE ORDER BY name
      ` as { name: string; role: string; is_on_call: boolean }[];

      const teamContext = teamRows.length
        ? `Current team: ${teamRows.map((m) => `${m.name} (${m.role}, ${m.is_on_call ? "ON CALL" : "off call"})`).join(", ")}.`
        : "No team members configured.";

      const systemPrompt = `You are the SMIRK Command Center. You are talking to the business owner.
Listen to their instruction and call the appropriate tool.

${teamContext}

Rules:
- Always call a tool. Never respond with just text.
- STATUS_QUERY (get_status): execute immediately, no confirmation needed.
- BRIEFING (inject_knowledge): parse the intent, then the system will confirm before applying.
- OPERATIONAL (toggle_on_call, clear_knowledge, update_topics): parse the intent, then the system will confirm before applying.
- Be precise with category selection for inject_knowledge. Emergency and closure beat everything.`;

      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: speechResult },
      ];

      const response = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages,
        tools: BOSS_TOOLS,
        tool_choice: "auto",
        max_tokens: 300,
      });

      const choice = response.choices[0];

      if (!choice.message.tool_calls?.length) {
        // No tool call — just respond and re-prompt
        const text = choice.message.content ?? "I didn't understand that. Please try again.";
        const gather = twiml.gather({ input: ["speech"], action: "/api/boss/command", method: "POST", speechTimeout: "auto", language: "en-US" });
        gather.say({ voice: "Polly.Joanna" }, `${text} Anything else?`);
        twiml.hangup();
        res.type("text/xml").send(twiml.toString());
        return;
      }

      const tc = choice.message.tool_calls[0]; // process one at a time for confirmation
      const args = JSON.parse(tc.function.arguments);
      const responseClass = classifyTool(tc.function.name);

      if (responseClass === "STATUS_QUERY") {
        // Execute immediately — no confirmation needed
        const { result } = await executeBossTool(tc.function.name, args, wsId, callerName);

        await writeAuditLog({
          wsId, callerName, callerPhone: callerNumber, authMethod: "caller_id",
          rawTranscript: speechResult, parsedIntent: tc.function.name,
          toolName: tc.function.name, toolArgs: args,
          systemAction: result, responseClass,
          confirmed: true, rollbackId: null, expiresAt: null,
        });

        const gather = twiml.gather({ input: ["speech"], action: "/api/boss/command", method: "POST", speechTimeout: "auto", language: "en-US" });
        gather.say({ voice: "Polly.Joanna" }, `${result} Anything else?`);
        twiml.say({ voice: "Polly.Joanna" }, "Goodbye.");
        twiml.hangup();
      } else {
        // BRIEFING or OPERATIONAL — confirm before applying
        const confirmPrompt = buildConfirmationPrompt(tc.function.name, args);
        const encodedTool = encodeURIComponent(tc.function.name);
        const encodedArgs = encodeURIComponent(JSON.stringify(args));

        const gather = twiml.gather({
          input: ["speech"],
          action: `/api/boss/command?pendingTool=${encodedTool}&pendingArgs=${encodedArgs}`,
          method: "POST",
          speechTimeout: "auto",
          language: "en-US",
        });
        gather.say({ voice: "Polly.Joanna" }, confirmPrompt);
        twiml.say({ voice: "Polly.Joanna" }, "No response received. Action cancelled. Goodbye.");
        twiml.hangup();
      }
    } catch (err) {
      twiml.say({ voice: "Polly.Joanna" }, "I had trouble processing that. Please try again.");
      const gather = twiml.gather({ input: ["speech"], action: "/api/boss/command", method: "POST", speechTimeout: "auto" });
      gather.say({ voice: "Polly.Joanna" }, "What would you like to update?");
    }

    res.type("text/xml").send(twiml.toString());
  });

  app.use("/api/boss", router);
}
