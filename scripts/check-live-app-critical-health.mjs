#!/usr/bin/env node
const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');

async function main() {
  const healthRes = await fetch(`${appUrl}/health`);
  const healthText = await healthRes.text();
  const versionRes = await fetch(`${appUrl}/api/version`);
  const versionText = await versionRes.text();

  let health;
  try {
    health = JSON.parse(healthText);
  } catch {
    console.error('FAIL /health did not return JSON');
    process.exit(1);
  }

  const dbOk = Boolean(health?.db?.ok);
  const versionOk = versionRes.status === 200 && /"version"\s*:/.test(versionText);

  console.log(`GET /health -> ${healthRes.status}`);
  console.log(`status=${health?.status} twilioConfigured=${health?.twilioConfigured} aiConfigured=${health?.aiConfigured} db.ok=${health?.db?.ok}`);
  console.log(`GET /api/version -> ${versionRes.status}`);

  if (!dbOk || !versionOk) {
    if (!dbOk) console.log('Diagnosis: live app database path is degraded, so calls/workspace persistence are not fully healthy.');
    if (!versionOk) console.log('Diagnosis: live app is still stale or missing the current deploy freshness route.');
    process.exit(1);
  }

  console.log('OK live app critical health is green');
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
