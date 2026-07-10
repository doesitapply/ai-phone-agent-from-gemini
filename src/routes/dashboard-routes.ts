import type { Express, Request, RequestHandler, Response } from "express";
import { getMockCallIntelligence, getMockCalls, getMockStats } from "../mock-db.js";

type DashboardRouteDeps = {
  dashboardAuth: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  getWorkspaceId: (req: Request) => number;
  log: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
};

export function registerDashboardRoutes(app: Express, deps: DashboardRouteDeps): void {
  const { dashboardAuth, sql, dbEnabled, getWorkspaceId, log } = deps;

  app.get("/api/stats", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) return res.json(getMockStats());
      const wsId = getWorkspaceId(req);
      const [totalCalls, activeCalls, totalContacts, openTasks, avgDuration, fieldsCaptured, dncCount, pendingHandoffs, todayCalls, weekCalls, bookedCalls, resolvedCalls, avgResolution] = await Promise.all([
        sql<{ count: string }[]>`SELECT COUNT(*) as count FROM calls WHERE workspace_id = ${wsId}`,
        sql<{ count: string }[]>`SELECT COUNT(*) as count FROM calls WHERE status = 'in-progress' AND workspace_id = ${wsId}`,
        sql<{ count: string }[]>`SELECT COUNT(*) as count FROM contacts WHERE workspace_id = ${wsId} AND name IS NOT NULL AND TRIM(name) != ''`,
        sql<{ count: string }[]>`SELECT COUNT(*) as count FROM tasks WHERE status = 'open' AND workspace_id = ${wsId}`,
        sql<{ avg: string }[]>`SELECT AVG(duration_seconds) as avg FROM calls WHERE status = 'completed' AND workspace_id = ${wsId}`,
        sql<{ count: string }[]>`SELECT COUNT(DISTINCT contact_id) as count FROM contact_custom_fields WHERE workspace_id = ${wsId}`,
        sql<{ count: string }[]>`SELECT COUNT(*) as count FROM contacts WHERE do_not_call = TRUE AND workspace_id = ${wsId}`,
        sql<{ count: string }[]>`SELECT COUNT(*) as count FROM handoffs WHERE status = 'pending' AND workspace_id = ${wsId}`,
        sql<{ count: string }[]>`SELECT COUNT(*) as count FROM calls WHERE started_at >= NOW() - INTERVAL '1 day' AND workspace_id = ${wsId}`,
        sql<{ count: string }[]>`SELECT COUNT(*) as count FROM calls WHERE started_at >= NOW() - INTERVAL '7 days' AND workspace_id = ${wsId}`,
        sql<{ count: string }[]>`SELECT COUNT(*) as count FROM call_summaries WHERE outcome = 'appointment_booked' AND workspace_id = ${wsId}`,
        sql<{ count: string }[]>`SELECT COUNT(*) as count FROM call_summaries WHERE outcome NOT IN ('incomplete','escalated') AND workspace_id = ${wsId}`,
        sql<{ avg: string }[]>`SELECT AVG(resolution_score) as avg FROM call_summaries WHERE workspace_id = ${wsId}`,
      ]);
      const aiLatency = await sql<{ avg: string }[]>`SELECT AVG(ai_latency_ms) as avg FROM calls WHERE workspace_id = ${wsId} AND ai_latency_ms IS NOT NULL AND ai_latency_ms > 0`.catch(() => [{ avg: '0' }]);
      const total = Number(totalCalls[0]?.count || 0);
      const sentimentCounts = await sql<{ sentiment: string; count: string }[]>`
        SELECT cs.sentiment, COUNT(*) as count
        FROM call_summaries cs
        WHERE cs.workspace_id = ${wsId} AND cs.sentiment IS NOT NULL
        GROUP BY cs.sentiment
      `;
      const sentimentMap: Record<string, number> = {};
      for (const row of sentimentCounts) {
        sentimentMap[row.sentiment] = Number(row.count);
      }
      const booked = Number(bookedCalls[0]?.count || 0);
      const resolved = Number(resolvedCalls[0]?.count || 0);
      const contactsWithEmail = await sql<{ count: string }[]>`SELECT COUNT(*) as count FROM contacts WHERE email IS NOT NULL AND workspace_id = ${wsId}`;
      const namedContacts = await sql<{ count: string }[]>`SELECT COUNT(*) as count FROM contacts WHERE name IS NOT NULL AND workspace_id = ${wsId}`;
      const callbackTasks = await sql<{ count: string }[]>`SELECT COUNT(*) as count FROM tasks WHERE task_type = 'callback' AND status = 'open' AND workspace_id = ${wsId}`;
      res.json({
        totalCalls: total,
        activeCalls: Number(activeCalls[0]?.count || 0),
        totalContacts: Number(totalContacts[0]?.count || 0),
        contactsWithEmail: Number(contactsWithEmail[0]?.count || 0),
        namedContacts: Number(namedContacts[0]?.count || 0),
        openTasks: Number(openTasks[0]?.count || 0),
        callbackTasks: Number(callbackTasks[0]?.count || 0),
        avgCallDuration: Math.round(Number(avgDuration[0]?.avg || 0)),
        fieldsCaptured: Number(fieldsCaptured[0]?.count || 0),
        dncCount: Number(dncCount[0]?.count || 0),
        pendingHandoffs: Number(pendingHandoffs[0]?.count || 0),
        todayCalls: Number(todayCalls[0]?.count || 0),
        weekCalls: Number(weekCalls[0]?.count || 0),
        bookedCalls: booked,
        resolvedCalls: resolved,
        conversionRate: total > 0 ? Math.round((booked / total) * 100) : 0,
        qualificationRate: total > 0 ? Math.round((resolved / total) * 100) : 0,
        avgResolutionScore: Math.round(Number(avgResolution[0]?.avg || 0) * 100) / 100,
        aiLatencyMs: Math.round(Number(aiLatency[0]?.avg || 0)),
        avgDurationSeconds: Math.round(Number(avgDuration[0]?.avg || 0)),
        avgAiLatencyMs: 0,
        avgFieldConfidence: null,
        dataCaptureCoverage: total > 0 ? Math.round((Number(namedContacts[0]?.count || 0) / total) * 100) : 0,
        fieldsExtracted: Number(fieldsCaptured[0]?.count || 0),
        sentiment: {
          positive: sentimentMap['positive'] || 0,
          neutral: sentimentMap['neutral'] || 0,
          negative: sentimentMap['negative'] || 0,
          frustrated: sentimentMap['frustrated'] || 0,
        },
      });
    } catch (err: any) {
      log("error", "Stats endpoint failed", { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/call-intelligence", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        const mock = getMockCallIntelligence();
        return res.json({
          windowDays: 30,
          totalCalls: mock.totalPending,
          summarizedCalls: mock.totalPending,
          transcriptCalls: mock.totalPending,
          recordedCalls: 0,
          qaReadyCalls: mock.totalPending,
          qaPassCalls: 1,
          avgResolutionScore: 0.91,
          summaryCoverage: 100,
          transcriptCoverage: 100,
          recordingCoverage: 0,
          qaPassRate: 50,
          outcomeCounts: { callback_needed: 2, lead_captured: 1 },
          sentimentCounts: { urgent: 1, concerned: 1, neutral: 1 },
          reviewQueue: mock.pendingReview,
        });
      }

      const wsId = getWorkspaceId(req);
      const windowDays = Math.max(1, Math.min(90, parseInt(String(req.query.days || "30"), 10) || 30));
      const [
        totalsR,
        outcomeR,
        sentimentR,
        reviewRows,
      ] = await Promise.all([
        sql<any[]>`
          WITH scoped_calls AS (
            SELECT c.call_sid, c.recording_url, cs.summary, cs.outcome, cs.resolution_score
            FROM calls c
            LEFT JOIN call_summaries cs ON cs.call_sid = c.call_sid AND cs.workspace_id = c.workspace_id
            WHERE c.workspace_id = ${wsId}
              AND c.started_at >= NOW() - make_interval(days => ${windowDays})
          ),
          transcript_calls AS (
            SELECT DISTINCT m.call_sid
            FROM messages m
            JOIN scoped_calls c ON c.call_sid = m.call_sid
            WHERE m.role IN ('user', 'assistant')
          )
          SELECT
            COUNT(*)::int AS total_calls,
            COUNT(*) FILTER (WHERE summary IS NOT NULL AND TRIM(summary) != '')::int AS summarized_calls,
            COUNT(*) FILTER (WHERE recording_url IS NOT NULL AND TRIM(recording_url) != '')::int AS recorded_calls,
            COUNT(*) FILTER (WHERE call_sid IN (SELECT call_sid FROM transcript_calls))::int AS transcript_calls,
            COUNT(*) FILTER (WHERE summary IS NOT NULL AND TRIM(summary) != '' AND call_sid IN (SELECT call_sid FROM transcript_calls))::int AS qa_ready_calls,
            COUNT(*) FILTER (
              WHERE summary IS NOT NULL
                AND TRIM(summary) != ''
                AND call_sid IN (SELECT call_sid FROM transcript_calls)
                AND COALESCE(resolution_score, 0) >= 0.7
                AND COALESCE(outcome, '') NOT IN ('incomplete', 'failed')
            )::int AS qa_pass_calls,
            AVG(resolution_score) AS avg_resolution_score
          FROM scoped_calls
        `,
        sql<any[]>`
          SELECT COALESCE(cs.outcome, 'unknown') AS outcome, COUNT(*)::int AS count
          FROM calls c
          LEFT JOIN call_summaries cs ON cs.call_sid = c.call_sid AND cs.workspace_id = c.workspace_id
          WHERE c.workspace_id = ${wsId}
            AND c.started_at >= NOW() - make_interval(days => ${windowDays})
          GROUP BY COALESCE(cs.outcome, 'unknown')
          ORDER BY count DESC
        `,
        sql<any[]>`
          SELECT COALESCE(cs.sentiment, 'unknown') AS sentiment, COUNT(*)::int AS count
          FROM calls c
          LEFT JOIN call_summaries cs ON cs.call_sid = c.call_sid AND cs.workspace_id = c.workspace_id
          WHERE c.workspace_id = ${wsId}
            AND c.started_at >= NOW() - make_interval(days => ${windowDays})
          GROUP BY COALESCE(cs.sentiment, 'unknown')
          ORDER BY count DESC
        `,
        sql<any[]>`
          WITH message_counts AS (
            SELECT call_sid, COUNT(*)::int AS message_count
            FROM messages
            WHERE role IN ('user', 'assistant')
            GROUP BY call_sid
          ),
          handoff_counts AS (
            SELECT call_sid, COUNT(*)::int AS handoff_count, MAX(status) AS latest_handoff_status
            FROM handoffs
            WHERE workspace_id = ${wsId}
            GROUP BY call_sid
          ),
          task_counts AS (
            SELECT call_sid, COUNT(*)::int AS task_count
            FROM tasks
            WHERE workspace_id = ${wsId}
            GROUP BY call_sid
          )
          SELECT
            c.id,
            c.call_sid,
            c.direction,
            c.from_number,
            c.status,
            c.started_at,
            c.duration_seconds,
            c.agent_name,
            c.recording_url,
            co.name AS contact_name,
            cs.outcome,
            cs.sentiment,
            cs.resolution_score,
            cs.summary AS call_summary,
            cs.next_action,
            COALESCE(mc.message_count, 0)::int AS message_count,
            COALESCE(hc.handoff_count, 0)::int AS handoff_count,
            hc.latest_handoff_status,
            COALESCE(tc.task_count, 0)::int AS task_count
          FROM calls c
          LEFT JOIN call_summaries cs ON cs.call_sid = c.call_sid AND cs.workspace_id = c.workspace_id
          LEFT JOIN contacts co ON co.id = c.contact_id AND co.workspace_id = c.workspace_id
          LEFT JOIN message_counts mc ON mc.call_sid = c.call_sid
          LEFT JOIN handoff_counts hc ON hc.call_sid = c.call_sid
          LEFT JOIN task_counts tc ON tc.call_sid = c.call_sid
          WHERE c.workspace_id = ${wsId}
            AND c.started_at >= NOW() - make_interval(days => ${windowDays})
            AND (
              cs.summary IS NULL
              OR TRIM(cs.summary) = ''
              OR COALESCE(mc.message_count, 0) < 2
              OR COALESCE(cs.resolution_score, 0) < 0.7
              OR cs.outcome IN ('incomplete', 'escalated', 'callback_needed')
              OR cs.sentiment IN ('negative', 'frustrated', 'angry')
              OR COALESCE(hc.handoff_count, 0) > 0
            )
          ORDER BY c.started_at DESC
          LIMIT 12
        `,
      ]);

      const totals = totalsR[0] || {};
      const totalCalls = Number(totals.total_calls || 0);
      const summarizedCalls = Number(totals.summarized_calls || 0);
      const transcriptCalls = Number(totals.transcript_calls || 0);
      const recordedCalls = Number(totals.recorded_calls || 0);
      const qaReadyCalls = Number(totals.qa_ready_calls || 0);
      const qaPassCalls = Number(totals.qa_pass_calls || 0);
      const pct = (n: number, d: number) => d > 0 ? Math.round((n / d) * 100) : 0;
      const countMap = (rows: any[], key: string): Record<string, number> => Object.fromEntries(
        rows.map((row) => [String(row[key] || "unknown"), Number(row.count || 0)])
      );
      const issueReasonsFor = (row: any) => {
        const reasons: Array<{ code: string; label: string; detail: string; severity: "warning" | "critical" }> = [];
        const summary = String(row.call_summary || "").trim();
        const messageCount = Number(row.message_count || 0);
        const resolutionScore = row.resolution_score == null ? null : Number(row.resolution_score);
        const outcome = String(row.outcome || "");
        const sentiment = String(row.sentiment || "");
        const handoffCount = Number(row.handoff_count || 0);

        if (!summary) {
          reasons.push({
            code: "missing_summary",
            label: "Missing summary",
            detail: "No post-call summary exists, so the owner cannot quickly understand what happened.",
            severity: "critical",
          });
        }
        if (messageCount < 2) {
          reasons.push({
            code: "short_transcript",
            label: "Short transcript",
            detail: "The call has fewer than two caller/assistant messages; verify whether the conversation actually connected.",
            severity: "warning",
          });
        }
        if (resolutionScore != null && resolutionScore < 0.7) {
          reasons.push({
            code: "low_confidence",
            label: "Low confidence",
            detail: `Resolution confidence is ${Math.round(resolutionScore * 100)}%; review the transcript and reprocess if the summary looks wrong.`,
            severity: "warning",
          });
        }
        if (["incomplete", "escalated", "callback_needed"].includes(outcome)) {
          reasons.push({
            code: `outcome_${outcome}`,
            label: outcome.replace(/_/g, " "),
            detail: "The call outcome indicates owner follow-up or manual review is still needed.",
            severity: outcome === "escalated" ? "critical" : "warning",
          });
        }
        if (["negative", "frustrated", "angry"].includes(sentiment)) {
          reasons.push({
            code: `sentiment_${sentiment}`,
            label: `${sentiment} caller`,
            detail: "Caller sentiment was flagged; check whether a human follow-up is needed.",
            severity: sentiment === "angry" ? "critical" : "warning",
          });
        }
        if (handoffCount > 0) {
          reasons.push({
            code: "handoff_present",
            label: "Human handoff",
            detail: "A handoff exists for this call; verify ownership and close the loop.",
            severity: "critical",
          });
        }
        return reasons;
      };

      res.json({
        windowDays,
        totalCalls,
        summarizedCalls,
        transcriptCalls,
        recordedCalls,
        qaReadyCalls,
        qaPassCalls,
        avgResolutionScore: totals.avg_resolution_score == null ? null : Math.round(Number(totals.avg_resolution_score) * 100),
        summaryCoverage: pct(summarizedCalls, totalCalls),
        transcriptCoverage: pct(transcriptCalls, totalCalls),
        recordingCoverage: pct(recordedCalls, totalCalls),
        qaPassRate: pct(qaPassCalls, qaReadyCalls),
        outcomeCounts: countMap(outcomeR, "outcome"),
        sentimentCounts: countMap(sentimentR, "sentiment"),
        reviewQueue: reviewRows.map((row) => ({
          id: row.id,
          callSid: row.call_sid,
          direction: row.direction,
          fromNumber: row.from_number,
          status: row.status,
          startedAt: row.started_at,
          durationSeconds: row.duration_seconds,
          agentName: row.agent_name,
          contactName: row.contact_name,
          outcome: row.outcome,
          sentiment: row.sentiment,
          resolutionScore: row.resolution_score == null ? null : Number(row.resolution_score),
          summary: row.call_summary,
          nextAction: row.next_action,
          messageCount: Number(row.message_count || 0),
          handoffCount: Number(row.handoff_count || 0),
          latestHandoffStatus: row.latest_handoff_status,
          taskCount: Number(row.task_count || 0),
          hasRecording: Boolean(row.recording_url),
          issueReasons: issueReasonsFor(row),
        })),
      });
    } catch (err: any) {
      log("error", "Call intelligence endpoint failed", { error: err?.message || String(err) });
      res.status(500).json({ error: err?.message || "Failed to load call intelligence" });
    }
  });

  app.get("/api/triage", dashboardAuth, async (req: Request, res: Response) => {
    try {
      if (!dbEnabled) {
        const limit = Math.max(20, Math.min(200, parseInt(String(req.query.limit || "80"), 10) || 80));
        const days = Math.max(1, Math.min(30, parseInt(String(req.query.days || "7"), 10) || 7));
        const recentCalls = getMockCalls().slice(0, limit);
        const recovery = recentCalls.filter((call: any) => call.outcome === "callback_needed");
        const incidents = recovery.map((call: any, index: number) => ({
          kind: "recovery",
          priority: index === 0 ? "P0" : "P1",
          label: "Recovered missed call: callback needed",
          call_sid: call.call_sid,
          at: call.started_at,
          contact_name: call.contact_name,
          from_number: call.from_number,
          status: "open",
        }));
        return res.json({
          ok: true,
          noDbDemo: true,
          window: { days, limit },
          incidents,
          recovery,
          activeCalls: [],
          recentCalls,
        });
      }
      const wsId = getWorkspaceId(req);
      const limit = Math.max(20, Math.min(200, parseInt(String(req.query.limit || "80"), 10) || 80));
      const days = Math.max(1, Math.min(30, parseInt(String(req.query.days || "7"), 10) || 7));

      const [recovery, activeCalls, recentCalls] = await Promise.all([
        sql`
          SELECT
            c.call_sid,
            c.started_at,
            c.direction,
            c.from_number,
            c.duration_seconds,
            c.turn_count,
            c.recovery_call_back_started_at,
            c.recovery_closed_at,
            c.recovery_status,
            co.id as contact_id,
            co.name as contact_name,
            cs.outcome,
            cs.next_action,
            cs.sentiment
          FROM calls c
          LEFT JOIN contacts co ON c.contact_id = co.id AND co.workspace_id = c.workspace_id
          LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid AND cs.workspace_id = c.workspace_id
          WHERE c.workspace_id = ${wsId}
            AND c.started_at >= NOW() - (${days} || ' days')::interval
            AND c.direction = 'inbound'
            AND COALESCE(c.turn_count, 0) <= 1
            AND COALESCE(c.duration_seconds, 0) <= 20
            AND COALESCE(c.recovery_closed_at, NULL) IS NULL
          ORDER BY c.started_at DESC
          LIMIT 200
        `,
        sql`
          SELECT c.call_sid, c.started_at, c.direction, c.from_number, c.turn_count,
                 co.name as contact_name, cs.outcome
          FROM calls c
          LEFT JOIN contacts co ON c.contact_id = co.id AND co.workspace_id = c.workspace_id
          LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid AND cs.workspace_id = c.workspace_id
          WHERE c.workspace_id = ${wsId} AND c.status = 'in-progress'
          ORDER BY c.started_at DESC
          LIMIT 20
        `,
        sql`
          SELECT c.call_sid, c.started_at, c.direction, c.from_number, c.duration_seconds, c.turn_count,
                 co.name as contact_name,
                 cs.outcome, cs.summary as call_summary, cs.next_action, cs.sentiment
          FROM calls c
          LEFT JOIN contacts co ON c.contact_id = co.id AND co.workspace_id = c.workspace_id
          LEFT JOIN call_summaries cs ON c.call_sid = cs.call_sid AND cs.workspace_id = c.workspace_id
          WHERE c.workspace_id = ${wsId}
          ORDER BY c.started_at DESC
          LIMIT ${limit}
        `,
      ]);

      const incidents = [] as any[];
      for (const r of (recovery as any[])) {
        const needsCallback = !r.recovery_call_back_started_at;
        const needsClose = !!r.recovery_call_back_started_at && !r.recovery_closed_at;
        const label = needsCallback
          ? 'Missed call: callback needed'
          : needsClose
            ? 'Recovery: callback in progress'
            : 'Recovery: in progress';
        const priority = needsCallback ? 'P0' : needsClose ? 'P1' : 'P2';
        incidents.push({
          kind: 'recovery',
          priority,
          label,
          call_sid: r.call_sid,
          at: r.started_at,
          contact_name: r.contact_name,
          from_number: r.from_number,
          status: r.recovery_status || 'open',
        });
      }
      const priOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
      incidents.sort((a, b) => (priOrder[a.priority] - priOrder[b.priority]) || (String(b.at).localeCompare(String(a.at))));

      res.json({
        ok: true,
        window: { days, limit },
        incidents,
        recovery,
        activeCalls,
        recentCalls,
        sms: [],
      });
    } catch (e: any) {
      log('error', 'Triage endpoint failed', { error: e?.message || String(e) });
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
