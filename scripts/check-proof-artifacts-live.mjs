#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readRailwayEnvValue } from './railway-json.mjs';

const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const sinceArg = String(process.argv[2] || process.env.PROOF_STARTED_AT || '').trim();
const sinceMs = sinceArg ? Date.parse(sinceArg) : NaN;
const expectedCallSid = String(process.env.PROOF_CALL_SID || '').trim();
const fetchTimeoutMs = Number(process.env.SMIRK_PROOF_ARTIFACT_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_PROOF_ARTIFACT_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_PROOF_ARTIFACT_FETCH_RETRY_DELAY_MS || 750);

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

const apiKeyCandidates = [
  String(process.env.DASHBOARD_API_KEY || '').trim(),
  readLocalEnvValue('DASHBOARD_API_KEY'),
  readRailwayEnvValue('DASHBOARD_API_KEY', { quiet: true }),
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFetchError(error) {
  return {
    name: error?.name || null,
    message: String(error?.message || error || ''),
    code: error?.cause?.code || error?.code || null,
    cause: error?.cause?.constructor?.name || null,
  };
}

async function fetchText(pathname, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`${appUrl}${pathname}`, {
      headers: { 'x-api-key': apiKey },
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithRetry(pathname, apiKey) {
  const attempts = Math.max(1, fetchAttempts);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchText(pathname, apiKey);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(fetchRetryDelayMs);
      }
    }
  }
  const normalized = normalizeFetchError(lastError);
  const err = new Error(`fetch failed for ${pathname}: ${normalized.message}`);
  err.detail = {
    pathname,
    appUrl,
    attempts,
    timeoutMs: fetchTimeoutMs,
    retryDelayMs: fetchRetryDelayMs,
    lastError: normalized,
  };
  throw err;
}

const cacheControls = {};

function requireNoStore(pathname, res) {
  const cacheControl = String(res.headers.get('cache-control') || '').toLowerCase();
  const cacheProtected = cacheControl.includes('no-store');
  cacheControls[pathname] = { cacheControl, cacheProtected };
  if (!cacheProtected) {
    const err = new Error(`${pathname} response is missing Cache-Control: no-store`);
    err.detail = {
      pathname,
      status: res.status,
      cacheControl: cacheControl || null,
      cacheProtected,
      expected: 'Cache-Control header containing no-store',
    };
    throw err;
  }
}

async function getJson(pathname) {
  let res;
  let text = '';
  for (const apiKey of apiKeyCandidates) {
    ({ res, text } = await fetchTextWithRetry(pathname, apiKey));
    if (res.status !== 401) break;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON from ${pathname}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}`);
  requireNoStore(pathname, res);
  return parsed;
}

let health;
let callsPayload;
let tasksPayload;
let eventsPayload;
try {
  [health, callsPayload, tasksPayload, eventsPayload] = await Promise.all([
    getJson('/api/system-health'),
    getJson('/api/calls?limit=20'),
    getJson('/api/tasks?status=all'),
    getJson('/api/events?limit=200'),
  ]);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: 'proof-artifact-fetch-failed',
    message: 'Could not fetch live proof artifacts after bounded retries.',
    detail: error?.detail || normalizeFetchError(error),
  }, null, 2));
  process.exit(1);
}

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

function isOpenTask(task) {
  return task?.status === 'open' || task?.status === 'in_progress';
}

function taskIsOwnerAction(task) {
  return ['callback', 'follow_up', 'handoff', 'escalate_to_human'].includes(String(task?.task_type || ''));
}

const freshCalls = calls.filter(isFresh);
const freshTasks = tasks.filter(isFresh);
const freshEvents = events.filter(isFresh);
const expectedCallSidMatches = (item) => {
  if (!expectedCallSid) return true;
  return callSidOf(item) === expectedCallSid;
};
const summarizedCalls = freshCalls
  .filter(expectedCallSidMatches)
  .filter((call) => String(call?.call_summary || '').trim().length > 0);
const callbackTasks = freshTasks
  .filter(expectedCallSidMatches)
  .filter((task) => task?.task_type === 'callback');
const openCallbackTasks = callbackTasks.filter(isOpenTask);
const ownerActionTasks = freshTasks
  .filter(expectedCallSidMatches)
  .filter(taskIsOwnerAction);
const openOwnerActionTasks = ownerActionTasks.filter(isOpenTask);
const ownerEmailEvents = freshEvents
  .filter(expectedCallSidMatches)
  .filter((event) => event?.event_type === 'OWNER_EMAIL_ALERT_SENT' || event?.event_type === 'VOICEMAIL_EMAIL_SENT');
const ownerActionTasksByCallSid = firstByCallSid(ownerActionTasks);
const openOwnerActionTasksByCallSid = firstByCallSid(openOwnerActionTasks);
const ownerEmailEventsByCallSid = firstByCallSid(ownerEmailEvents);
const correlatedProofCalls = summarizedCalls.filter((call) => {
  const callSid = callSidOf(call);
  return callSid && ownerActionTasksByCallSid.has(callSid) && ownerEmailEventsByCallSid.has(callSid);
});
const proofCall = correlatedProofCalls[0] || null;
const proofCallSid = callSidOf(proofCall);
const proofOwnerActionTask = proofCallSid ? ownerActionTasksByCallSid.get(proofCallSid) || null : null;
const proofOwnerEmailEvent = proofCallSid ? ownerEmailEventsByCallSid.get(proofCallSid) || null : null;
const proofLoopStatus = Array.isArray(health?.checks)
  ? health.checks.find((check) => check?.id === 'proof_loop')?.status || null
  : null;
const pinnedCallText = expectedCallSid ? ' for the placed PROOF_CALL_SID' : '';
const pinnedCallAction = expectedCallSid
  ? 'Inspect or reprocess the placed PROOF_CALL_SID so that exact call produces a summary, owner-action task, and owner email event, then rerun this check with the same PROOF_STARTED_AT and PROOF_CALL_SID.'
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
    ownerActionTasks: ownerActionTasks.length,
    openOwnerActionTasks: openOwnerActionTasks.length,
    totalEvents: events.length,
    freshEvents: freshEvents.length,
    ownerEmailEvents: ownerEmailEvents.length,
    correlatedProofCalls: correlatedProofCalls.length,
  },
  cache: cacheControls,
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
  expectedCallSid: expectedCallSid || null,
  callSidPinning: {
    enforced: Boolean(expectedCallSid),
    source: expectedCallSid ? 'PROOF_CALL_SID' : null,
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
  latestOwnerActionTaskSample: (proofOwnerActionTask || openOwnerActionTasks[0])
    ? {
        correlated: Boolean(proofOwnerActionTask),
        id: (proofOwnerActionTask || openOwnerActionTasks[0]).id,
        callSid: (proofOwnerActionTask || openOwnerActionTasks[0]).call_sid,
        type: (proofOwnerActionTask || openOwnerActionTasks[0]).task_type,
        title: (proofOwnerActionTask || openOwnerActionTasks[0]).title,
        status: (proofOwnerActionTask || openOwnerActionTasks[0]).status,
        due_at: (proofOwnerActionTask || openOwnerActionTasks[0]).due_at,
        artifact_at: artifactTimeValue(proofOwnerActionTask || openOwnerActionTasks[0]),
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
        ? (pinnedCallAction || 'Place a fresh proof call after the supplied timestamp, then rerun this check.')
        : 'Place a proof call, then rerun this check with PROOF_STARTED_AT set to the call start timestamp.'
      : ownerActionTasks.length === 0
        ? `Place or reprocess a proof call${pinnedCallText} that creates a follow-up, callback, handoff, or escalation task, then rerun this check.`
        : ownerEmailEvents.length === 0
          ? `Place or reprocess a proof call${pinnedCallText} that sends an owner email alert, then rerun this check.`
          : correlatedProofCalls.length === 0
            ? `Place or reprocess one proof call${pinnedCallText} that produces a summary, owner-action task, and owner email event with the same call_sid, then rerun this check.`
            : `Proof artifacts are present for one call${pinnedCallText}.`,
};

console.log(JSON.stringify(out, null, 2));

if (!out.ok) process.exit(1);
