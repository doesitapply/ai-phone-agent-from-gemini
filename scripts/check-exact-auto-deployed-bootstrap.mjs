#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  evaluateExactAutoDeployedBootstrap,
} from './lib/legacy-landing-bootstrap-readiness.mjs';
import {
  SMIRK_RAILWAY_PRODUCTION_TARGET,
  exactRailwayProductionTargetMatches,
} from './lib/first-dollar-pending-env.mjs';
import {
  railwayDeployments,
  railwayProjectContext,
} from './railway-json.mjs';

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readLiveCheck() {
  const result = spawnSync('npm', ['run', '-s', 'check:live-is-current'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 4,
  });
  try {
    return JSON.parse(String(result.stdout || '').trim());
  } catch {
    return null;
  }
}

const target = SMIRK_RAILWAY_PRODUCTION_TARGET;
const currentCommit = git('rev-parse', 'HEAD');
const targetBranch = git('branch', '--show-current') || 'main';

try {
  const context = railwayProjectContext({
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
  });
  const targetEvaluation = exactRailwayProductionTargetMatches(context);
  const deployments = railwayDeployments({
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
    first: 20,
  });
  const ordered = [...deployments].sort(
    (a, b) => Date.parse(b?.createdAt || 0) - Date.parse(a?.createdAt || 0),
  );
  const evaluation = evaluateExactAutoDeployedBootstrap({
    deployment: ordered[0] || null,
    liveCheck: readLiveCheck(),
    currentCommit,
    targetBranch,
    target,
    targetMatches: targetEvaluation.ok,
  });

  console.log(JSON.stringify(evaluation, null, 2));
  if (!evaluation.ok) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    mode: 'exact-auto-deployed-current-commit-stale-fingerprint',
    error: 'railway-auto-deploy-proof-unavailable',
    detail: error?.detail || String(error?.message || error),
  }, null, 2));
  process.exit(1);
}
