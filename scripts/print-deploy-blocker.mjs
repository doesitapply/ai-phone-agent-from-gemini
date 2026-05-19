#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const localCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const localBranch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || 'main';
const handoffFilePath = path.resolve(process.cwd(), 'output', 'post-call-fix-handoff.json');
const handoffFileExists = fs.existsSync(handoffFilePath);

let detail = '';
try {
  execFileSync('npm', ['run', '-s', 'check:live-is-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(JSON.stringify({ ok: true, message: 'Live Railway already matches local HEAD.', localBranch, localCommit }, null, 2));
} catch (error) {
  detail = String(error?.stdout || error?.stderr || '').trim();
  let parsedDetail = null;
  try {
    parsedDetail = detail ? JSON.parse(detail) : null;
  } catch {
    parsedDetail = null;
  }
  const fingerprintDetail = parsedDetail?.detail || parsedDetail || null;
  console.log(JSON.stringify({
    ok: false,
    blocker: 'stale-production-deploy',
    requiresApproval: true,
    localBranch,
    localCommit,
    expectedVersion: parsedDetail?.expectedVersion || localCommit,
    actualVersion: parsedDetail?.actualVersion || fingerprintDetail?.actualVersion || fingerprintDetail?.versionHeader || null,
    liveBranch: parsedDetail?.actualBranch || fingerprintDetail?.actualBranch || fingerprintDetail?.branchHeader || null,
    liveReadinessHeader: fingerprintDetail?.readinessHeader || null,
    liveStatus: fingerprintDetail?.status ?? null,
    appUrl: parsedDetail?.appUrl || fingerprintDetail?.url || null,
    nextAction: "Approve and run npm run deploy:post-call-fix",
    approvalRequestCommand: "npm run print:deploy-approval-request",
    handoffFileCommand: "npm run write:post-call-fix-handoff",
    handoffFilePath,
    handoffFileExists,
    detail: parsedDetail || detail || null,
  }, null, 2));
  process.exit(1);
}
