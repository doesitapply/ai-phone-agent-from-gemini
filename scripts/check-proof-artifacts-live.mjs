#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const sinceArg = String(process.argv[2] || process.env.PROOF_STARTED_AT || '').trim();
const sinceMs = sinceArg ? Date.parse(sinceArg) : NaN;

if (sinceArg && !Number.isFinite(sinceMs)) {
  console.error(JSON.stringify({
    ok: false,
    error: 'invalid-proof-started-at',
    message: 'Pass an ISO timestamp or set PROOF_STARTED_AT to verify only fresh proof artifacts.',
    value: sinceArg,
  }, null, 2));
  process.exit(1);
}

function readLocalEnvValue(key) {
  const files = [
    '.env.local',
    '.env',
    path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env.operator'),
    path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env.smirk'),
    path.join(process.env.HOME || '', '.openclaw', 'workspace', '.env'),
  ];
  for (const file of files) {
    const p = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith(`${key}=`)) continue;
      return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return '';
}

function readRailwayEnvValue(key) {
  try {
    const raw = execFileSync(
      'bash',
      ['-lc', 'source ./scripts/load-railway-auth.sh >/dev/null 2>&1 || true; railway variable list --json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const vars = JSON.parse(raw);
    return String(vars[key] || '').trim();
  } catch {
    return '';
  }
}

const apiKeyCandidates = [
  String(process.env.DASHBOARD_API_KEY || '').trim(),
  readLocalEnvValue('DASHBOARD_API_KEY'),
  readRailwayEnvValue('DASHBOARD_API_KEY'),
].filter(Boolean);

if (apiKeyCandidates.length === 0) {
  console.error(JSON.stringify({ ok: false, error: 'missing-dashboard-api-key' }, null, 2));
  process.exit(1);
}

try {
  execFileSync('npm', ['run', '-s', 'check:live-is-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  const text = String(error?.stdout || error?.stderr || '').trim();
  console.error(JSON.stringify({
    ok: false,
    error: 'live-version-mismatch',
    message: 'Refusing to verify proof artifacts against stale production. Deploy local HEAD first.',
    detail: text || null,
  }, null, 2));
  process.exit(1);
}

async function getJson(pathname) {
  let res;
  let text = '';
  for (const apiKey of apiKeyCandidates) {
    res = await fetch(`${appUrl}${pathname}`, { headers: { 'x-api-key': apiKey } });
    text = await res.text();
    if (res.status !== 401) break;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON from ${pathname}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}`);
  return parsed;
}

const [health, callsPayload, tasksPayload, eventsPayload] = await Promise.all([
  getJson('/api/system-health'),
  getJson('/api/calls?limit=20'),
  getJson('/api/tasks?status=all'),
  getJson('/api/events?limit=200'),
]);

const calls = Array.isArray(callsPayload?.calls) ? callsPayload.calls : [];
const tasks = Array.isArray(tasksPayload?.tasks) ? tasksPayload.tasks : [];
const events = Array.isArray(eventsPayload?.events) ? eventsPayload.events : [];

function artifactTimeMs(item) {
  const value =
    item?.created_at ||
    item?.createdAt ||
    item?.updated_at ||
    item?.updatedAt ||
    item?.timestamp ||
    item?.started_at ||
    item?.startedAt ||
    item?.date ||
    '';
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function artifactTimeValue(item) {
  return item?.created_at ||
    item?.createdAt ||
    item?.updated_at ||
    item?.updatedAt ||
    item?.timestamp ||
    item?.started_at ||
    item?.startedAt ||
    item?.date ||
    null;
}

function isFresh(item) {
  if (!Number.isFinite(sinceMs)) return true;
  const timestamp = artifactTimeMs(item);
  return timestamp !== null && timestamp >= sinceMs;
}

function callSidOf(item) {
  return String(item?.call_sid || item?.callSid || '').trim();
}

function firstByCallSid(items) {
  const bySid = new Map();
  for (const item of items) {
    const callSid = callSidOf(item);
    if (callSid && !bySid.has(callSid)) bySid.set(callSid, item);
  }
  return bySid;
}

const freshCalls = calls.filter(isFresh);
const freshTasks = tasks.filter(isFresh);
const freshEvents = events.filter(isFresh);
const summarizedCalls = freshCalls.filter((call) => String(call?.call_summary || '').trim().length > 0);
const callbackTasks = freshTasks.filter((task) => task?.task_type === 'callback');
const openCallbackTasks = callbackTasks.filter((task) => task?.status === 'open' || task?.status === 'in_progress');
const ownerEmailEvents = freshEvents.filter((event) => event?.event_type === 'OWNER_EMAIL_ALERT_SENT' || event?.event_type === 'VOICEMAIL_EMAIL_SENT');
const openCallbackTasksByCallSid = firstByCallSid(openCallbackTasks);
const ownerEmailEventsByCallSid = firstByCallSid(ownerEmailEvents);
const correlatedProofCalls = summarizedCalls.filter((call) => {
  const callSid = callSidOf(call);
  return callSid && openCallbackTasksByCallSid.has(callSid) && ownerEmailEventsByCallSid.has(callSid);
});
const proofCall = correlatedProofCalls[0] || null;
const proofCallSid = callSidOf(proofCall);
const proofCallbackTask = proofCallSid ? openCallbackTasksByCallSid.get(proofCallSid) || null : null;
const proofOwnerEmailEvent = proofCallSid ? ownerEmailEventsByCallSid.get(proofCallSid) || null : null;
const proofLoopStatus = Array.isArray(health?.checks)
  ? health.checks.find((check) => check?.id === 'proof_loop')?.status || null
  : null;

const out = {
  ok: proofLoopStatus === 'pass' && Boolean(proofCall),
  status: {
    proofLoop: proofLoopStatus,
    totalCalls: calls.length,
    freshCalls: freshCalls.length,
    summarizedCalls: summarizedCalls.length,
    totalTasks: tasks.length,
    freshTasks: freshTasks.length,
    callbackTasks: callbackTasks.length,
    openCallbackTasks: openCallbackTasks.length,
    totalEvents: events.length,
    freshEvents: freshEvents.length,
    ownerEmailEvents: ownerEmailEvents.length,
    correlatedProofCalls: correlatedProofCalls.length,
  },
  freshness: Number.isFinite(sinceMs)
    ? {
        since: new Date(sinceMs).toISOString(),
        source: process.argv[2] ? 'argv' : 'PROOF_STARTED_AT',
        enforced: true,
      }
    : {
        since: null,
        source: null,
        enforced: false,
      },
  latestSummarySample: (proofCall || summarizedCalls[0])
    ? {
        correlated: Boolean(proofCall),
        callSid: (proofCall || summarizedCalls[0]).call_sid,
        outcome: (proofCall || summarizedCalls[0]).outcome,
        artifact_at: artifactTimeValue(proofCall || summarizedCalls[0]),
        summary: String((proofCall || summarizedCalls[0]).call_summary).slice(0, 160),
      }
    : null,
  latestCallbackTaskSample: (proofCallbackTask || openCallbackTasks[0])
    ? {
        correlated: Boolean(proofCallbackTask),
        id: (proofCallbackTask || openCallbackTasks[0]).id,
        callSid: (proofCallbackTask || openCallbackTasks[0]).call_sid,
        title: (proofCallbackTask || openCallbackTasks[0]).title,
        status: (proofCallbackTask || openCallbackTasks[0]).status,
        due_at: (proofCallbackTask || openCallbackTasks[0]).due_at,
        artifact_at: artifactTimeValue(proofCallbackTask || openCallbackTasks[0]),
      }
    : null,
  latestOwnerEmailEventSample: (proofOwnerEmailEvent || ownerEmailEvents[0])
    ? {
        correlated: Boolean(proofOwnerEmailEvent),
        callSid: (proofOwnerEmailEvent || ownerEmailEvents[0]).call_sid,
        eventType: (proofOwnerEmailEvent || ownerEmailEvents[0]).event_type,
        artifact_at: artifactTimeValue(proofOwnerEmailEvent || ownerEmailEvents[0]),
      }
    : null,
  nextAction: proofLoopStatus !== 'pass'
    ? 'Fix proof-loop readiness before checking artifacts.'
    : summarizedCalls.length === 0
      ? Number.isFinite(sinceMs)
        ? 'Place a fresh proof call after the supplied timestamp, then rerun this check.'
        : 'Place a proof call, then rerun this check with PROOF_STARTED_AT set to the call start timestamp.'
      : openCallbackTasks.length === 0
        ? 'Place or reprocess a proof call that creates an open callback task, then rerun this check.'
        : ownerEmailEvents.length === 0
          ? 'Place or reprocess a proof call that sends an owner email alert, then rerun this check.'
          : correlatedProofCalls.length === 0
            ? 'Place or reprocess one proof call that produces a summary, open callback task, and owner email event with the same call_sid, then rerun this check.'
            : 'Proof artifacts are present for one call.',
};

console.log(JSON.stringify(out, null, 2));

if (!out.ok) process.exit(1);
