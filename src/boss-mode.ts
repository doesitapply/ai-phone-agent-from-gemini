/**
 * Boss Mode — Verbal Command Center
 *
 * A dedicated Twilio number where the business owner calls in, authenticates
 * by caller ID (+ optional PIN), then speaks commands to control SMIRK:
 *
 *   - Toggle team member on-call status
 *   - Inject temporary knowledge (promos, closures, specials)
 *   - Query current system status
 *
 * The temporary_context table stores injected knowledge with auto-expiry (24h default).
 * Every customer-facing call queries this table and prepends active entries to the
 * agent's system prompt as "IMPORTANT TODAY: ..."
 */

import { Router, Request, Response } from "express";
import twilio from "twilio";
import OpenAI from "openai";
import { sql } from "./db.js";

const VoiceResponse = twilio.twiml.VoiceResponse;

// ── OpenAI client (for Boss Mode command parsing) ────────────────────────────
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const openai = new OpenAI({
  apiKey: OPENAI_KEY ?? GEMINI_KEY,
  baseURL: OPENAI_KEY
    ? "https://api.openai.com/v1"
    : "https://generativelanguage.googleapis.com/v1beta/openai",
});

// ── Boss Mode Tools ──────────────────────────────────────────────────────────
const BOSS_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "toggle_on_call",
      description: "Mark a team member as on-call or off-call",
      parameters: {
        type: "object",
        properties: {
          name_hint: {
            type: "string",
            description: "The name or partial name of the team member (e.g. 'Marcus', 'Sarah')",
          },
          on_call: {
            type: "boolean",
            description: "true = mark on-call, false = mark off-call",
          },
        },
        required: ["name_hint", "on_call"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inject_knowledge",
      description:
        "Inject a temporary briefing or knowledge update into the customer-facing AI (e.g. specials, closures, price changes). Expires in 24 hours by default.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The knowledge to inject (e.g. 'We are running a 20% off special on dental cleanings today only.')",
          },
          category: {
            type: "string",
            enum: ["briefing", "promo", "closure", "pricing", "policy", "other"],
            description: "Category of the knowledge",
          },
          is_permanent: {
            type: "boolean",
            description: "If true, this knowledge never expires. Default false (24h expiry).",
          },
          expires_hours: {
            type: "number",
            description: "Custom expiry in hours (default 24). Ignored if is_permanent is true.",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_knowledge",
      description: "Clear all active temporary knowledge/briefings",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Optional: only clear a specific category. If omitted, clears all.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_status",
      description: "Get current system status: who is on-call, active knowledge briefings, recent calls",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_topics",
      description: "Update which topics a team member handles",
      parameters: {
        type: "object",
        properties: {
          name_hint: {
            type: "string",
            description: "The name or partial name of the team member",
          },
          topics: {
            type: "array",
            items: { type: "string" },
            description: "Full replacement list of topics this person handles",
          },
        },
        required: ["name_hint", "topics"],
      },
    },
  },
];

// ── Tool Execution ───────────────────────────────────────────────────────────
async function executeBossTool(
  name: string,
  args: Record<string, unknown>,
  wsId: number,
  callerName: string
): Promise<string> {
  try {
    if (name === "toggle_on_call") {
      const hint = (args.name_hint as string).toLowerCase();
      const onCall = args.on_call as boolean;
      const rows = await sql`
        UPDATE team_members
        SET is_on_call = ${onCall}, updated_at = NOW()
        WHERE workspace_id = ${wsId}
          AND LOWER(name) LIKE ${"%" + hint + "%"}
          AND is_active = TRUE
        RETURNING name, role
      ` as { name: string; role: string }[];
      if (!rows.length) return `No active team member found matching "${args.name_hint}".`;
      const status = onCall ? "on-call" : "off-call";
      return rows.map((r) => `${r.name} (${r.role}) is now ${status}.`).join(" ");
    }

    if (name === "inject_knowledge") {
      const content = args.content as string;
      const category = (args.category as string) || "briefing";
      const isPermanent = (args.is_permanent as boolean) || false;
      const expiresHours = (args.expires_hours as number) || 24;
      const expiresAt = isPermanent ? null : new Date(Date.now() + expiresHours * 3600 * 1000);

      await sql`
        INSERT INTO temporary_context
          (workspace_id, content, category, source, is_permanent, expires_at, created_by)
        VALUES
          (${wsId}, ${content}, ${category}, 'boss_mode', ${isPermanent}, ${expiresAt}, ${callerName})
      `;
      const expiry = isPermanent ? "permanently" : `for ${expiresHours} hours`;
      return `Got it. I've updated the AI briefing ${expiry}: "${content}"`;
    }

    if (name === "clear_knowledge") {
      const category = args.category as string | undefined;
      if (category) {
        await sql`
          DELETE FROM temporary_context
          WHERE workspace_id = ${wsId} AND category = ${category}
        `;
        return `All ${category} briefings have been cleared.`;
      } else {
        await sql`DELETE FROM temporary_context WHERE workspace_id = ${wsId}`;
        return "All active briefings have been cleared.";
      }
    }

    if (name === "get_status") {
      const [onCallRows, briefingRows, recentCalls] = await Promise.all([
        sql`
          SELECT name, role, handles_topics FROM team_members
          WHERE workspace_id = ${wsId} AND is_on_call = TRUE AND is_active = TRUE
          ORDER BY priority DESC
        ` as { name: string; role: string; handles_topics: string[] | null }[],
        sql`
          SELECT content, category, expires_at FROM temporary_context
          WHERE workspace_id = ${wsId}
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY created_at DESC LIMIT 5
        ` as { content: string; category: string; expires_at: string | null }[],
        sql`
          SELECT direction, duration, created_at FROM calls
          WHERE workspace_id = ${wsId}
          ORDER BY created_at DESC LIMIT 3
        ` as { direction: string; duration: number; created_at: string }[],
      ]);

      let status = "";
      if (onCallRows.length) {
        status += `On call: ${onCallRows.map((r) => `${r.name} (${r.role})`).join(", ")}. `;
      } else {
        status += "No one is currently on call. ";
      }
      if (briefingRows.length) {
        status += `Active briefings: ${briefingRows.map((b) => b.content).join("; ")}. `;
      } else {
        status += "No active briefings. ";
      }
      if (recentCalls.length) {
        status += `Last ${recentCalls.length} calls: ${recentCalls
          .map((c) => `${c.direction} (${c.duration}s)`)
          .join(", ")}.`;
      }
      return status || "System is running normally.";
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
        RETURNING name
      ` as { name: string }[];
      if (!rows.length) return `No active team member found matching "${args.name_hint}".`;
      return `Updated topics for ${rows[0].name}: ${topics.join(", ")}.`;
    }

    return "Unknown command.";
  } catch (err) {
    return `Error executing command: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}

// ── Fetch active temporary context for customer-facing calls ─────────────────
export async function getActiveTemporaryContext(wsId: number): Promise<string> {
  try {
    const rows = await sql`
      SELECT content, category FROM temporary_context
      WHERE workspace_id = ${wsId}
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
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

  // GET /api/boss/settings — get Boss Mode config
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

  // POST /api/boss/settings — upsert Boss Mode config
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

  // GET /api/boss/context — get active temporary context entries
  router.get("/context", async (req: Request, res: Response) => {
    const wsId = (req as any).workspaceId ?? 1;
    try {
      const rows = await sql`
        SELECT id, content, category, is_permanent, expires_at, created_by, created_at
        FROM temporary_context
        WHERE workspace_id = ${wsId}
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
      `;
      res.json({ entries: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/boss/context — manually inject a briefing from the UI
  router.post("/context", async (req: Request, res: Response) => {
    const wsId = (req as any).workspaceId ?? 1;
    const { content, category, is_permanent, expires_hours } = req.body;
    if (!content) return res.status(400).json({ error: "content is required" });
    try {
      const isPermanent = is_permanent || false;
      const expiresHours = expires_hours || 24;
      const expiresAt = isPermanent ? null : new Date(Date.now() + expiresHours * 3600 * 1000);
      await sql`
        INSERT INTO temporary_context
          (workspace_id, content, category, source, is_permanent, expires_at, created_by)
        VALUES
          (${wsId}, ${content}, ${category || 'briefing'}, 'dashboard', ${isPermanent}, ${expiresAt}, 'Dashboard')
      `;
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/boss/context/:id — delete a specific context entry
  router.delete("/context/:id", async (req: Request, res: Response) => {
    const wsId = (req as any).workspaceId ?? 1;
    try {
      await sql`DELETE FROM temporary_context WHERE id = ${req.params.id} AND workspace_id = ${wsId}`;
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/boss/voice — Twilio webhook for Boss Mode inbound call
  router.post("/voice", async (req: Request, res: Response) => {
    const twiml = new VoiceResponse();
    const callerNumber = req.body.From ?? "";
    const wsId = 1; // TODO: multi-tenant lookup by Twilio number

    try {
      // Authenticate by caller ID
      const settings = await sql`
        SELECT boss_phone, boss_pin, enabled FROM boss_mode_settings
        WHERE workspace_id = ${wsId}
      ` as { boss_phone: string | null; boss_pin: string | null; enabled: boolean }[];

      const cfg = settings[0];

      if (!cfg?.enabled) {
        twiml.say({ voice: "Polly.Joanna" }, "Boss Mode is not enabled for this workspace.");
        twiml.hangup();
        res.type("text/xml").send(twiml.toString());
        return;
      }

      // Normalize phone numbers for comparison
      const normalizePhone = (p: string) => p.replace(/\D/g, "").slice(-10);
      const callerNorm = normalizePhone(callerNumber);
      const bossNorm = cfg.boss_phone ? normalizePhone(cfg.boss_phone) : null;

      if (bossNorm && callerNorm !== bossNorm) {
        twiml.say({ voice: "Polly.Joanna" }, "Unauthorized caller. Goodbye.");
        twiml.hangup();
        res.type("text/xml").send(twiml.toString());
        return;
      }

      // If PIN is configured, gather it
      if (cfg.boss_pin) {
        const gather = twiml.gather({
          numDigits: "4",
          action: "/api/boss/pin",
          method: "POST",
          timeout: 10,
        });
        gather.say({ voice: "Polly.Joanna" }, "Welcome back. Please enter your 4-digit PIN.");
      } else {
        // No PIN — go straight to command mode
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
      const settings = await sql`
        SELECT boss_pin FROM boss_mode_settings WHERE workspace_id = ${wsId}
      ` as { boss_pin: string | null }[];

      if (settings[0]?.boss_pin && enteredPin !== settings[0].boss_pin) {
        twiml.say({ voice: "Polly.Joanna" }, "Incorrect PIN. Goodbye.");
        twiml.hangup();
      } else {
        twiml.redirect({ method: "POST" }, "/api/boss/command");
      }
    } catch {
      twiml.say({ voice: "Polly.Joanna" }, "System error. Please try again.");
      twiml.hangup();
    }

    res.type("text/xml").send(twiml.toString());
  });

  // POST /api/boss/command — main command loop (Gather → AI → TTS → loop)
  router.post("/command", async (req: Request, res: Response) => {
    const twiml = new VoiceResponse();
    const wsId = 1;
    const speechResult = req.body.SpeechResult ?? "";
    const callerNumber = req.body.From ?? "Boss";

    // Get caller name from team roster
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

    if (!speechResult) {
      // First call or re-prompt — ask for a command
      const gather = twiml.gather({
        input: ["speech"],
        action: "/api/boss/command",
        method: "POST",
        speechTimeout: "auto",
        language: "en-US",
        hints: "on call, off call, special, promo, closure, status, who is on call",
      });
      gather.say(
        { voice: "Polly.Joanna" },
        "SMIRK Command Center ready. What would you like to update?"
      );
      twiml.redirect({ method: "POST" }, "/api/boss/command");
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // Check for "done" / "goodbye" / "that's all"
    const lower = speechResult.toLowerCase();
    if (
      lower.includes("goodbye") ||
      lower.includes("that's all") ||
      lower.includes("done") ||
      lower.includes("hang up") ||
      lower.includes("bye")
    ) {
      // Get final status summary
      try {
        const summary = await executeBossTool("get_status", {}, wsId, callerName);
        twiml.say({ voice: "Polly.Joanna" }, `Got it. Current status: ${summary} Goodbye.`);
      } catch {
        twiml.say({ voice: "Polly.Joanna" }, "All done. Goodbye.");
      }
      twiml.hangup();
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // Parse command with AI
    try {
      // Get current team roster for context
      const teamRows = await sql`
        SELECT name, role, is_on_call FROM team_members
        WHERE workspace_id = ${wsId} AND is_active = TRUE
        ORDER BY name
      ` as { name: string; role: string; is_on_call: boolean }[];

      const teamContext = teamRows.length
        ? `Current team: ${teamRows.map((m) => `${m.name} (${m.role}, ${m.is_on_call ? "ON CALL" : "off call"})`).join(", ")}.`
        : "No team members configured yet.";

      const systemPrompt = `You are the SMIRK Command Center. You are talking to the business owner.
Your job is to listen to their verbal instructions and call the appropriate tool to update the system.

${teamContext}

Rules:
- Always call a tool based on the instruction. Do not just respond with text.
- If the instruction is ambiguous, make the most reasonable interpretation.
- After calling the tool, you will receive the result and should confirm it back to the owner.
- Be brief and professional.`;

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
      let replyText = "";

      if (choice.message.tool_calls?.length) {
        // Execute all tool calls
        const results: string[] = [];
        for (const tc of choice.message.tool_calls) {
          const args = JSON.parse(tc.function.arguments);
          const result = await executeBossTool(tc.function.name, args, wsId, callerName);
          results.push(result);
        }
        replyText = results.join(" ");
      } else {
        replyText = choice.message.content ?? "Command processed.";
      }

      // Speak the result and prompt for next command
      const gather = twiml.gather({
        input: ["speech"],
        action: "/api/boss/command",
        method: "POST",
        speechTimeout: "auto",
        language: "en-US",
      });
      gather.say({ voice: "Polly.Joanna" }, `${replyText} Anything else?`);
      // If no speech, hang up
      twiml.say({ voice: "Polly.Joanna" }, "No further commands. Goodbye.");
      twiml.hangup();
    } catch (err) {
      twiml.say({ voice: "Polly.Joanna" }, "I had trouble processing that. Please try again.");
      const gather = twiml.gather({
        input: ["speech"],
        action: "/api/boss/command",
        method: "POST",
        speechTimeout: "auto",
      });
      gather.say({ voice: "Polly.Joanna" }, "What would you like to update?");
    }

    res.type("text/xml").send(twiml.toString());
  });

  app.use("/api/boss", router);
}
