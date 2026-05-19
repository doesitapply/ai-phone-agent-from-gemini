#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

let payload;
try {
  const out = run('node', ['scripts/find-google-auth-client-id.mjs', '--json']);
  payload = JSON.parse(out);
} catch (err) {
  const stdout = err?.stdout ? String(err.stdout) : '';
  if (stdout.trim()) process.stdout.write(stdout);
  console.error('FAIL no scanned Google OAuth client ID candidate was available to apply.');
  console.error('Local scan: npm run find:google-auth-client-id');
  console.error('Setup checklist: npm run print:google-auth-setup');
  console.error('Manual fix: npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com');
  process.exit(1);
}

const hits = Array.isArray(payload?.hits) ? payload.hits : [];
const uniqueIds = [...new Set(hits.map((hit) => hit.clientId).filter(Boolean))];
if (uniqueIds.length !== 1) {
  console.error(`FAIL expected exactly 1 unique scanned client ID, found ${uniqueIds.length}.`);
  if (uniqueIds.length > 1) {
    for (const id of uniqueIds) console.error(`- ${id}`);
  }
  console.error('Local scan: npm run find:google-auth-client-id -- --json');
  console.error('Setup checklist: npm run print:google-auth-setup');
  console.error('Manual fix: npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com');
  process.exit(1);
}

const clientId = uniqueIds[0];
console.log(`Using scanned Google OAuth client ID: ${clientId}`);
const extraArgs = process.argv.slice(2);
execFileSync('bash', ['scripts/set-google-auth-env.sh', clientId, ...extraArgs], { stdio: 'inherit' });
