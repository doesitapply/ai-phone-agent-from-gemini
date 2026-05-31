#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const runJsonAllowFailure = (cmd, args) => {
  try {
    return JSON.parse(run(cmd, args));
  } catch (error) {
    const out = String(error?.stdout || error?.stderr || '').trim();
    if (!out) throw error;
    return JSON.parse(out);
  }
};

const handoffResult = JSON.parse(execFileSync('node', ['scripts/write-post-call-fix-handoff.mjs'], {
  encoding: 'utf8',
  env: { ...process.env, SMIRK_SKIP_APPROVAL_NOTE: '1' },
}).trim());
const handoffData = handoffResult?.path ? JSON.parse(fs.readFileSync(handoffResult.path, 'utf8')) : {};
const review = JSON.parse(run('npm', ['run', '-s', 'print:high-risk-deploy-review']));
const liveCheck = runJsonAllowFailure('npm', ['run', '-s', 'check:live-is-current']);
const dirtyFiles = execFileSync('git', ['status', '--short'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => line.replace(/^.{1,2}\s+/, '').replace(/^.* -> /, '').trim());
const deployRelevantDirtyFiles = dirtyFiles.filter((file) => !file.startsWith('output/') && !file.startsWith('tmp/'));
const hasDeployRelevantDirtyFiles = deployRelevantDirtyFiles.length > 0;

const reviewPath = path.resolve(process.cwd(), 'output', 'high-risk-deploy-review.json');
const approvalRequestPath = path.resolve(process.cwd(), 'output', 'deploy-approval-request.json');
fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2) + '\n');

const approvalRequest = JSON.parse(run('npm', ['run', '-s', 'print:deploy-approval-request']));
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
const reviewReady = reviewFilesCount > 0;
const sourceCommit = run('git', ['rev-parse', 'HEAD']);
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

const bundle = {
  ok: allArtifactsReady && reviewReady,
  generatedAt,
  sourceCommit,
  appUrl: liveHealth.url || null,
  liveStatus: liveHealth.status ?? null,
  liveReadinessHeader: liveHealth.readinessHeader || null,
  artifactPaths: {
    handoffPath: handoffResult.path || null,
    approvalRequestPath,
    approvalNotePath: handoffResult.approvalNotePath || null,
    highRiskReviewPath: reviewPath,
  },
  handoffPath: handoffResult.path || null,
  approvalRequestPath,
  approvalNotePath: handoffResult.approvalNotePath || null,
  highRiskReviewPath: reviewPath,
  liveVersionCurrent: hasDeployRelevantDirtyFiles ? false : (liveCheck?.ok === true ? true : (liveCheck?.failure === 'version-mismatch' ? false : (handoffData?.liveVersionCurrent ?? null))),
  expectedVersion: hasDeployRelevantDirtyFiles ? 'pending-local-commit' : (liveCheck?.expectedVersion || liveFingerprint?.expectedVersion || handoffData?.expectedVersion || null),
  actualVersion: liveCheck?.actualVersion || liveFingerprint?.actualVersion || liveFingerprint?.versionHeader || handoffData?.actualVersion || null,
  deployRelevantDirtyFiles,
  liveHealth,
  changedFileCount: handoffData?.changedFileCount ?? null,
  highRiskFileCount: handoffData?.highRiskFileCount ?? null,
  nextAction: handoffData?.nextAction || null,
  approvalSteps: Array.isArray(handoffData?.approvalSteps) ? handoffData.approvalSteps : [],
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
      env: { ...process.env, SMIRK_SKIP_BUNDLE_REFRESH: '1' },
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
};
const finalOk = finalArtifacts.handoff.exists && finalArtifacts.approvalRequest.exists && finalArtifacts.highRiskReview.exists && finalArtifacts.approvalNote.exists && reviewReady;
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

console.log(JSON.stringify({ ...finalBundle, bundlePath }, null, 2));

if (!finalBundle.ok) process.exit(1);
