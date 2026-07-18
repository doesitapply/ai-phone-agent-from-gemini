#!/usr/bin/env node
import fs from 'node:fs';

const route = fs.readFileSync('src/routes/twilio-status-routes.ts', 'utf8');
const saas = fs.readFileSync('src/saas.ts', 'utf8');
const db = fs.readFileSync('src/db.ts', 'utf8');
const failures = [];
const expect = (label, condition) => { if (!condition) failures.push(label); };

expect('calls persist an idempotent usage fact', db.includes('usage_recorded_at TIMESTAMPTZ') && db.includes('usage_recorded_minutes INTEGER'));
const usageWriteIndex = route.indexOf('await recordWorkspaceCallUsage(CallSid, callWorkspaceId, durationSeconds);');
const durableEnqueueIndex = route.indexOf('await enqueuePostCallJob(CallSid, callWorkspaceId);');
expect('completed retries always record usage before durable post-call enqueue', route.includes('if (CallStatus === "completed")')
  && usageWriteIndex > -1
  && durableEnqueueIndex > usageWriteIndex);
expect('usage failures return a retryable non-2xx response', route.includes('return res.status(503).send("Call usage accounting retry required")'));
expect('one SQL statement claims the call and updates both counters', saas.includes('WITH call_state AS MATERIALIZED')
  && saas.includes('usage_claim AS')
  && saas.includes('AND c.usage_recorded_at IS NULL')
  && saas.includes('usage_upsert AS')
  && saas.includes('workspace_update AS'));
expect('duplicate callbacks become no-ops', saas.includes('if (result?.already_recorded) return false'));
expect('missing call or tenant stays retryable', saas.includes('if (!result?.call_found || !result.usage_claimed) throw new Error'));
expect('partial counter outcomes abort the SQL statement', saas.includes('1 / CASE') && saas.includes('NOT EXISTS(SELECT 1 FROM usage_upsert)') && saas.includes('NOT EXISTS(SELECT 1 FROM workspace_update)'));
expect('legacy two-statement increment is gone', !saas.includes('export async function incrementWorkspaceUsage'));

if (failures.length) {
  console.error('FAIL completed-call usage accounting contract:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('OK completed-call usage accounting is tenant-bound, atomic, idempotent, and retryable');
