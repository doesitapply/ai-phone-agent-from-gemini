#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function loadRailwayAuth() {
  try {
    execFileSync('bash', ['-lc', 'source ./scripts/load-railway-auth.sh >/dev/null 2>&1 && env | grep -E "^(RAILWAY_API_TOKEN|RAILWAY_TOKEN)="'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        const eq = line.indexOf('=');
        if (eq === -1) return;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key && value && !process.env[key]) process.env[key] = value;
      });
  } catch {
    // let railway surface auth issues normally
  }
}

loadRailwayAuth();

const raw = execFileSync('railway', ['deployment', 'list', '-s', 'ai-phone-agent', '--json'], { encoding: 'utf8' });
const deployments = JSON.parse(raw);
const failed = deployments.find((d) => String(d?.status || '').toUpperCase() === 'FAILED');

if (!failed?.id) {
  console.log('OK no failed deployments found for ai-phone-agent');
  process.exit(0);
}

console.log(`Latest failed deployment: ${failed.id}`);
console.log(`Created: ${failed.createdAt || '(unknown)'}`);

let logs = '';
try {
  logs = execFileSync('railway', ['logs', '--build', failed.id, '--lines', '120'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 8 });
} catch (error) {
  const stdout = error?.stdout || '';
  const stderr = error?.stderr || '';
  logs = `${stdout}${stderr}`;
}

const interesting = logs
  .split(/\r?\n/)
  .filter((line) => /error|failed|cannot|missing|denied|not found|panic|exception/i.test(line))
  .slice(-40);

if (interesting.length) {
  console.log('Interesting failure lines:');
  for (const line of interesting) console.log(line);
} else {
  console.log('No filtered error lines found; recent build log tail:');
  console.log(logs.split(/\r?\n/).slice(-40).join('\n'));
}
