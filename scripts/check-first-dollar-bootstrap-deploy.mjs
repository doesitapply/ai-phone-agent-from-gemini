#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  DEPLOY_BRANCH_CONFIRMATION_ENV,
  DEPLOY_COMMIT_CONFIRMATION_ENV,
  DEPLOY_CONFIRMATION_ENV,
  FIRST_DOLLAR_BOOTSTRAP_MODE_ENV,
  evaluateFirstDollarBootstrapDeploy,
} from './lib/first-dollar-bootstrap-deploy.mjs';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let preflight = null;
try {
  const raw = readFileSync(0, 'utf8').trim();
  preflight = raw ? JSON.parse(raw) : null;
} catch {
  preflight = null;
}

const evaluation = evaluateFirstDollarBootstrapDeploy({
  preflight,
  targetCommit: git('rev-parse', 'HEAD'),
  targetBranch: git('branch', '--show-current') || 'main',
  bootstrapMode: process.env[FIRST_DOLLAR_BOOTSTRAP_MODE_ENV],
  deployConfirmation: process.env[DEPLOY_CONFIRMATION_ENV],
  branchConfirmation: process.env[DEPLOY_BRANCH_CONFIRMATION_ENV],
  commitConfirmation: process.env[DEPLOY_COMMIT_CONFIRMATION_ENV],
});

console.log(JSON.stringify(evaluation, null, 2));
if (!evaluation.ok) process.exit(1);
