#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const expectedVersion = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const expectedBranch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || 'main';
const deployCommand = expectedBranch !== 'main'
  ? `CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=${expectedBranch} npm run deploy:post-call-fix`
  : 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix';
const env = { ...process.env, SMIRK_EXPECT_VERSION: expectedVersion, SMIRK_EXPECT_BRANCH: expectedBranch };

try {
  const out = execFileSync('node', ['scripts/check-deploy-fingerprint.mjs'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(out.trim());
} catch (error) {
  const text = String(error?.stdout || error?.stderr || error?.message || '').trim();
  let detail = null;
  try {
    detail = text ? JSON.parse(text) : null;
  } catch {
    detail = null;
  }

  if (detail?.failure === 'version-mismatch' || detail?.failure === 'branch-mismatch') {
    console.log(JSON.stringify({
      ok: false,
      blocker: 'stale-production-deploy',
      message: 'Live Railway does not match local HEAD yet.',
      expectedBranch,
      expectedVersion,
      actualBranch: detail.actualBranch || detail.branchHeader || null,
      actualVersion: detail.actualVersion || detail.versionHeader || null,
      appUrl: detail.url || null,
      liveReadinessHeader: detail.readinessHeader || null,
      liveStatus: detail.status ?? null,
      nextAction: `Generate the approval bundle, get approval, then run ${deployCommand}`,
      approvalBundleCommand: 'npm run write:deploy-approval-bundle',
      approvalBundlePath: 'output/deploy-approval-bundle.json',
      nextChecks: [
        'npm run write:deploy-approval-bundle',
        'npm run -s check:latest-failed-deploy',
        deployCommand
      ],
      detail,
    }, null, 2));
  } else if (text) {
    console.log(text);
  }
  process.exit(1);
}
