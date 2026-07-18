#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const raw = execFileSync('npm', ['run', '-s', 'print:post-call-fix-handoff'], { encoding: 'utf8' }).trim();
const data = JSON.parse(raw);
const approval = data.approvalRequest || {};
const blocker = data.blockerStatus || {};

const highRiskStats = Array.isArray(approval.highRiskDiffStats) ? approval.highRiskDiffStats : [];
const highRiskReasons = approval.highRiskFileReasons || {};
const deployFileCount = Array.isArray(approval.deployRelevantFiles)
  ? approval.deployRelevantFiles.length
  : (Array.isArray(approval.deployRelevantDirtyFiles)
    ? approval.deployRelevantDirtyFiles.length
    : null);
const deployDirtyCount = Array.isArray(approval.deployRelevantDirtyFiles)
  ? approval.deployRelevantDirtyFiles.length
  : null;
const blockerName = deployFileCount && approval.liveVersionCurrent !== true
  ? 'stale-production-deploy'
  : (blocker.blocker || blocker.failure || blocker.message || 'unknown');
const deployState = approval.deployState || data.deployState || null;
const blockerDetail = approval.blockerDetail || data.blockerDetail || null;
const blockerNextAction = deployFileCount && approval.command
  ? `Get approval, then run ${approval.command}`
  : (blocker.nextAction || approval.reason || 'unknown');
const bundlePath = path.resolve(process.cwd(), 'output', 'deploy-approval-bundle.json');
let bundleMeta = {};
if (process.env.SMIRK_SKIP_BUNDLE_REFRESH === '1') {
  try {
    bundleMeta = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  } catch {
    bundleMeta = {};
  }
} else {
  try {
    const refreshed = execFileSync('node', ['scripts/write-deploy-approval-bundle.mjs'], { encoding: 'utf8' }).trim();
    bundleMeta = JSON.parse(refreshed);
  } catch (error) {
    try {
      bundleMeta = JSON.parse(String(error?.stdout || '').trim());
    } catch {
      try {
        bundleMeta = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
      } catch {
        bundleMeta = {};
      }
    }
  }
}
const approvalNoteFreshness = bundleMeta.artifacts?.approvalNote?.mtime || new Date().toISOString();
const deployPreflightRequiredPasses = Array.isArray(approval.deployPreflightRequiredPasses)
  ? approval.deployPreflightRequiredPasses
  : (Array.isArray(data.deployPreflightRequiredPasses)
      ? data.deployPreflightRequiredPasses
      : (Array.isArray(bundleMeta.deployPreflightRequiredPasses)
          ? bundleMeta.deployPreflightRequiredPasses
          : []));
const deployPreflightRequiredPassesLine = deployPreflightRequiredPasses.length
  ? `Required passes: ${deployPreflightRequiredPasses.join(', ')}.`
  : 'Required passes: unavailable.';
const postDeployStripeWebhookSmokeApprovalPhrase = approval.postDeployStripeWebhookSmokeApprovalPhrase
  || data.postDeployStripeWebhookSmokeApprovalPhrase
  || bundleMeta.postDeployStripeWebhookSmokeApprovalPhrase
  || 'APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live';
const postDeploySmokeCleanupApplyApprovalPhrase = approval.postDeploySmokeCleanupApplyApprovalPhrase
  || data.postDeploySmokeCleanupApplyApprovalPhrase
  || bundleMeta.postDeploySmokeCleanupApplyApprovalPhrase
  || 'APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply';
const deployApprovalToken = approval.deployApprovalToken
  || data.deployApprovalToken
  || bundleMeta.deployApprovalToken
  || 'APPROVE_SMIRK_POST_CALL_FIX_DEPLOY';
const deployApprovalMeaning = approval.deployApprovalMeaning
  || data.deployApprovalMeaning
  || bundleMeta.deployApprovalMeaning
  || 'Production deploy approval only. This does not authorize a Git push, Stripe smoke, cleanup apply, proof calls, secret access, paid spend, outreach, or activation of a staged first-dollar environment manifest; pending activation requires the exact staged digest plus distinct activation-deploy and real Starter checkout authority.';
const gitRemoteSync = approval.gitRemoteSync
  || data.gitRemoteSync
  || bundleMeta.gitRemoteSync
  || 'unknown';
const branchReconcileRequired = approval.branchReconcileRequired === true
  || data.branchReconcileRequired === true
  || bundleMeta.branchReconcileRequired === true;

const note = [
  '# SMIRK deploy approval request',
  '',
  '## Approval decision summary',
  '- Approve only the production deploy of the pending first-dollar hardening bundle.',
  '- This deploy is required before a fresh proof call can verify the updated missed-call recovery path.',
  '- This approval does not claim first-dollar readiness by itself.',
  '- After deploy, run the post-deploy ship checks and one fresh pinned proof call before outreach.',
  `- Approval token: ${deployApprovalToken}`,
  `- Approval meaning: ${deployApprovalMeaning}`,
  '',
  `- Branch: ${approval.branch || 'unknown'}`,
  `- Commit: ${approval.commit || 'unknown'}`,
  `- Git remote sync: ${gitRemoteSync}`,
  `- Branch reconciliation required: ${branchReconcileRequired ? 'yes' : 'no'}`,
  `- Live version current: ${approval.liveVersionCurrent === true ? 'yes' : 'no'}`,
  `- Deploy state: ${deployState || 'unknown'}`,
  `- Blocker detail: ${blockerDetail || 'unknown'}`,
  `- Live fingerprint current: ${approval.liveFingerprintCurrent === true ? 'yes' : 'no'}`,
  `- Local deploy clean: ${approval.localDeployClean === true ? 'yes' : 'no'}`,
  `- Expected version: ${approval.expectedVersion || approval.commit || 'unknown'}`,
  `- Actual live version: ${approval.actualVersion || 'unknown'}`,
  `- Live branch: ${approval.liveBranch || 'unknown'}`,
  `- Deploy branch mismatch: ${approval.deployBranchMismatch === true ? 'yes' : 'no'}`,
  `- Deploy branch mismatch reason: ${approval.deployBranchMismatchReason || 'none'}`,
  `- Changed file count: ${approval.changedFileCount ?? 'unknown'}`,
  `- Deploy review base: ${approval.deployReviewBaseRef || 'unknown'} (${approval.deployReviewBaseSource || 'unknown'})`,
  `- Committed deploy-relevant files: ${Array.isArray(approval.committedDeployRelevantFiles) ? approval.committedDeployRelevantFiles.length : 'unknown'}`,
  `- Dirty deploy-relevant files: ${deployDirtyCount ?? 'unknown'}`,
  `- High-risk file count: ${approval.highRiskFileCount ?? 'unknown'}`,
  `- Approval bundle generated at: ${bundleMeta.generatedAt || 'unknown'}`,
  `- Approval bundle source commit: ${bundleMeta.sourceCommit || approval.commit || 'unknown'}`,
  `- Approval artifact freshness: handoff ${bundleMeta.artifacts?.handoff?.mtime || 'unknown'}; approval request ${bundleMeta.artifacts?.approvalRequest?.mtime || 'unknown'}; approval note ${approvalNoteFreshness}; high-risk review ${bundleMeta.artifacts?.highRiskReview?.mtime || 'unknown'}`,
  `- Live health check: ${bundleMeta.liveHealth?.status ?? 'unknown'} @ ${bundleMeta.liveHealth?.url || 'unknown'} (readiness ${bundleMeta.liveHealth?.readinessHeader || 'unknown'}, branch ${bundleMeta.liveHealth?.branchHeader || 'unknown'}, version ${bundleMeta.liveHealth?.versionHeader || 'unknown'}, failure ${bundleMeta.liveHealth?.failure || 'none'})`,
  `- Approval bundle command: npm run write:deploy-approval-bundle`,
  `- High-risk review command: npm run print:high-risk-deploy-review`,
  `- Deploy command: ${approval.command || 'unknown'}`,
  `- Reason: ${approval.reason || 'unknown'}`,
  '',
  '## Approval artifacts',
  '- output/deploy-approval-bundle.json',
  '- output/deploy-approval-request.json',
  '- output/post-call-fix-handoff.json',
  '- output/post-call-fix-approval-note.md',
  '- output/high-risk-deploy-review.json',
  '',
  '## Approval steps',
  '- 1. npm run write:deploy-approval-bundle',
  '- 2. npm run print:high-risk-deploy-review',
  `- 3. Get explicit ${deployApprovalToken} approval from Cameron.`,
  `- 4. ${approval.command || 'unknown'}`,
  '',
  '## Deploy preflight evidence required',
  '- Before deploy: npm run -s check:deploy-post-call-fix-ready',
  `- ${deployPreflightRequiredPassesLine}`,
  '- Expected blocker after those passes: stale-production-deploy.',
  '- If any required pass is missing, do not deploy.',
  '',
  '## Post-deploy Gate 4 proof',
  '- Deploy approval only ships the pending proof-hardening bundle; it does not prove the missed-call recovery outcome by itself.',
  '- 1. npm run -s check:ship-live',
  '- 2. WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag',
  '- 3. npm run -s check:real-call-readiness -- <safe-number>',
  '- 4. Get target-specific approval: APPROVE_SMIRK_REAL_PROOF_CALL: <exact-approved-e164>',
  "- 5. CONFIRM_SMIRK_REAL_PROOF_CALL=place-one-smirk-real-proof-call CONFIRM_SMIRK_REAL_PROOF_CALL_TARGET='<exact-approved-e164>' npm run -s proof:real-call -- '<exact-approved-e164>'",
  '- The proof runner re-runs check:post-deploy-live, then requires both exact confirmations after readiness and before dialing. Readiness or deploy approval alone never authorizes a call.',
  '- The webhook buffer lag check verifies that received/retry Twilio payloads are not silently aging before proof calls.',
  '- Real-call readiness runs first-dollar guard coverage before clearing a proof call.',
  '- Expected proof: call record, generated summary, owner email alert, callback task, and dashboard proof counters.',
  '- Do not place a real proof call until check:real-call-readiness passes and APPROVE_SMIRK_REAL_PROOF_CALL names the same exact E.164 number.',
  '',
  '## Post-deploy Gate 3 payment/provisioning smoke',
  '- Deploy approval does not authorize the signed Stripe webhook smoke.',
  '- Run the Stripe webhook smoke only after this exact approval phrase:',
  `- ${postDeployStripeWebhookSmokeApprovalPhrase}`,
  '- Confirmed smoke cleanup requires separate approval after reviewing the cleanup dry-run.',
  `- ${postDeploySmokeCleanupApplyApprovalPhrase}`,
  '',
  '## High-risk files',
  ...(highRiskStats.length > 0
    ? highRiskStats.map((item) => {
        const reason = highRiskReasons[item.file] ? ` — ${highRiskReasons[item.file]}` : '';
        return `- ${item.file}: +${item.added} / -${item.removed}${reason}`;
      })
    : ['- none reported']),
  '',
  '## Current blocker',
  `- ${blockerName}`,
  `- Deploy state: ${deployState || 'unknown'}`,
  `- Detail: ${blockerDetail || 'unknown'}`,
  `- Deploy-relevant pending files: ${deployFileCount ?? 'unknown'}`,
  `- Next action: ${blockerNextAction}`,
].join('\n');

const target = path.resolve(process.cwd(), 'output', 'post-call-fix-approval-note.md');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, note + '\n');
console.log(JSON.stringify({ ok: true, path: target }, null, 2));
