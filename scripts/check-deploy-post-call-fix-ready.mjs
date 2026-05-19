#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function run(command, args) {
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: true, output };
  } catch (error) {
    return {
      ok: false,
      output: String(error?.stdout || error?.stderr || error?.message || '').trim(),
    };
  }
}

const railway = run('npm', ['run', '-s', 'check:railway']);
const live = run('npm', ['run', '-s', 'check:live-is-current']);

let liveParsed = null;
try {
  liveParsed = live.output ? JSON.parse(live.output) : null;
} catch {
  liveParsed = null;
}
const liveFingerprint = liveParsed?.detail || liveParsed || null;

const localCommit = run('git', ['rev-parse', 'HEAD']);
const branch = run('git', ['branch', '--show-current']);
const out = {
  ok: railway.ok && !live.ok,
  railwayAccess: railway.ok ? 'pass' : 'fail',
  liveCurrent: live.ok ? 'pass' : 'stale',
  requiresApproval: true,
  localBranch: branch.ok ? branch.output : null,
  localCommit: localCommit.ok ? localCommit.output : null,
  expectedVersion: liveParsed?.expectedVersion || liveFingerprint?.expectedVersion || (localCommit.ok ? localCommit.output : null),
  actualVersion: liveParsed?.actualVersion || liveFingerprint?.actualVersion || liveFingerprint?.versionHeader || null,
  liveBranch: liveParsed?.actualBranch || liveFingerprint?.actualBranch || liveFingerprint?.branchHeader || null,
  liveReadinessHeader: liveFingerprint?.readinessHeader || null,
  deployCommand: 'npm run deploy:post-call-fix',
  nextAction: railway.ok && !live.ok ? 'Approve and run npm run deploy:post-call-fix' : null,
  railwayDetail: railway.output || null,
  liveDetail: liveParsed || live.output || null,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
