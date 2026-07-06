import type { Express, Request, RequestHandler, Response } from "express";
import { getMockActiveCalls, getMockCall, getMockCalls, getMockMessages } from "../mock-db.js";

type TtsAudioEntry = {
  buffer: Buffer;
  expires: number;
  contentType: string;
};

type CallRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  env: {
    GEMINI_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    ELEVENLABS_API_KEY?: string;
  };
  getWorkspaceId: (req: Request) => number;
  fixStaleCalls: () => Promise<{ scanned: number; fixed: number; callSids: string[]; durationMs: number }>;
  resolveWorkspaceAiKeys: (workspaceId: number, fallback: {
    geminiApiKey?: string;
    openrouterApiKey?: string;
    elevenLabsApiKey?: string;
  }) => Promise<{ geminiApiKey?: string | null }>;
  runPostCallIntelligence: (callSid: string, contactId: number | null, geminiApiKey?: string | null) => Promise<unknown>;
  ttsAudioStore: Map<string, TtsAudioEntry>;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerCallRoutes(app: Express, deps: CallRouteDeps): void {
  const {
    dashboardAuth,
    requireOperator,
    sql,
    dbEnabled,
    env,
    getWorkspaceId,
    fixStaleCalls,
    resolveWorkspaceAiKeys,
    runPostCallIntelligence,
    ttsAudioStore,
    log,
  } = deps;

  app.get("/api/calls", dashboardAuth, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    if (!dbEnabled) return res.json({ calls: getMockCalls() });
    const wsId = getWorkspaceId(req);
    const calls = await sql`
      SELECT
             c.id,
             c.call_sid,
             c.direction,
             c.to_number,
             c.from_number,
             c.status,
             c.started_at,
             c.ended_at,
             c.duration_seconds,
             c.agent_name,
             mc.message_count,
             co.name as contact_name,
             cs.intent, cs.outcome, cs.summary as call_summary, cs.resolution_score as summary_score,
             cs.next_action, cs.sentiment
      FROM calls c
      LEFT JOIN (
        SELECT call_sid, COUNT(id) as message_count
        FROM messages WHERE role != 'system'
        GROUP BY call_sid
      ) mc ON c.call_sid = mc.call_sid
      LEFT JOIN contacts co ON c.contact_id = co.id
      LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid
      WHERE c.workspace_id = ${wsId}
      ORDER BY c.started_at DESC
      LIMIT 100
    `;
    res.json({ calls });
  });

  app.post("/api/calls/fix-stale", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    const { scanned, fixed, callSids } = await fixStaleCalls();
    res.json({ scanned, fixed, callSids });
  });

  app.patch("/api/calls/fix-stale", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const wsId = getWorkspaceId(req);
    const stale = await sql`
      SELECT call_sid FROM calls
      WHERE workspace_id = ${wsId}
        AND status = 'in-progress'
        AND started_at < NOW() - INTERVAL '30 minutes'
    `;
    const staleSids = stale.map((r: any) => r.call_sid);
    if (staleSids.length > 0) {
      await sql`
        UPDATE calls SET status = 'failed', ended_at = NOW()
        WHERE call_sid = ANY(${staleSids}::text[]) AND workspace_id = ${wsId}
      `;
    }
    const orphaned = await sql`
      UPDATE calls SET status = 'failed', ended_at = NOW()
      WHERE workspace_id = ${wsId} AND status = 'in-progress' AND started_at IS NULL
      RETURNING call_sid
    `;
    const allFixed = [...staleSids, ...orphaned.map((r: any) => r.call_sid)];
    res.json({ fixed: allFixed.length, sids: allFixed });
  });

  app.delete("/api/calls/:sid", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const { sid } = req.params;
    const wsId = getWorkspaceId(req);
    await sql`DELETE FROM messages WHERE call_sid = ${sid}`;
    await sql`DELETE FROM call_events WHERE call_sid = ${sid}`;
    await sql`DELETE FROM call_summaries WHERE call_sid = ${sid}`;
    const result = await sql`DELETE FROM calls WHERE call_sid = ${sid} AND workspace_id = ${wsId} RETURNING call_sid`;
    if (result.length === 0) return res.status(404).json({ error: "Call not found" });
    res.json({ deleted: sid });
  });

  app.post("/api/calls/:sid/reprocess", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const { sid } = req.params;
    const wsId = getWorkspaceId(req);
    const rows = await sql`SELECT * FROM calls WHERE call_sid = ${sid} AND workspace_id = ${wsId}`;
    if (rows.length === 0) return res.status(404).json({ error: "Call not found" });
    const call = rows[0];
    await sql`DELETE FROM call_summaries WHERE call_sid = ${sid}`;
    res.json({ status: "reprocessing", callSid: sid });
    setImmediate(async () => {
      try {
        const reprocessWsId = (call.workspace_id as number) || wsId || 1;
        const reprocessKeys = await resolveWorkspaceAiKeys(reprocessWsId, {
          geminiApiKey: env.GEMINI_API_KEY,
          openrouterApiKey: env.OPENROUTER_API_KEY,
          elevenLabsApiKey: env.ELEVENLABS_API_KEY,
        });
        await runPostCallIntelligence(sid, call.contact_id || null, reprocessKeys.geminiApiKey);
        log("info", "Reprocess complete", { callSid: sid, workspaceId: reprocessWsId });
      } catch (err: any) {
        log("error", "Reprocess failed", { callSid: sid, error: err.message });
      }
    });
  });

  app.delete("/api/calls", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    const wsId = getWorkspaceId(req);
    const { filter, sids } = req.query as { filter?: string; sids?: string };
    let deletedSids: string[] = [];

    if (sids) {
      const sidList = sids.split(",").map((s) => s.trim()).filter(Boolean);
      for (const sid of sidList) {
        await sql`DELETE FROM messages WHERE call_sid = ${sid}`;
        await sql`DELETE FROM call_events WHERE call_sid = ${sid}`;
        await sql`DELETE FROM call_summaries WHERE call_sid = ${sid}`;
      }
      const result = await sql`DELETE FROM calls WHERE call_sid = ANY(${sidList}::text[]) AND workspace_id = ${wsId} RETURNING call_sid`;
      deletedSids = result.map((r: any) => r.call_sid);
    } else if (filter === "stale") {
      const stale = await sql`SELECT call_sid FROM calls WHERE workspace_id = ${wsId} AND (duration_seconds IS NULL OR duration_seconds = 0) AND status != 'in-progress'`;
      const staleSids = stale.map((r: any) => r.call_sid);
      if (staleSids.length > 0) {
        for (const sid of staleSids) {
          await sql`DELETE FROM messages WHERE call_sid = ${sid}`;
          await sql`DELETE FROM call_events WHERE call_sid = ${sid}`;
          await sql`DELETE FROM call_summaries WHERE call_sid = ${sid}`;
        }
        await sql`DELETE FROM calls WHERE call_sid = ANY(${staleSids}::text[]) AND workspace_id = ${wsId}`;
        deletedSids = staleSids;
      }
    } else if (filter === "all") {
      const all = await sql`SELECT call_sid FROM calls WHERE workspace_id = ${wsId}`;
      const allSids = all.map((r: any) => r.call_sid);
      if (allSids.length > 0) {
        await sql`DELETE FROM messages WHERE call_sid = ANY(${allSids}::text[])`;
        await sql`DELETE FROM call_events WHERE call_sid = ANY(${allSids}::text[])`;
        await sql`DELETE FROM call_summaries WHERE call_sid = ANY(${allSids}::text[])`;
        await sql`DELETE FROM calls WHERE workspace_id = ${wsId}`;
        deletedSids = allSids;
      }
    } else {
      return res.status(400).json({ error: "Provide filter=stale|all or sids=CA1,CA2" });
    }

    res.json({ deleted: deletedSids.length, sids: deletedSids });
  });

  app.get("/api/tts/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    const entry = ttsAudioStore.get(id);
    if (!entry || entry.expires < Date.now()) {
      return res.status(404).send("Audio not found or expired");
    }
    res.set({
      "Content-Type": entry.contentType || "audio/mpeg",
      "Content-Length": entry.buffer.length,
      "Cache-Control": "no-cache",
    });
    res.send(entry.buffer);
  });

  app.get("/api/calls/active", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) return res.json(getMockActiveCalls());
      const wsId = getWorkspaceId(req);
      const activeCalls = await sql`
        SELECT c.call_sid, c.from_number, c.started_at, c.direction, c.turn_count,
               co.name as contact_name
        FROM calls c
        LEFT JOIN contacts co ON c.contact_id = co.id
        WHERE c.status = 'in-progress' AND c.workspace_id = ${wsId}
        ORDER BY c.started_at DESC
      `;
      res.json(activeCalls);
    } catch (err: any) {
      log("error", "Active calls endpoint failed", { error: err?.message || String(err) });
      res.status(500).json({ error: err?.message || "Failed to load active calls" });
    }
  });

  app.get("/api/calls/:callSid/messages", dashboardAuth, async (req: Request, res: Response) => {
    const { callSid } = req.params;
    if (!/^CA[a-f0-9]{32}$/i.test(callSid)) return res.status(400).json({ error: "Invalid call SID format." });
    if (!dbEnabled) {
      if (!getMockCall(callSid)) return res.status(404).json({ error: "Call not found." });
      return res.json({ messages: getMockMessages(callSid) });
    }
    const wsId = getWorkspaceId(req);
    const callRows = await sql`SELECT call_sid FROM calls WHERE call_sid = ${callSid} AND workspace_id = ${wsId}`;
    if (!callRows.length) return res.status(404).json({ error: "Call not found." });
    const messages = await sql`
      SELECT id, role, text, created_at
      FROM messages
      WHERE call_sid = ${callSid} AND role != 'system'
      ORDER BY id ASC
    `;
    res.json({ messages });
  });

  app.get("/api/calls/:sid/transcript", dashboardAuth, async (req: Request, res: Response) => {
    const { sid } = req.params;
    if (!/^CA[a-f0-9]{32}$/i.test(sid)) return res.status(400).json({ error: "Invalid call SID format." });
    if (!dbEnabled) {
      if (!getMockCall(sid)) return res.status(404).json({ error: "Call not found.", callSid: sid });
      const lines = getMockMessages(sid)
        .filter((m: any) => m.role === "user" || m.role === "assistant")
        .map((m: any) => ({
          speaker: m.role === "user" ? "Caller" : "Agent",
          text: m.text,
          time: m.created_at,
        }));
      return res.json({ callSid: sid, transcript: lines });
    }
    const wsId = getWorkspaceId(req);
    const callExists = await sql`SELECT call_sid FROM calls WHERE call_sid = ${sid} AND workspace_id = ${wsId} LIMIT 1`;
    if (!callExists.length) return res.status(404).json({ error: "Call not found.", callSid: sid });
    const messages = await sql`
      SELECT role, text, created_at FROM messages
      WHERE call_sid = ${sid} AND role IN ('user', 'assistant')
      ORDER BY id ASC
    `;
    const lines = messages.map((m: any) => ({
      speaker: m.role === 'user' ? 'Caller' : 'Agent',
      text: m.text,
      time: m.created_at,
    }));
    res.json({ callSid: sid, transcript: lines });
  });

  app.get("/api/calls/:sid/recording", dashboardAuth, async (req: Request, res: Response) => {
    const { sid } = req.params;
    if (!/^CA[a-f0-9]{32}$/i.test(sid)) return res.status(400).json({ error: "Invalid call SID format." });
    if (!dbEnabled) {
      if (!getMockCall(sid)) return res.status(404).json({ error: "Call not found." });
      return res.json({ recordings: [] });
    }
    const wsId = getWorkspaceId(req);
    const callRows = await sql`SELECT call_sid FROM calls WHERE call_sid = ${sid} AND workspace_id = ${wsId} LIMIT 1`;
    if (!callRows.length) return res.status(404).json({ error: "Call not found." });
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) return res.status(503).json({ error: "Twilio not configured" });
    try {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings.json?CallSid=${sid}`,
        { headers: { Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') } }
      );
      const data = await response.json() as any;
      const recordings = data.recordings || [];
      if (recordings.length === 0) return res.json({ recordings: [] });
      res.json({
        recordings: recordings.map((r: any) => ({
          sid: r.sid,
          duration: r.duration,
          url: `/api/recordings/${r.sid}/audio?callSid=${encodeURIComponent(sid)}`,
          created_at: r.date_created,
        }))
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/recordings/:sid/audio", dashboardAuth, async (req: Request, res: Response) => {
    const { sid } = req.params;
    const callSid = String(req.query.callSid || "");
    if (!/^RE[a-f0-9]{32}$/i.test(sid)) return res.status(400).json({ error: "Invalid recording SID format." });
    if (!/^CA[a-f0-9]{32}$/i.test(callSid)) return res.status(400).json({ error: "Invalid call SID format." });
    const wsId = getWorkspaceId(req);
    const callRows = await sql`SELECT call_sid FROM calls WHERE call_sid = ${callSid} AND workspace_id = ${wsId} LIMIT 1`;
    if (!callRows.length) return res.status(404).json({ error: "Call not found." });
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) return res.status(503).json({ error: "Twilio not configured" });
    try {
      const recordingResponse = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${sid}.json`,
        { headers: { Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') } }
      );
      if (!recordingResponse.ok) return res.status(recordingResponse.status).json({ error: 'Recording not found' });
      const recording = await recordingResponse.json() as any;
      if (recording.call_sid !== callSid) return res.status(404).json({ error: 'Recording not found' });

      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${sid}.mp3`;
      const upstream = await fetch(twilioUrl, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') }
      });
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Recording not found' });
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
      const cl = upstream.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      const reader = upstream.body?.getReader();
      if (!reader) return res.status(500).end();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          if (!res.write(value)) await new Promise(r => res.once('drain', r));
        }
      };
      pump().catch(() => res.end());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
