#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const sinceArg = String(process.argv[2] || process.env.PROOF_STARTED_AT || '').trim();
const sinceMs = sinceArg ? Date.parse(sinceArg) : NaN;
const expectedCallSid = String(process.env.PROOF_CALL_SID || '').trim();
const fetchTimeoutMs = Number(process.env.SMIRK_POST_CALL_INTELLIGENCE_FETCH_TIMEOUT_MS || 15000);
const fetchAttempts = Number(process.env.SMIRK_POST_CALL_INTELLIGENCE_FETCH_ATTEMPTS || 2);
const fetchRetryDelayMs = Number(process.env.SMIRK_POST_CALL_INTELLIGENCE_FETCH_RETRY_DELAY_MS || 750);

if (sinceArg && !Number.isFinite(sinceMs)) {
  console.error(JSON.stringify({
    ok: false,
    error: 'invalid-proof-started-at',
    message: 'Pass an ISO timestamp or set PROOF_STARTED_AT to verify only fresh post-call intelligence.',
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
    message: 'Refusing to inspect post-call intelligence against stale production. Deploy local HEAD first.',
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
  return parsed;
}

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

let callsPayload;
let tasksPayload;
try {
  callsPayload = await getJson('/api/calls?limit=50');
  tasksPayload = await getJson('/api/tasks?status=all');
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: 'post-call-intelligence-fetch-failed',
    message: 'Could not fetch live post-call intelligence artifacts after bounded retries.',
    detail: error?.detail || normalizeFetchError(error),
  }, null, 2));
  process.exit(1);
}
const calls = Array.isArray(callsPayload?.calls) ? callsPayload.calls : [];
const tasks = Array.isArray(tasksPayload?.tasks) ? tasksPayload.tasks : [];
const freshCalls = calls.filter(isFresh);
const freshTasks = tasks.filter(isFresh);
const expectedCallSidMatches = (item) => {
  if (!expectedCallSid) return true;
  const callSid = String(item?.call_sid || item?.callSid || '').trim();
  return callSid === expectedCallSid;
};
const candidateCalls = freshCalls.filter(expectedCallSidMatches);
const candidateTasks = freshTasks.filter(expectedCallSidMatches);
const degradedReasons = [
  'No AI configured for post-call analysis.',
  'Call completed.',
];
function callSidOf(item) {
  return String(item?.call_sid || item?.callSid || '').trim();
}

function taskIsOpenCallback(task) {
  return task?.task_type === 'callback' && (task?.status === 'open' || task?.status === 'in_progress');
}

function taskIsOpenOwnerAction(task) {
  return ['callback', 'follow_up', 'handoff', 'escalate_to_human'].includes(String(task?.task_type || '')) &&
    (task?.status === 'open' || task?.status === 'in_progress');
}

function summaryIsDegraded(call) {
  const summary = String(call?.call_summary || '').trim();
  return !summary || degradedReasons.includes(summary);
}

function relatedTasksFor(call) {
  const callSid = callSidOf(call);
  return callSid ? candidateTasks.filter((task) => callSidOf(task) === callSid) : [];
}

function hasOpenCallbackTask(call) {
  return relatedTasksFor(call).some(taskIsOpenCallback);
}

const selectedCall = expectedCallSid
  ? candidateCalls[0] || null
  : candidateCalls.find((call) => !summaryIsDegraded(call) && relatedTasksFor(call).some(taskIsOpenOwnerAction)) || candidateCalls[0] || null;
const latestCall = selectedCall;
const latestSummary = String(latestCall?.call_summary || '').trim();
const summaryDegraded = !latestSummary || degradedReasons.includes(latestSummary);
const relatedTasks = latestCall ? relatedTasksFor(latestCall) : [];
const relatedCallbackTasks = relatedTasks.filter((task) => task?.task_type === 'callback');
const openRelatedCallbackTasks = relatedCallbackTasks.filter(taskIsOpenCallback);
const openRelatedTasks = relatedTasks.filter((task) => task?.status === 'open' || task?.status === 'in_progress');
const openRelatedOwnerActionTasks = relatedTasks.filter(taskIsOpenOwnerAction);
const callbackTasks = candidateTasks.filter((task) => task?.task_type === 'callback');
const openCallbackTasks = callbackTasks.filter((task) => task?.status === 'open' || task?.status === 'in_progress');
const callbackRequiredOutcomes = new Set(['callback_needed', 'lead_captured']);
const latestOutcome = String(latestCall?.outcome || '');
const requiresRelatedCallback = callbackRequiredOutcomes.has(latestOutcome);
const requiresOwnerAction = latestOutcome === 'escalated' || latestOutcome === 'incomplete';
const hasExpectedRelatedTask = requiresRelatedCallback
  ? openRelatedCallbackTasks.length > 0
  : requiresOwnerAction
    ? openRelatedOwnerActionTasks.length > 0
  : openRelatedTasks.length > 0 || openRelatedCallbackTasks.length > 0;
const pinnedCallText = expectedCallSid ? ' for the placed PROOF_CALL_SID' : '';
const pinnedCallAction = expectedCallSid
  ? 'Inspect or reprocess the placed PROOF_CALL_SID so that exact call has a real summary and an open owner-action task, then rerun this check with the same PROOF_STARTED_AT and PROOF_CALL_SID.'
  : null;

const out = {
  ok: Boolean(latestCall) && !summaryDegraded && hasExpectedRelatedTask,
  totalCalls: calls.length,
  freshCalls: freshCalls.length,
  latestCallSid: latestCall?.call_sid || null,
  latestOutcome: latestCall?.outcome || null,
  latestSummary: latestSummary || null,
  latestCallArtifactAt: artifactTimeValue(latestCall),
  summaryDegraded,
  totalTasks: tasks.length,
  freshTasks: freshTasks.length,
  relatedTaskTypes: relatedTasks.map((task) => task.task_type || null),
  relatedCallbackTaskCount: relatedCallbackTasks.length,
  openRelatedCallbackTaskCount: openRelatedCallbackTasks.length,
  openRelatedOwnerActionTaskCount: openRelatedOwnerActionTasks.length,
  openRelatedTaskCount: openRelatedTasks.length,
  requiresRelatedCallback,
  requiresOwnerAction,
  callbackTaskCount: callbackTasks.length,
  openCallbackTaskCount: openCallbackTasks.length,
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
  latestOwnerActionTaskSample: openRelatedOwnerActionTasks[0]
    ? {
        id: openRelatedOwnerActionTasks[0].id,
        callSid: openRelatedOwnerActionTasks[0].call_sid,
        type: openRelatedOwnerActionTasks[0].task_type,
        title: openRelatedOwnerActionTasks[0].title,
        status: openRelatedOwnerActionTasks[0].status,
        due_at: openRelatedOwnerActionTasks[0].due_at,
        artifact_at: artifactTimeValue(openRelatedOwnerActionTasks[0]),
      }
    : null,
  nextAction: !latestCall
    ? Number.isFinite(sinceMs)
      ? (pinnedCallAction || 'Place or wait for a fresh proof call after the supplied timestamp, then rerun this check.')
      : 'Place a live proof call first.'
    : summaryDegraded
      ? `Fix live post-call AI analysis${pinnedCallText} so the checked call does not fall back to a default summary.`
      : requiresRelatedCallback && openRelatedCallbackTasks.length === 0
        ? `Fix callback task creation${pinnedCallText}; unrelated callback tasks do not prove this call was handled.`
        : requiresOwnerAction && openRelatedOwnerActionTasks.length === 0
          ? `Fix owner-action task creation${pinnedCallText}; unrelated owner-action tasks do not prove this call was handled.`
        : openRelatedTasks.length === 0
          ? `Fix post-call task creation${pinnedCallText}; no related open task was found.`
          : `Post-call intelligence looks healthy${pinnedCallText}.`,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
