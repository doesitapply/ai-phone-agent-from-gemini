#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { loadRailwayAuth, railwayDeployments, railwayJson } from './railway-json.mjs';

loadRailwayAuth();

let deployments = [];
try {
  deployments = railwayJson(['deployment', 'list', '-s', 'ai-phone-agent', '--json'], {
    label: 'railway deployment list -s ai-phone-agent --json',
  });
} catch (error) {
  try {
    deployments = railwayDeployments({ first: 20 });
  } catch (graphqlError) {
    console.error(JSON.stringify({
      ok: false,
      error: 'railway-deployment-list-unavailable',
      message: 'Could not read Railway deployment list after bounded retries or GraphQL fallback. This is a Railway access problem, not proof of a failed app deploy.',
      detail: {
        cli: error?.detail || String(error?.message || error),
        graphql: graphqlError?.detail || String(graphqlError?.message || graphqlError),
      },
    }, null, 2));
    process.exit(1);
  }
}

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
