import type { Express, Request, RequestHandler, Response } from "express";
import { getWorkspaceById, PLAN_LIMITS } from "../saas.js";

type WorkspaceOverviewRouteDeps = {
  dashboardAuth: RequestHandler;
  sql: any;
  getWorkspaceId: (req: Request) => number;
  buildProofFreshness: (latestAt: string | Date | null | undefined, completeProofCalls: number) => any;
  buildSetupReadiness: (input: {
    workspace: any;
    workspaceTwilioNumber?: string | null;
    knowledgeSourceCount?: number;
    proofFreshness?: any;
  }) => any;
};

function maskWorkspaceSecrets(workspace: any): any {
  return {
    ...workspace,
    api_key: "***",
    twilio_auth_token: workspace.twilio_auth_token ? "***" : null,
    openrouter_api_key: workspace.openrouter_api_key ? "***" : null,
    elevenlabs_api_key: workspace.elevenlabs_api_key ? "***" : null,
    gemini_api_key: workspace.gemini_api_key ? "***" : null,
  };
}

export function registerWorkspaceOverviewRoutes(app: Express, deps: WorkspaceOverviewRouteDeps): void {
  const {
    dashboardAuth,
    sql,
    getWorkspaceId,
    buildProofFreshness,
    buildSetupReadiness,
  } = deps;

  app.get("/api/workspace-overview", dashboardAuth, async (req: Request, res: Response) => {
    const wsId = getWorkspaceId(req);
    const workspaceAuth = (req as any).workspaceAuth;
    if (workspaceAuth) {
      const workspace = await getWorkspaceById(workspaceAuth.id);
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });
      return res.json({
        workspaces: [maskWorkspaceSecrets(workspace)],
        plans: PLAN_LIMITS,
        currentWorkspaceId: workspace.id,
        customerMode: true,
      });
    }

    const [
      totalCallsR, activeCallsR, completedCallsR, totalMessagesR, totalContactsR,
      avgDurationR, inboundR, outboundR, avgLatencyR, openTasksR, pendingHandoffsR,
      avgResolutionR, callsTodayR, callsWeekR, totalHandoffsR, totalApptsR,
      leadsBookedR, callbacksR, qualifiedR, fieldsR, sentimentR,
      callsMonthR, contactsWithEmailR, contactsWithNameR,
      prospectTotalR, prospectInterestedR, prospectCalledR,
      dncCountR, avgConfidenceR, summariesGeneratedR, callbackTasksCreatedR, ownerEmailAlertsSentR, completeProofCallsR,
      latestCompleteProofCallR, workspaceForReadiness, knowledgeSourceCountR, workspacePhoneNumberR,
    ] = await Promise.all([
      sql`SELECT COUNT(*) as count FROM calls WHERE workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM calls WHERE status = 'in-progress' AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM calls WHERE status = 'completed' AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM messages m JOIN calls c ON m.call_sid = c.call_sid WHERE m.role != 'system' AND c.workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM contacts WHERE workspace_id = ${wsId}`,
      sql`SELECT AVG(duration_seconds) as avg FROM calls WHERE duration_seconds IS NOT NULL AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM calls WHERE direction = 'inbound' AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM calls WHERE direction = 'outbound' AND workspace_id = ${wsId}`,
      sql`SELECT AVG(duration_ms) as avg FROM request_logs WHERE path = '/api/twilio/process' AND status_code = 200`,
      sql`SELECT COUNT(*) as count FROM tasks WHERE status = 'open' AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM handoffs WHERE status = 'pending' AND workspace_id = ${wsId}`,
      sql`SELECT AVG(resolution_score) as avg FROM call_summaries WHERE workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM calls WHERE DATE(started_at) = CURRENT_DATE AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM calls WHERE started_at >= NOW() - INTERVAL '7 days' AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM handoffs WHERE workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM appointments WHERE status = 'scheduled' AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM call_summaries WHERE outcome IN ('appointment_booked', 'lead_captured') AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM call_summaries WHERE outcome = 'callback_needed' AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM call_summaries WHERE resolution_score >= 0.7 AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM contact_custom_fields ccf JOIN contacts co ON ccf.contact_id = co.id WHERE ccf.source = 'ai_extracted' AND co.workspace_id = ${wsId}`,
      sql`SELECT sentiment, COUNT(*) as count FROM call_summaries WHERE workspace_id = ${wsId} GROUP BY sentiment`,
      sql`SELECT COUNT(*) as count FROM calls WHERE started_at >= NOW() - INTERVAL '30 days' AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM contacts WHERE email IS NOT NULL AND email != '' AND workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM contacts WHERE name IS NOT NULL AND name != '' AND workspace_id = ${wsId}`,
      sql`SELECT COALESCE(SUM(total_leads),0) as total, COALESCE(SUM(called),0) as called FROM prospecting_campaigns WHERE workspace_id = ${wsId}`,
      sql`SELECT COALESCE(SUM(interested),0) as count FROM prospecting_campaigns WHERE workspace_id = ${wsId}`,
      sql`SELECT COALESCE(SUM(called),0) as count FROM prospecting_campaigns WHERE workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM dnc_list WHERE workspace_id = ${wsId}`,
      sql`SELECT AVG(confidence) as avg FROM contact_custom_fields ccf JOIN contacts co ON ccf.contact_id = co.id WHERE ccf.confidence IS NOT NULL AND co.workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM call_summaries WHERE workspace_id = ${wsId}`,
      sql`SELECT COUNT(*) as count FROM tasks WHERE task_type = 'callback' AND workspace_id = ${wsId}`,
      sql`
        SELECT COUNT(*) as count
        FROM call_events ce
        JOIN calls c ON c.call_sid = ce.call_sid
        WHERE c.workspace_id = ${wsId}
          AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
      `,
      sql`
        SELECT COUNT(DISTINCT c.call_sid) as count
        FROM calls c
        JOIN call_summaries cs ON cs.call_sid = c.call_sid
        JOIN tasks t ON t.call_sid = c.call_sid
          AND t.task_type IN ('callback', 'handoff', 'escalate_to_human')
        JOIN call_events ce ON ce.call_sid = c.call_sid
          AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
        WHERE c.workspace_id = ${wsId}
      `,
      sql`
        SELECT MAX(c.started_at) as latest_at
        FROM calls c
        JOIN call_summaries cs ON cs.call_sid = c.call_sid
        JOIN tasks t ON t.call_sid = c.call_sid
          AND t.task_type IN ('callback', 'handoff', 'escalate_to_human')
        JOIN call_events ce ON ce.call_sid = c.call_sid
          AND ce.event_type IN ('OWNER_EMAIL_ALERT_SENT', 'VOICEMAIL_EMAIL_SENT')
        WHERE c.workspace_id = ${wsId}
      `,
      getWorkspaceById(wsId),
      sql`SELECT COUNT(*) as count FROM workspace_knowledge_sources WHERE workspace_id = ${wsId}`,
      sql`
        SELECT phone_number
        FROM workspace_phone_numbers
        WHERE workspace_id = ${wsId} AND enabled = TRUE
        ORDER BY id DESC
        LIMIT 1
      `,
    ]);

    const totalCalls = Number(totalCallsR[0].count);
    const activeCalls = Number(activeCallsR[0].count);
    const completedCalls = Number(completedCallsR[0].count);
    const totalMessages = Number(totalMessagesR[0].count);
    const totalContacts = Number(totalContactsR[0].count);
    const avgDuration = avgDurationR[0].avg;
    const inboundCalls = Number(inboundR[0].count);
    const outboundCalls = Number(outboundR[0].count);
    const avgAiLatency = avgLatencyR[0].avg;
    const openTasks = Number(openTasksR[0].count);
    const pendingHandoffs = Number(pendingHandoffsR[0].count);
    const avgResolution = avgResolutionR[0].avg;
    const callsToday = Number(callsTodayR[0].count);
    const callsThisWeek = Number(callsWeekR[0].count);
    const transferRate = totalCalls > 0 ? (Number(totalHandoffsR[0].count) / totalCalls) : 0;
    const bookingRate = totalCalls > 0 ? (Number(totalApptsR[0].count) / totalCalls) : 0;

    const sentimentMap: Record<string, number> = {};
    for (const row of sentimentR as any[]) sentimentMap[row.sentiment] = Number(row.count);

    const leadsBooked = Number(leadsBookedR[0].count);
    const callbacksNeeded = Number(callbacksR[0].count);
    const qualifiedCalls = Number(qualifiedR[0].count);
    const fieldsExtracted = Number(fieldsR[0].count);
    const callsThisMonth = Number(callsMonthR[0].count);
    const contactsWithEmail = Number(contactsWithEmailR[0].count);
    const contactsWithName = Number(contactsWithNameR[0].count);
    const prospectTotalLeads = Number((prospectTotalR[0] as any).total || 0);
    const prospectCalled = Number((prospectTotalR[0] as any).called || 0);
    const prospectInterested = Number(prospectInterestedR[0].count || 0);
    void prospectCalledR;
    const dncCount = Number(dncCountR[0].count);
    const avgFieldConfidence = avgConfidenceR[0].avg ? Math.round(Number(avgConfidenceR[0].avg) * 100) : null;
    const summariesGenerated = Number(summariesGeneratedR[0].count);
    const callbackTasksCreated = Number(callbackTasksCreatedR[0].count);
    const ownerEmailAlertsSent = Number(ownerEmailAlertsSentR[0].count);
    const completeProofCalls = Number(completeProofCallsR[0].count);
    const proofFreshness = buildProofFreshness((latestCompleteProofCallR[0] as { latest_at?: string | Date | null } | undefined)?.latest_at, completeProofCalls);
    const workspaceTwilioNumber = (workspacePhoneNumberR[0] as { phone_number?: string } | undefined)?.phone_number || null;
    const setupReadiness = workspaceForReadiness
      ? buildSetupReadiness({
          workspace: workspaceForReadiness,
          workspaceTwilioNumber,
          knowledgeSourceCount: Number((knowledgeSourceCountR[0] as { count?: string | number } | undefined)?.count || 0),
          proofFreshness,
        })
      : null;

    const conversionRate = completedCalls > 0 ? Math.round((leadsBooked / completedCalls) * 100) : 0;
    const qualificationRate = completedCalls > 0 ? Math.round((qualifiedCalls / completedCalls) * 100) : 0;
    const prospectConversionRate = prospectCalled > 0 ? Math.round((prospectInterested / prospectCalled) * 100) : 0;
    const dataCaptureCoverage = totalContacts > 0 ? Math.round((contactsWithName / totalContacts) * 100) : 0;

    res.json({
      totalCalls, activeCalls, completedCalls, totalMessages, totalContacts,
      avgDurationSeconds: avgDuration ? Math.round(avgDuration) : 0,
      inboundCalls, outboundCalls,
      avgAiLatencyMs: avgAiLatency ? Math.round(avgAiLatency) : 0,
      openTasks, pendingHandoffs,
      avgResolutionScore: avgResolution ? Math.round(avgResolution * 100) / 100 : 0,
      callsToday, callsThisWeek, callsThisMonth,
      transferRate: Math.round(transferRate * 100),
      bookingRate: Math.round(bookingRate * 100),
      conversionRate,
      qualificationRate,
      callbacksNeeded,
      leadsBooked,
      fieldsExtracted,
      summariesGenerated,
      callbackTasksCreated,
      ownerEmailAlertsSent,
      completeProofCalls,
      proofFreshness,
      setupReadiness,
      dataCaptureCoverage,
      contactsWithEmail,
      contactsWithName,
      avgFieldConfidence,
      sentiment: sentimentMap,
      prospectTotalLeads, prospectCalled, prospectInterested, prospectConversionRate,
      dncCount,
    });
  });
}
