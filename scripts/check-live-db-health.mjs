#!/usr/bin/env node

const url = `${(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '')}/health`;

const res = await fetch(url);
const text = await res.text();
let parsed = null;
try {
  parsed = JSON.parse(text);
} catch {
  console.error(JSON.stringify({ ok: false, url, status: res.status, error: 'invalid-json', sample: text.slice(0, 200) }, null, 2));
  process.exit(1);
}

const dbEnabled = !!parsed?.db?.enabled;
const dbOk = !!parsed?.db?.ok;
const appStatus = parsed?.status || 'unknown';
const out = {
  ok: res.ok && (!dbEnabled || dbOk),
  url,
  status: res.status,
  appStatus,
  db: parsed?.db || null,
  version: parsed?.version || null,
  branch: parsed?.branch || null,
};

if (!res.ok) {
  console.error(JSON.stringify({ ...out, error: 'http-failure' }, null, 2));
  process.exit(1);
}

if (dbEnabled && !dbOk) {
  console.error(JSON.stringify({ ...out, error: 'db-unreachable', likelyCause: 'Live app booted but Postgres is degraded/unreachable. Verify Railway Postgres service attachment and DATABASE_URL wiring.' }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(out, null, 2));
