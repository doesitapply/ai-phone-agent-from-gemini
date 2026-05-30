#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function run(command, args) {
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: true, output };
  } catch (error) {
    const stdout = String(error?.stdout || '').trim();
    const stderr = String(error?.stderr || '').trim();
    const message = String(error?.message || '').trim();
    const parts = [];
    if (stdout) parts.push(stdout);
    if (stderr && !stderr.startsWith('Command failed:')) parts.push(stderr);
    if (!parts.length && message) parts.push(message);
    return {
      ok: false,
      output: parts.join('\n\n').trim(),
    };
  }
}

const railway = run('npm', ['run', '-s', 'check:railway']);
const live = run('npm', ['run', '-s', 'check:live-is-current']);
const gitFetch = run('git', ['fetch', 'origin', 'main']);

let liveParsed = null;
try {
  liveParsed = live.output ? JSON.parse(live.output) : null;
} catch {
  liveParsed = null;
}
const liveFingerprint = liveParsed?.detail || liveParsed || null;

const localCommit = run('git', ['rev-parse', 'HEAD']);
const branch = run('git', ['branch', '--show-current']);
const remoteCommit = run('git', ['rev-parse', 'origin/main']);
const mergeBase = run('git', ['merge-base', 'HEAD', 'origin/main']);
const gitRemoteSync = localCommit.ok && remoteCommit.ok && mergeBase.ok
  ? (localCommit.output === remoteCommit.output
      ? 'current'
      : (mergeBase.output === remoteCommit.output ? 'ahead' : 'diverged'))
  : 'unknown';
const railwayAuthMissing = !railway.ok && /Railway auth missing/i.test(railway.output || '');
const railwayAuthInvalid = !railway.ok && !railwayAuthMissing;
const out = {
  ok: railway.ok && !live.ok && gitRemoteSync !== 'diverged',
  blocker: railwayAuthMissing
    ? 'railway-auth-missing'
    : (railwayAuthInvalid
      ? 'railway-auth-invalid'
      : (gitRemoteSync === 'diverged' ? 'git-remote-diverged' : (live.ok ? 'live-already-current' : 'stale-production-deploy'))),
  railwayAccess: railway.ok ? 'pass' : 'fail',
  liveCurrent: live.ok ? 'pass' : 'stale',
  requiresApproval: railway.ok,
  localBranch: branch.ok ? branch.output : null,
  localCommit: localCommit.ok ? localCommit.output : null,
  remoteBranch: 'origin/main',
  remoteCommit: remoteCommit.ok ? remoteCommit.output : null,
  gitRemoteSync,
  gitRemoteSyncHelp: gitRemoteSync === 'diverged'
    ? [
        'git stash push -u -m "smirk-deploy-divergence"',
        'git pull --rebase origin main',
        'git stash pop',
        'npm run deploy:post-call-fix'
      ]
    : null,
  expectedVersion: liveParsed?.expectedVersion || liveFingerprint?.expectedVersion || (localCommit.ok ? localCommit.output : null),
  actualVersion: liveParsed?.actualVersion || liveFingerprint?.actualVersion || liveFingerprint?.versionHeader || null,
  liveBranch: liveParsed?.actualBranch || liveFingerprint?.actualBranch || liveFingerprint?.branchHeader || null,
  liveReadinessHeader: liveFingerprint?.readinessHeader || null,
  deployCommand: 'npm run deploy:post-call-fix',
  authSetupCommand: (railwayAuthMissing || railwayAuthInvalid) ? 'npm run -s print:railway-auth-setup' : null,
  authOpenTokenPageCommand: (railwayAuthMissing || railwayAuthInvalid) ? 'npm run -s open:railway-token-page' : null,
  authStatusCommand: (railwayAuthMissing || railwayAuthInvalid) ? 'npm run -s print:railway-auth-status' : null,
  authInitCommand: (railwayAuthMissing || railwayAuthInvalid) ? 'npm run -s init:railway-auth-file' : null,
  authBootstrapCommand: (railwayAuthMissing || railwayAuthInvalid)
    ? "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth"
    : null,
  authReplaceCommand: railwayAuthInvalid
    ? "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth"
    : null,
  authOneShotCommand: (railwayAuthMissing || railwayAuthInvalid)
    ? "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy"
    : null,
  authReplaceAndDeployCommand: railwayAuthInvalid
    ? "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy"
    : null,
  authPrimaryCommand: (railwayAuthMissing || railwayAuthInvalid)
    ? 'npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy'
    : null,
  authRecommendedSequence: railwayAuthInvalid
    ? [
        'npm run -s open:railway-token-page',
        "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth",
        'npm run -s check:deploy-post-call-fix-ready',
        'npm run write:deploy-approval-bundle',
        'npm run deploy:post-call-fix'
      ]
    : (railwayAuthMissing
      ? ['npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy']
      : null),
  authNextSteps: (railwayAuthMissing || railwayAuthInvalid)
    ? [
        'npm run -s check:railway',
        'npm run -s check:deploy-post-call-fix-ready',
        'npm run write:deploy-approval-bundle',
        'npm run deploy:post-call-fix'
      ]
    : null,
  nextAction: railwayAuthMissing
    ? 'Run npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy, then copy a real Railway token when the page opens; the helper will run auth checks, generate the approval bundle, and deploy.'
    : (railwayAuthInvalid
      ? 'Replace the invalid Railway token, then rerun deploy readiness, generate the approval bundle, and deploy.'
      : (gitRemoteSync === 'diverged'
        ? 'Reconcile local branch with origin/main before deploy.'
        : (railway.ok && !live.ok ? 'Generate the approval bundle, get approval, then run npm run deploy:post-call-fix' : null))),
  approvalBundleCommand: (railwayAuthMissing || railwayAuthInvalid || (railway.ok && !live.ok)) ? 'npm run write:deploy-approval-bundle' : null,
  approvalBundlePath: (railwayAuthMissing || railwayAuthInvalid || (railway.ok && !live.ok)) ? 'output/deploy-approval-bundle.json' : null,
  railwayDetail: railway.output || null,
  liveDetail: liveParsed || live.output || null,
  gitFetchDetail: gitFetch.output || null,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
