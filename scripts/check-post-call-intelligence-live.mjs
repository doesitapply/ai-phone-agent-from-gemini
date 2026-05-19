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
    message: 'Refusing to inspect post-call intelligence against stale production. Deploy local HEAD first.',
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

const callsPayload = await getJson('/api/calls?limit=10');
const tasksPayload = await getJson('/api/tasks?status=all');
const calls = Array.isArray(callsPayload?.calls) ? callsPayload.calls : [];
const tasks = Array.isArray(tasksPayload?.tasks) ? tasksPayload.tasks : [];
const latestCall = calls[0] || null;
const latestSummary = String(latestCall?.call_summary || '').trim();
const degradedReasons = [
  'No AI configured for post-call analysis.',
  'Call completed.',
];
const summaryDegraded = !latestSummary || degradedReasons.includes(latestSummary);
const relatedTasks = latestCall ? tasks.filter((task) => task?.call_sid === latestCall.call_sid) : [];
const callbackTasks = relatedTasks.filter((task) => task?.task_type === 'callback');

const out = {
  ok: Boolean(latestCall) && !summaryDegraded && callbackTasks.length > 0,
  totalCalls: calls.length,
  latestCallSid: latestCall?.call_sid || null,
  latestOutcome: latestCall?.outcome || null,
  latestSummary: latestSummary || null,
  summaryDegraded,
  relatedTaskTypes: relatedTasks.map((task) => task.task_type || null),
  callbackTaskCount: callbackTasks.length,
  nextAction: !latestCall
    ? 'Place a live proof call first.'
    : summaryDegraded
      ? 'Fix live post-call AI analysis so the latest call does not fall back to a default summary.'
      : callbackTasks.length === 0
        ? 'Fix callback task creation for incomplete/callback-needed calls.'
        : 'Post-call intelligence looks healthy.',
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
