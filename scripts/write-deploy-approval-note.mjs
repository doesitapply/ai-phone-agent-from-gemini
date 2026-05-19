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

const note = [
  '# SMIRK deploy approval request',
  '',
  `- Branch: ${approval.branch || 'unknown'}`,
  `- Commit: ${approval.commit || 'unknown'}`,
  `- Live version current: ${approval.liveVersionCurrent === true ? 'yes' : 'no'}`,
  `- Expected version: ${approval.expectedVersion || approval.commit || 'unknown'}`,
  `- Actual live version: ${approval.actualVersion || 'unknown'}`,
  `- Live branch: ${approval.liveBranch || 'unknown'}`,
  `- Changed file count: ${approval.changedFileCount ?? 'unknown'}`,
  `- High-risk file count: ${approval.highRiskFileCount ?? 'unknown'}`,
  `- Approval bundle generated at: ${bundleMeta.generatedAt || 'unknown'}`,
  `- Approval bundle source commit: ${bundleMeta.sourceCommit || approval.commit || 'unknown'}`,
  `- Approval artifact freshness: handoff ${bundleMeta.artifacts?.handoff?.mtime || 'unknown'}; approval note ${bundleMeta.artifacts?.approvalNote?.mtime || 'unknown'}; high-risk review ${bundleMeta.artifacts?.highRiskReview?.mtime || 'unknown'}`,
  `- Live health check: ${bundleMeta.liveHealth?.status ?? 'unknown'} @ ${bundleMeta.liveHealth?.url || 'unknown'} (readiness ${bundleMeta.liveHealth?.readinessHeader || 'unknown'}, branch ${bundleMeta.liveHealth?.branchHeader || 'unknown'}, version ${bundleMeta.liveHealth?.versionHeader || 'unknown'}, failure ${bundleMeta.liveHealth?.failure || 'none'})`,
  `- Approval bundle command: npm run write:deploy-approval-bundle`,
  `- High-risk review command: npm run print:high-risk-deploy-review`,
  `- Deploy command: ${approval.command || 'unknown'}`,
  `- Reason: ${approval.reason || 'unknown'}`,
  '',
  '## Approval artifacts',
  '- output/deploy-approval-bundle.json',
  '- output/post-call-fix-handoff.json',
  '- output/post-call-fix-approval-note.md',
  '- output/high-risk-deploy-review.json',
  '',
  '## Approval steps',
  '- 1. npm run write:deploy-approval-bundle',
  '- 2. npm run print:high-risk-deploy-review',
  `- 3. ${approval.command || 'unknown'}`,
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
  `- ${blocker.blocker || 'unknown'}`,
  `- Next action: ${blocker.nextAction || 'unknown'}`,
].join('\n');

const target = path.resolve(process.cwd(), 'output', 'post-call-fix-approval-note.md');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, note + '\n');
console.log(JSON.stringify({ ok: true, path: target }, null, 2));
