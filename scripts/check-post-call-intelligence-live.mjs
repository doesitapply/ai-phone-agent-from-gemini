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

const callsPayload = await getJson('/api/calls?limit=10');
const tasksPayload = await getJson('/api/tasks?status=all');
const calls = Array.isArray(callsPayload?.calls) ? callsPayload.calls : [];
const tasks = Array.isArray(tasksPayload?.tasks) ? tasksPayload.tasks : [];
const freshCalls = calls.filter(isFresh);
const freshTasks = tasks.filter(isFresh);
const latestCall = freshCalls[0] || null;
const latestSummary = String(latestCall?.call_summary || '').trim();
const degradedReasons = [
  'No AI configured for post-call analysis.',
  'Call completed.',
];
const summaryDegraded = !latestSummary || degradedReasons.includes(latestSummary);
const relatedTasks = latestCall ? freshTasks.filter((task) => task?.call_sid === latestCall.call_sid) : [];
const relatedCallbackTasks = relatedTasks.filter((task) => task?.task_type === 'callback');
const openRelatedCallbackTasks = relatedCallbackTasks.filter((task) => task?.status === 'open' || task?.status === 'in_progress');
const callbackTasks = freshTasks.filter((task) => task?.task_type === 'callback');
const openCallbackTasks = callbackTasks.filter((task) => task?.status === 'open' || task?.status === 'in_progress');

const out = {
  ok: Boolean(latestCall) && !summaryDegraded && openRelatedCallbackTasks.length > 0,
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
  latestCallbackTaskSample: openRelatedCallbackTasks[0]
    ? {
        id: openRelatedCallbackTasks[0].id,
        callSid: openRelatedCallbackTasks[0].call_sid,
        title: openRelatedCallbackTasks[0].title,
        status: openRelatedCallbackTasks[0].status,
        due_at: openRelatedCallbackTasks[0].due_at,
        artifact_at: artifactTimeValue(openRelatedCallbackTasks[0]),
      }
    : null,
  nextAction: !latestCall
    ? Number.isFinite(sinceMs)
      ? 'Place or wait for a fresh proof call after the supplied timestamp, then rerun this check.'
      : 'Place a live proof call first.'
    : summaryDegraded
      ? 'Fix live post-call AI analysis so the latest call does not fall back to a default summary.'
      : openRelatedCallbackTasks.length === 0
        ? 'Fix callback task creation for the latest call; unrelated callback tasks do not prove this call was handled.'
        : 'Post-call intelligence looks healthy.',
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
