#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

function runJson(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: true, data: JSON.parse(out) };
  } catch (error) {
    const out = String(error?.stdout || error?.stderr || error?.message || '').trim();
    try {
      return { ok: false, data: JSON.parse(out) };
    } catch {
      return { ok: false, data: { raw: out || null } };
    }
  }
}

const approval = runJson('npm', ['run', '-s', 'print:deploy-approval-request']);
const blocker = runJson('npm', ['run', '-s', 'print:deploy-blocker']);

const approvalData = approval.data || null;
const blockerData = blocker.data || null;
const blockerDetail = blockerData?.detail || null;
const fingerprintDetail = blockerDetail?.detail || blockerDetail || null;

const artifactPaths = {
  handoffJson: 'output/post-call-fix-handoff.json',
  approvalRequest: 'output/deploy-approval-request.json',
  approvalNote: 'output/post-call-fix-approval-note.md',
  highRiskReview: 'output/high-risk-deploy-review.json',
  approvalBundle: 'output/deploy-approval-bundle.json',
};
const approvalBundleCommand = 'npm run write:deploy-approval-bundle';
const highRiskReviewCommand = 'npm run print:high-risk-deploy-review';
const deployCommand = approvalData?.command || 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix';

console.log(JSON.stringify({
  ok: approval.ok,
  handoff: 'post-call-fix-deploy',
  requiresApproval: approvalData?.requiresApproval === true || blockerData?.requiresApproval === true,
  liveVersionCurrent: approvalData?.liveVersionCurrent === true,
  expectedVersion: approvalData?.expectedVersion || blockerData?.expectedVersion || blockerData?.localCommit || null,
  actualVersion: approvalData?.actualVersion || blockerData?.actualVersion || null,
  changedFileCount: approvalData?.changedFileCount ?? null,
  changedFileGroups: approvalData?.changedFileGroups || null,
  highRiskFileCount: approvalData?.highRiskFileCount ?? null,
  highRiskFiles: approvalData?.highRiskFiles || null,
  highRiskDiffStats: approvalData?.highRiskDiffStats || null,
  highRiskFileReasons: approvalData?.highRiskFileReasons || null,
  artifactPaths,
  approvalBundleCommand,
  highRiskReviewCommand,
  deployCommand,
  approvalSteps: [approvalBundleCommand, highRiskReviewCommand, deployCommand],
  nextAction: blockerData?.nextAction || approvalData?.command || null,
  liveHealth: {
    url: fingerprintDetail?.url || null,
    status: fingerprintDetail?.status ?? null,
    readinessHeader: fingerprintDetail?.readinessHeader || blockerData?.liveReadinessHeader || null,
    branchHeader: blockerData?.liveBranch || fingerprintDetail?.branchHeader || approvalData?.liveBranch || null,
    versionHeader: blockerData?.actualVersion || fingerprintDetail?.actualVersion || fingerprintDetail?.versionHeader || approvalData?.actualVersion || null,
    failure: fingerprintDetail?.failure || blockerDetail?.failure || blockerData?.failure || null,
  },
  approvalRequest: approvalData,
  blockerStatus: blockerData,
}, null, 2));

if (!approval.ok) process.exit(1);
