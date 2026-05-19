#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');

function readLocalEnvValue(key) {
  for (const file of ['.env.local', '.env']) {
    const p = path.resolve(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith(`${key}=`)) continue;
      return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return '';
}

const apiKey = String(process.env.DASHBOARD_API_KEY || readLocalEnvValue('DASHBOARD_API_KEY') || '').trim();
if (!apiKey) {
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
  const res = await fetch(`${appUrl}${pathname}`, { headers: { 'x-api-key': apiKey } });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON from ${pathname}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}`);
  return parsed;
}

const [health, callsPayload, tasksPayload] = await Promise.all([
  getJson('/api/system-health'),
  getJson('/api/calls?limit=20'),
  getJson('/api/tasks?status=all'),
]);

const calls = Array.isArray(callsPayload?.calls) ? callsPayload.calls : [];
const tasks = Array.isArray(tasksPayload?.tasks) ? tasksPayload.tasks : [];
const summarizedCalls = calls.filter((call) => String(call?.call_summary || '').trim().length > 0);
const callbackTasks = tasks.filter((task) => task?.task_type === 'callback');
const openCallbackTasks = callbackTasks.filter((task) => task?.status === 'open' || task?.status === 'in_progress');
const proofLoopStatus = Array.isArray(health?.checks)
  ? health.checks.find((check) => check?.id === 'proof_loop')?.status || null
  : null;

const out = {
  ok: proofLoopStatus === 'pass' && summarizedCalls.length > 0 && openCallbackTasks.length > 0,
  status: {
    proofLoop: proofLoopStatus,
    totalCalls: calls.length,
    summarizedCalls: summarizedCalls.length,
    totalTasks: tasks.length,
    callbackTasks: callbackTasks.length,
    openCallbackTasks: openCallbackTasks.length,
  },
  latestSummarySample: summarizedCalls[0]
    ? {
        callSid: summarizedCalls[0].call_sid,
        outcome: summarizedCalls[0].outcome,
        summary: String(summarizedCalls[0].call_summary).slice(0, 160),
      }
    : null,
  latestCallbackTaskSample: openCallbackTasks[0]
    ? {
        id: openCallbackTasks[0].id,
        title: openCallbackTasks[0].title,
        status: openCallbackTasks[0].status,
        due_at: openCallbackTasks[0].due_at,
      }
    : null,
};

console.log(JSON.stringify(out, null, 2));

if (!out.ok) process.exit(1);
