#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectDeployChangeSet, resolveAuthoritativeLiveDeployReviewBase } from './lib/deploy-change-set.mjs';
import { railwayVariables } from './railway-json.mjs';

const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const run = (cmd, args, options = {}) => execFileSync(cmd, args, {
  encoding: 'utf8',
  maxBuffer: EXEC_MAX_BUFFER,
  ...options,
}).trim();
const authoritativeBase = resolveAuthoritativeLiveDeployReviewBase();
const liveCheck = authoritativeBase.liveCheck;
const liveReviewBaseRef = authoritativeBase.ref;
const approvalEnv = {
  ...process.env,
  SMIRK_DEPLOY_REVIEW_BASE_REF: liveReviewBaseRef,
  SMIRK_DEPLOY_LIVE_CHECK_JSON: JSON.stringify(liveCheck),
};
let customerPolicyVersion = String(process.env.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || '').trim();
if (!customerPolicyVersion) {
  try {
    customerPolicyVersion = String(railwayVariables()?.SMIRK_CUSTOMER_POLICY_APPROVED_VERSION || '').trim();
  } catch {
    // The packet remains usable as a blocker handoff when Railway env is unreadable.
  }
}
const customerPolicyVersionRecorded = /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(customerPolicyVersion);
const handoffResult = JSON.parse(execFileSync('node', ['scripts/write-post-call-fix-handoff.mjs'], {
  encoding: 'utf8',
  maxBuffer: EXEC_MAX_BUFFER,
  env: { ...approvalEnv, SMIRK_SKIP_APPROVAL_NOTE: '1' },
}).trim());
const handoffData = handoffResult?.path ? JSON.parse(fs.readFileSync(handoffResult.path, 'utf8')) : {};
const review = JSON.parse(run('npm', ['run', '-s', 'print:high-risk-deploy-review'], { env: approvalEnv }));
const changeSet = collectDeployChangeSet({ baseRef: liveReviewBaseRef || undefined });
const deployReviewBaseVerified = Boolean(
  liveReviewBaseRef
  && changeSet.baseRef === liveReviewBaseRef
  && changeSet.baseCommit === liveReviewBaseRef,
);
const deployRelevantFiles = changeSet.files;
const deployRelevantDirtyFiles = changeSet.dirtyFiles;
const hasDeployRelevantDirtyFiles = deployRelevantDirtyFiles.length > 0;

const reviewPath = path.resolve(process.cwd(), 'output', 'high-risk-deploy-review.json');
const approvalRequestPath = path.resolve(process.cwd(), 'output', 'deploy-approval-request.json');
fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2) + '\n');

const approvalRequest = JSON.parse(run('npm', ['run', '-s', 'print:deploy-approval-request'], { env: approvalEnv }));
fs.writeFileSync(approvalRequestPath, JSON.stringify(approvalRequest, null, 2) + '\n');

const stat = (p) => {
  try {
    const s = fs.statSync(p);
    return { exists: true, mtime: s.mtime.toISOString(), bytes: s.size };
  } catch {
    return { exists: false, mtime: null, bytes: null };
  }
};

const artifacts = {
  handoff: stat(handoffResult.path),
  approvalRequest: stat(approvalRequestPath),
  approvalNote: stat(handoffResult.approvalNotePath),
  highRiskReview: stat(reviewPath),
};

const allArtifactsReady = Object.values(artifacts).every((item) => item.exists && Number(item.bytes || 0) > 0);
const reviewFilesCount = Array.isArray(review?.files) ? review.files.length : 0;
const sourceCommit = run('git', ['rev-parse', 'HEAD']);
const localBranch = run('git', ['branch', '--show-current']) || 'main';
let remoteMainCommit = null;
let mergeBaseMain = null;
try {
  remoteMainCommit = run('git', ['rev-parse', 'origin/main']);
  mergeBaseMain = run('git', ['merge-base', 'HEAD', 'origin/main']);
} catch {
  remoteMainCommit = null;
  mergeBaseMain = null;
}
const gitRemoteSync = sourceCommit && remoteMainCommit && mergeBaseMain
  ? (sourceCommit === remoteMainCommit
    ? 'current'
    : (mergeBaseMain === remoteMainCommit ? 'ahead' : (mergeBaseMain === sourceCommit ? 'behind' : 'diverged')))
  : 'unknown';
const branchReconcileRequired = gitRemoteSync === 'behind' || gitRemoteSync === 'diverged';
const reviewReady = deployReviewBaseVerified
  && !hasDeployRelevantDirtyFiles
  && (reviewFilesCount > 0 || !branchReconcileRequired);
const branchReconcileCommand = 'git stash push -u -m "smirk-deploy-divergence" && git pull --rebase origin main && git stash pop';
const nextSafeAction = branchReconcileRequired
  ? 'Synchronize local branch with origin/main, regenerate the approval bundle, and rerun deploy readiness before production deploy approval.'
  : null;
const branchReconcileApprovalPath = path.resolve(process.cwd(), 'output', 'branch-reconcile-approval.md');
const branchReconcileApprovalJsonPath = path.resolve(process.cwd(), 'output', 'branch-reconcile-approval.json');
if (branchReconcileRequired) {
  execFileSync('node', ['scripts/write-branch-reconcile-approval.mjs'], {
    encoding: 'utf8',
    maxBuffer: EXEC_MAX_BUFFER,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}
const generatedAt = new Date().toISOString();
const liveFingerprint = liveCheck?.detail || liveCheck || null;
const blockerFingerprint = handoffData?.blockerStatus?.detail?.detail || handoffData?.blockerStatus?.detail || handoffData?.blockerStatus || null;
const liveHealth = {
  url: liveCheck?.appUrl || liveFingerprint?.url || blockerFingerprint?.appUrl || blockerFingerprint?.url || null,
  status: liveFingerprint?.status ?? blockerFingerprint?.status ?? null,
  readinessHeader: liveFingerprint?.readinessHeader || blockerFingerprint?.readinessHeader || handoffData?.blockerStatus?.liveReadinessHeader || null,
  branchHeader: liveCheck?.actualBranch || liveFingerprint?.actualBranch || liveFingerprint?.branchHeader || handoffData?.blockerStatus?.liveBranch || handoffData?.approvalRequest?.liveBranch || null,
  versionHeader: liveCheck?.actualVersion || liveFingerprint?.actualVersion || liveFingerprint?.versionHeader || handoffData?.blockerStatus?.actualVersion || handoffData?.actualVersion || null,
  checkedAt: generatedAt,
  failure: liveFingerprint?.failure || blockerFingerprint?.failure || null,
};
const postDeployProofSteps = Array.isArray(handoffData?.postDeployProofSteps)
  ? handoffData.postDeployProofSteps
  : [];
const postDeployProofExpectedArtifacts = Array.isArray(handoffData?.postDeployProofExpectedArtifacts)
  ? handoffData.postDeployProofExpectedArtifacts
  : [];
const deployPreflightRequiredPasses = Array.isArray(handoffData?.deployPreflightRequiredPasses)
  ? handoffData.deployPreflightRequiredPasses
  : [];
const postDeployProofReadinessGuards = Array.isArray(handoffData?.postDeployProofReadinessGuards)
  ? handoffData.postDeployProofReadinessGuards
  : [];
const postDeployStripeWebhookSmokeApprovalPhrase = handoffData?.postDeployStripeWebhookSmokeApprovalPhrase
  || 'APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live';
const postDeploySmokeCleanupApplyApprovalPhrase = handoffData?.postDeploySmokeCleanupApplyApprovalPhrase
  || 'APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply';

const bundle = {
  ok: allArtifactsReady && reviewReady,
  generatedAt,
  sourceCommit,
  customerPolicyVersion: customerPolicyVersionRecorded ? customerPolicyVersion : null,
  customerPolicyVersionRecorded,
  appUrl: liveHealth.url || null,
  liveStatus: liveHealth.status ?? null,
  liveReadinessHeader: liveHealth.readinessHeader || null,
  gitRemoteSync,
  branchReconcileRequired,
  branchReconcileCommand: branchReconcileRequired ? branchReconcileCommand : null,
  nextSafeAction,
  localBranch,
  localCommit: sourceCommit,
  remoteBranch: 'origin/main',
  remoteCommit: remoteMainCommit,
  mergeBaseWithOriginMain: mergeBaseMain,
  artifactPaths: {
    handoffPath: handoffResult.path || null,
    approvalRequestPath,
    approvalNotePath: handoffResult.approvalNotePath || null,
    highRiskReviewPath: reviewPath,
    branchReconcileApprovalPath: branchReconcileRequired ? branchReconcileApprovalPath : null,
    branchReconcileApprovalJsonPath: branchReconcileRequired ? branchReconcileApprovalJsonPath : null,
  },
  handoffPath: handoffResult.path || null,
  approvalRequestPath,
  approvalNotePath: handoffResult.approvalNotePath || null,
  highRiskReviewPath: reviewPath,
  liveVersionCurrent: hasDeployRelevantDirtyFiles ? false : (liveCheck?.ok === true ? true : (liveCheck?.failure === 'version-mismatch' ? false : (handoffData?.liveVersionCurrent ?? null))),
  deployState: handoffData?.deployState || null,
  blockerDetail: handoffData?.blockerDetail || null,
  liveFingerprintCurrent: handoffData?.liveFingerprintCurrent === true,
  localDeployClean: handoffData?.localDeployClean === true,
  expectedVersion: hasDeployRelevantDirtyFiles ? 'pending-local-commit' : (liveCheck?.expectedVersion || liveFingerprint?.expectedVersion || handoffData?.expectedVersion || null),
  actualVersion: liveCheck?.actualVersion || liveFingerprint?.actualVersion || liveFingerprint?.versionHeader || handoffData?.actualVersion || null,
  deployReviewBaseRef: changeSet.baseRef,
  deployReviewBaseCommit: changeSet.baseCommit,
  deployReviewBaseSource: changeSet.baseSource,
  deployReviewBaseVerified,
  deployRelevantFiles,
  committedDeployRelevantFiles: changeSet.committedFiles,
  deployRelevantDirtyFiles,
  liveHealth,
  changedFileCount: handoffData?.changedFileCount ?? null,
  highRiskFileCount: handoffData?.highRiskFileCount ?? null,
  nextAction: branchReconcileRequired ? nextSafeAction : (handoffData?.nextAction || null),
  deployApprovalToken: handoffData?.deployApprovalToken || null,
  deployApprovalMeaning: handoffData?.deployApprovalMeaning || null,
  approvalSteps: branchReconcileRequired
    ? [
      'Get explicit APPROVE_SMIRK_BRANCH_RECONCILE approval from Cameron.',
      branchReconcileCommand,
      'npm run -s check:deploy-post-call-fix-ready',
      'npm run write:deploy-approval-bundle',
      'npm run -s check:deploy-approval-handoff',
    ]
    : (Array.isArray(handoffData?.approvalSteps) ? handoffData.approvalSteps : []),
  postDeployProofRequired: handoffData?.postDeployProofRequired === true,
  proofRunnerRequiresPostDeployLive: handoffData?.proofRunnerRequiresPostDeployLive === true,
  deployPreflightRequiredPasses,
  expectedDeployBlockerAfterRequiredPasses: handoffData?.expectedDeployBlockerAfterRequiredPasses || null,
  postDeployProofReadinessGuards,
  postDeployStripeWebhookSmokeApprovalPhrase,
  postDeploySmokeCleanupApplyApprovalPhrase,
  postDeployProofSteps,
  postDeployProofExpectedArtifacts,
  reviewFilesCount,
  reviewReady,
  artifacts,
};

const bundlePath = path.resolve(process.cwd(), 'output', 'deploy-approval-bundle.json');
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n');

let approvalNotePath = handoffResult.approvalNotePath || null;
if (!approvalNotePath) {
  try {
    const noteOut = execFileSync('node', ['scripts/write-deploy-approval-note.mjs'], {
      encoding: 'utf8',
      maxBuffer: EXEC_MAX_BUFFER,
      env: { ...approvalEnv, SMIRK_SKIP_BUNDLE_REFRESH: '1' },
    }).trim();
    approvalNotePath = JSON.parse(noteOut)?.path || approvalNotePath;
  } catch (error) {
    try {
      approvalNotePath = JSON.parse(String(error?.stdout || '').trim())?.path || approvalNotePath;
    } catch {
      // keep null
    }
  }
}

const finalArtifacts = {
  ...artifacts,
  approvalNote: stat(approvalNotePath),
  branchReconcileApproval: branchReconcileRequired ? stat(branchReconcileApprovalPath) : { exists: true, mtime: null, bytes: 0 },
  branchReconcileApprovalJson: branchReconcileRequired ? stat(branchReconcileApprovalJsonPath) : { exists: true, mtime: null, bytes: 0 },
};
const finalOk = finalArtifacts.handoff.exists && finalArtifacts.approvalRequest.exists && finalArtifacts.highRiskReview.exists && finalArtifacts.approvalNote.exists && finalArtifacts.branchReconcileApproval.exists && finalArtifacts.branchReconcileApprovalJson.exists && reviewReady;
const finalBundle = {
  ...bundle,
  ok: finalOk,
  approvalNotePath,
  artifactPaths: {
    ...bundle.artifactPaths,
    approvalNotePath,
  },
  artifacts: finalArtifacts,
};
fs.writeFileSync(bundlePath, JSON.stringify(finalBundle, null, 2) + '\n');

if (finalBundle.deployState === 'live-already-current' && finalBundle.liveFingerprintCurrent === true && finalBundle.localDeployClean === true) {
  execFileSync('npm', ['run', '-s', 'write:stripe-webhook-smoke-approval'], {
    encoding: 'utf8',
    maxBuffer: EXEC_MAX_BUFFER,
  });
}

let firstDollarApprovalPacket = null;
try {
  const packetOut = execFileSync('npm', ['run', '-s', 'write:first-dollar-approval-packet'], { encoding: 'utf8', maxBuffer: EXEC_MAX_BUFFER }).trim();
  firstDollarApprovalPacket = packetOut ? JSON.parse(packetOut) : null;
} catch (error) {
  try {
    firstDollarApprovalPacket = JSON.parse(String(error?.stdout || '').trim());
  } catch {
    firstDollarApprovalPacket = {
      ok: false,
      error: String(error?.message || error),
    };
  }
}

const finalBundleWithPacket = {
  ...finalBundle,
  ok: finalBundle.ok && firstDollarApprovalPacket?.ok === true,
  firstDollarApprovalPacketPath: firstDollarApprovalPacket?.path || null,
  artifactPaths: {
    ...finalBundle.artifactPaths,
    firstDollarApprovalPacketPath: firstDollarApprovalPacket?.path || null,
  },
  artifacts: {
    ...finalBundle.artifacts,
    firstDollarApprovalPacket: stat(firstDollarApprovalPacket?.path),
  },
};
fs.writeFileSync(bundlePath, JSON.stringify(finalBundleWithPacket, null, 2) + '\n');

console.log(JSON.stringify({ ...finalBundleWithPacket, bundlePath }, null, 2));

if (!finalBundleWithPacket.ok) process.exit(1);
