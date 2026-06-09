#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

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

function checkDeployGuidanceSafety() {
  const files = [
    'scripts/check-live-deploy-readiness.mjs',
    'scripts/check-railway-db-wiring.mjs',
    'scripts/check-live-is-current.mjs',
    'scripts/wait-for-live-current.mjs',
  ];
  const failures = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (/\.\/deploy\.sh|bash deploy\.sh|railway up --detach/.test(text)) {
      failures.push(`${file}: operator-facing remediation must use the confirmed deploy command, not direct deploy helpers`);
    }
  }
  return {
    ok: failures.length === 0,
    output: failures.length ? failures.join('\n') : 'OK deploy guidance uses the confirmed deploy command',
  };
}

const railway = run('npm', ['run', '-s', 'check:railway']);
const proofDocs = run('npm', ['run', '-s', 'check:real-call-docs']);
const targetSafety = run('npm', ['run', '-s', 'check:real-call-target-safety']);
const allowlistSafety = run('npm', ['run', '-s', 'check:test-call-allowlist-safety']);
const noTextingCopy = run('npm', ['run', '-s', 'check:no-texting-copy']);
const deployGuidanceSafety = checkDeployGuidanceSafety();
const handoffSafety = run('npm', ['run', '-s', 'check:deploy-approval-handoff']);
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
const status = run('git', ['status', '--porcelain']);
const dirtyFiles = status.ok
  ? status.output.split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => {
      const file = line.replace(/^.{1,2}\s+/, '').replace(/^.* -> /, '').trim();
      const statusCode = line.slice(0, 2).trim();
      if (statusCode === '??' && existsSync(file) && statSync(file).isDirectory()) {
        return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', file], { encoding: 'utf8' })
          .split(/\r?\n/)
          .filter(Boolean)
          .map((entry) => `?? ${entry}`);
      }
      return [line];
    })
  : [];
const deployRelevantDirtyFiles = dirtyFiles.filter((line) => {
  const file = line.replace(/^.{1,2}\s+/, '').replace(/^.* -> /, '');
  return !file.startsWith('output/') && !file.startsWith('tmp/');
});
const hasDeployRelevantDirtyFiles = deployRelevantDirtyFiles.length > 0;
const gitRemoteSync = localCommit.ok && remoteCommit.ok && mergeBase.ok
  ? (localCommit.output === remoteCommit.output
      ? 'current'
      : (mergeBase.output === remoteCommit.output ? 'ahead' : 'diverged'))
  : 'unknown';
const railwayAuthMissing = !railway.ok && /Railway auth missing/i.test(railway.output || '');
const railwayAuthInvalid = !railway.ok && !railwayAuthMissing;
const needsDeploy = hasDeployRelevantDirtyFiles || !live.ok;
const deployCommand = 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix';
const blocker = !proofDocs.ok
  ? 'real-proof-call-docs-drift'
  : (!targetSafety.ok
    ? 'real-proof-call-target-safety-drift'
    : (!allowlistSafety.ok
      ? 'test-call-allowlist-safety-drift'
      : (!noTextingCopy.ok
      ? 'no-texting-copy-drift'
      : (!deployGuidanceSafety.ok
      ? 'deploy-guidance-safety-drift'
      : (!handoffSafety.ok
      ? 'deploy-approval-handoff-drift'
      : (railwayAuthMissing
      ? 'railway-auth-missing'
      : (railwayAuthInvalid
        ? 'railway-auth-invalid'
        : (gitRemoteSync === 'diverged'
          ? 'git-remote-diverged'
          : (needsDeploy ? 'stale-production-deploy' : 'live-already-current')))))))));
const out = {
  ok: proofDocs.ok && targetSafety.ok && allowlistSafety.ok && noTextingCopy.ok && deployGuidanceSafety.ok && handoffSafety.ok && railway.ok && needsDeploy && gitRemoteSync !== 'diverged',
  blocker,
  proofDocs: proofDocs.ok ? 'pass' : 'fail',
  targetSafety: targetSafety.ok ? 'pass' : 'fail',
  allowlistSafety: allowlistSafety.ok ? 'pass' : 'fail',
  noTextingCopy: noTextingCopy.ok ? 'pass' : 'fail',
  deployGuidanceSafety: deployGuidanceSafety.ok ? 'pass' : 'fail',
  handoffSafety: handoffSafety.ok ? 'pass' : 'fail',
  railwayAccess: railway.ok ? 'pass' : 'fail',
  liveCurrent: live.ok && !hasDeployRelevantDirtyFiles ? 'pass' : 'stale',
  deployRelevantDirtyFiles,
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
        deployCommand
      ]
    : null,
  expectedVersion: hasDeployRelevantDirtyFiles ? 'pending-local-commit' : (liveParsed?.expectedVersion || liveFingerprint?.expectedVersion || (localCommit.ok ? localCommit.output : null)),
  actualVersion: liveParsed?.actualVersion || liveFingerprint?.actualVersion || liveFingerprint?.versionHeader || null,
  liveBranch: liveParsed?.actualBranch || liveFingerprint?.actualBranch || liveFingerprint?.branchHeader || null,
  liveReadinessHeader: liveFingerprint?.readinessHeader || null,
  deployCommand,
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
        deployCommand
      ]
    : (railwayAuthMissing
      ? ['npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy']
      : null),
  authNextSteps: (railwayAuthMissing || railwayAuthInvalid)
    ? [
        'npm run -s check:railway',
        'npm run -s check:deploy-post-call-fix-ready',
        'npm run write:deploy-approval-bundle',
        deployCommand
      ]
    : null,
  nextAction: railwayAuthMissing
    ? 'Run npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy, then copy a real Railway token when the page opens; the helper will run auth checks, generate the approval bundle, and deploy.'
    : (railwayAuthInvalid
      ? 'Replace the invalid Railway token, then rerun deploy readiness, generate the approval bundle, and deploy.'
      : (gitRemoteSync === 'diverged'
        ? 'Reconcile local branch with origin/main before deploy.'
        : (railway.ok && needsDeploy ? `Generate the approval bundle, get approval, then run ${deployCommand}` : null))),
  approvalBundleCommand: (railwayAuthMissing || railwayAuthInvalid || (railway.ok && needsDeploy)) ? 'npm run write:deploy-approval-bundle' : null,
  approvalBundlePath: (railwayAuthMissing || railwayAuthInvalid || (railway.ok && needsDeploy)) ? 'output/deploy-approval-bundle.json' : null,
  proofDocsDetail: proofDocs.output || null,
  targetSafetyDetail: targetSafety.output || null,
  allowlistSafetyDetail: allowlistSafety.output || null,
  noTextingCopyDetail: noTextingCopy.output || null,
  deployGuidanceSafetyDetail: deployGuidanceSafety.output || null,
  handoffSafetyDetail: handoffSafety.output || null,
  railwayDetail: railway.output || null,
  liveDetail: liveParsed || live.output || null,
  gitFetchDetail: gitFetch.output || null,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
