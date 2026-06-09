#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const appUrl = (process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const raw = execFileSync('railway', ['variable', 'list', '--json'], { encoding: 'utf8' });
const vars = JSON.parse(raw);
const dbUrl = String(vars.DATABASE_URL || '').trim();

if (!dbUrl) {
  console.error(JSON.stringify({ ok: false, error: 'missing-database-url' }, null, 2));
  process.exit(1);
}

let host = null;
try {
  host = new URL(dbUrl).hostname;
} catch {
  console.error(JSON.stringify({ ok: false, error: 'invalid-database-url' }, null, 2));
  process.exit(1);
}

let liveHealth = null;
try {
  const res = await fetch(`${appUrl}/health`);
  const text = await res.text();
  const parsed = JSON.parse(text);
  liveHealth = {
    status: res.status,
    appStatus: parsed?.status || null,
    db: parsed?.db || null,
  };
} catch {
  liveHealth = null;
}

const internalHost = /railway\.internal$/i.test(host);
const dbDegraded = !!(liveHealth?.db?.enabled && liveHealth?.db?.ok === false);
const out = {
  ok: true,
  host,
  internalHost,
  liveHealth,
  warning: internalHost
    ? 'DATABASE_URL uses a Railway private host. If live DB health is degraded, reselect DATABASE_URL from the Postgres service reference variable instead of using a pasted value.'
    : null,
  diagnosis: internalHost && dbDegraded
    ? 'DATABASE_URL points at a Railway internal host and live /health reports DB degraded. Treat this as a real DB wiring/attachment failure until proven otherwise.'
    : null,
  remediation: internalHost
    ? {
        railwayUi: [
          'Open Railway project ai-phone-agent',
          'Open production environment',
          'Open app service ai-phone-agent → Variables',
          'Replace DATABASE_URL with an Add Reference value from the Postgres service in the same environment',
          'Common reference forms: ${{Postgres.DATABASE_URL}} or ${{postgres.DATABASE_URL}} depending on the service name',
        ],
        verifyCommands: [
          'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix',
          'npm run check:live-db-health',
          'npm run check:post-deploy-live',
        ],
      }
    : null,
};

if (internalHost && dbDegraded) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(out, null, 2));
