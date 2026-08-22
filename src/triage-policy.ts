export type RecoveryTriageCandidate = {
  callSid: string;
  startedAt: string | Date;
  fromNumber: string | null;
  contactName: string | null;
  durationSeconds: number | null;
  turnCount: number | null;
  recoveryCallbackStartedAt: string | Date | null;
  recoveryClosedAt: string | Date | null;
  recoveryStatus: string | null;
  outcome: string | null;
  summary: string | null;
  nextAction: string | null;
  sentiment: string | null;
};

export type DecisionReadyIncident = {
  id: string;
  kind: "recovery" | "capture_review";
  priority: "P0" | "P1" | "P2";
  action: "recovery" | "review";
  label: string;
  detail: string;
  callSid: string;
  at: string | Date;
  fromNumber: string | null;
  contactName: string | null;
  status: string;
  duplicateCount: number;
  turnCount: number;
  durationSeconds: number | null;
  outcome: string | null;
  summary: string | null;
  nextAction: string | null;
  sentiment: string | null;
};

const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

function dateMs(value: string | Date): number {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function callerKey(candidate: RecoveryTriageCandidate): string {
  const digits = String(candidate.fromNumber || "").replace(/\D/g, "");
  return digits.length >= 8 ? `phone:${digits}` : `call:${candidate.callSid}`;
}

function baseIncident(candidate: RecoveryTriageCandidate): Omit<DecisionReadyIncident, "id" | "label" | "detail" | "kind" | "priority" | "action" | "duplicateCount"> {
  return {
    callSid: candidate.callSid,
    at: candidate.startedAt,
    fromNumber: candidate.fromNumber,
    contactName: candidate.contactName,
    status: candidate.recoveryStatus || "open",
    turnCount: Number(candidate.turnCount || 0),
    durationSeconds: candidate.durationSeconds,
    outcome: candidate.outcome,
    summary: candidate.summary,
    nextAction: candidate.nextAction,
    sentiment: candidate.sentiment,
  };
}

function classifyCandidate(candidate: RecoveryTriageCandidate, duplicateCount: number): DecisionReadyIncident {
  const base = baseIncident(candidate);
  const hasConversationEvidence = base.turnCount >= 2 || Boolean(String(candidate.summary || "").trim());
  const repeatPrefix = duplicateCount > 1 ? `${duplicateCount} repeat missed calls — ` : "";

  if (candidate.recoveryCallbackStartedAt && !candidate.recoveryClosedAt) {
    return {
      ...base,
      id: `recovery:${candidate.callSid}`,
      kind: "recovery",
      priority: "P1",
      action: "recovery",
      label: "Recovery: callback in progress",
      detail: "A callback has already been started. Review progress before taking another contact action.",
      duplicateCount,
    };
  }

  if (candidate.outcome === "callback_needed" && hasConversationEvidence) {
    return {
      ...base,
      id: `recovery:${candidate.callSid}`,
      kind: "recovery",
      priority: "P0",
      action: "recovery",
      label: `${repeatPrefix}Callback requested`,
      detail: candidate.nextAction || "The captured conversation explicitly indicates a callback is needed.",
      duplicateCount,
    };
  }

  if (hasConversationEvidence) {
    return {
      ...base,
      id: `review:${candidate.callSid}`,
      kind: "capture_review",
      priority: "P1",
      action: "review",
      label: `${repeatPrefix}Review conversation before callback`,
      detail: "The call has some evidence, but no explicit callback outcome. Review before starting contact.",
      duplicateCount,
    };
  }

  return {
    ...base,
    id: `review:${candidate.callSid}`,
    kind: "capture_review",
    priority: "P2",
    action: "review",
    label: `${repeatPrefix}Call capture incomplete — review`,
    detail: "No usable conversation or summary was captured. Inspect the call record or recording; do not treat this as an automatic callback instruction.",
    duplicateCount,
  };
}

/**
 * Converts recovery candidates into a queue of decisions, rather than a list
 * of raw call failures. Consecutive attempts from the same caller inside a
 * 30-minute window are grouped so one caller does not create a P0 wall.
 */
export function buildDecisionReadyIncidents(candidates: RecoveryTriageCandidate[]): DecisionReadyIncident[] {
  const sorted = [...candidates]
    .filter((candidate) => !candidate.recoveryClosedAt)
    .sort((a, b) => dateMs(b.startedAt) - dateMs(a.startedAt));

  const grouped = new Map<string, RecoveryTriageCandidate[]>();
  const latestGroupByCaller = new Map<string, string>();
  for (const candidate of sorted) {
    const key = callerKey(candidate);
    const priorGroupKey = latestGroupByCaller.get(key);
    const current = priorGroupKey ? grouped.get(priorGroupKey) || [] : [];
    const newest = current[0];
    if (!newest || Math.abs(dateMs(newest.startedAt) - dateMs(candidate.startedAt)) > DUPLICATE_WINDOW_MS) {
      const groupKey = `${key}:${candidate.callSid}`;
      grouped.set(groupKey, [candidate]);
      latestGroupByCaller.set(key, groupKey);
    } else {
      current.push(candidate);
      grouped.set(priorGroupKey as string, current);
    }
  }

  const priorityRank: Record<DecisionReadyIncident["priority"], number> = { P0: 0, P1: 1, P2: 2 };
  return [...grouped.values()]
    .map((group) => classifyCandidate(group[0], group.length))
    .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || dateMs(b.at) - dateMs(a.at));
}
