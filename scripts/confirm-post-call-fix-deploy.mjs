#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const expected = 'deploy-post-call-fix';
const actual = String(process.env.CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY || '').trim();
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || 'main';
const branchConfirmation = String(process.env.CONFIRM_SMIRK_DEPLOY_BRANCH || '').trim();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const commitConfirmation = String(process.env.CONFIRM_SMIRK_DEPLOY_COMMIT || '').trim();
const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8' });
const bundlePath = 'output/deploy-approval-bundle.json';

if (actual !== expected) {
  console.error(JSON.stringify({
    ok: false,
    error: 'missing-deploy-confirmation',
    requiredEnv: 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY',
    requiredValue: expected,
    nextAction: `Run only after explicit approval: CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=${expected} npm run deploy:post-call-fix`,
  }, null, 2));
  process.exit(1);
}

if (branch !== 'main' && branchConfirmation !== branch) {
  console.error(JSON.stringify({
    ok: false,
    error: 'missing-branch-deploy-confirmation',
    branch,
    requiredEnv: 'CONFIRM_SMIRK_DEPLOY_BRANCH',
    requiredValue: branch,
    nextAction: `Run only after explicit approval for this branch: CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=${expected} CONFIRM_SMIRK_DEPLOY_BRANCH=${branch} npm run deploy:post-call-fix`,
  }, null, 2));
  process.exit(1);
}

if (commitConfirmation !== commit) {
  console.error(JSON.stringify({
    ok: false,
    error: 'missing-exact-commit-deploy-confirmation',
    commit,
    requiredEnv: 'CONFIRM_SMIRK_DEPLOY_COMMIT',
    requiredValue: commit,
    nextAction: `Regenerate and review the clean deploy approval packet, then approve the exact command containing CONFIRM_SMIRK_DEPLOY_COMMIT=${commit}.`,
  }, null, 2));
  process.exit(1);
}

if (status.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    error: 'deploy-worktree-not-clean',
    nextAction: 'Commit the intended source changes, verify the clean exact commit, and regenerate the deploy approval packet before requesting approval.',
  }, null, 2));
  process.exit(1);
}

if (!existsSync(bundlePath)) {
  console.error(JSON.stringify({ ok: false, error: 'deploy-approval-bundle-missing', bundlePath }, null, 2));
  process.exit(1);
}
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
if (
  bundle.ok !== true
  || bundle.deployReviewBaseVerified !== true
  || bundle.sourceCommit !== commit
  || bundle.localCommit !== commit
  || !Array.isArray(bundle.deployRelevantDirtyFiles)
  || bundle.deployRelevantDirtyFiles.length !== 0
) {
  console.error(JSON.stringify({
    ok: false,
    error: 'deploy-approval-bundle-not-bound-to-clean-commit',
    commit,
    bundleSourceCommit: bundle.sourceCommit || null,
    bundleLocalCommit: bundle.localCommit || null,
    bundleOk: bundle.ok === true,
    deployReviewBaseVerified: bundle.deployReviewBaseVerified === true,
    dirtyFileCount: Array.isArray(bundle.deployRelevantDirtyFiles) ? bundle.deployRelevantDirtyFiles.length : null,
    nextAction: 'Regenerate and validate the deploy approval bundle for this clean exact commit, then request approval again.',
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  confirmation: 'pass',
  requiredEnv: 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY',
  requiredValue: expected,
  branch,
  branchConfirmation: branch === 'main' ? 'not-required' : 'pass',
  commit,
  commitConfirmation: 'pass',
  approvalBundle: 'exact-clean-commit',
}, null, 2));
