#!/usr/bin/env node
import {
  collectDeployChangeSet,
  diffExcerptFromBase,
  diffNumstatFromBase,
  resolveApprovalDeployReviewBase,
} from './lib/deploy-change-set.mjs';

const staticReasons = {
  'deploy.sh': 'Wait for live commit parity after Railway upload, then run the full ship check automatically.',
  'package.json': 'Adds the live verification, deploy handoff, and real proof-call scripts used to prove the shipped path.',
  'server.ts': 'Always trigger post-call intelligence after call end so summaries are attempted on production calls.',
  'src/App.tsx': 'Tightens buyer activation/login flow so paid checkout precedes manual fallback work and invite-based access is clearer.',
};

function reasonFor(file) {
  if (staticReasons[file]) return staticReasons[file];
  if (file.startsWith('scripts/')) return 'Changes deploy, proof-call, auth, or launch verification helpers that gate first-dollar readiness.';
  if (file.endsWith('.md')) return 'Changes operator or buyer-facing readiness documentation used before production proof.';
  if (file.startsWith('src/')) return 'Changes frontend behavior or copy visible to buyer/operator workflows.';
  return 'Deploy-relevant local change included in the production approval surface.';
}

const authoritativeBase = resolveApprovalDeployReviewBase();
const changeSet = collectDeployChangeSet({ baseRef: authoritativeBase.ref });
const review = changeSet.entries.map(({ status, file, committed, dirty }) => ({
  file,
  status,
  committed,
  dirty,
  ...diffNumstatFromBase(file, changeSet.baseRef),
  reason: reasonFor(file),
  excerpt: diffExcerptFromBase(file, changeSet.baseRef),
}));

console.log(JSON.stringify({
  ok: true,
  deployReviewBaseRef: changeSet.baseRef,
  deployReviewBaseCommit: changeSet.baseCommit,
  deployReviewBaseSource: changeSet.baseSource,
  deployRelevantFileCount: review.length,
  committedDeployRelevantFiles: changeSet.committedFiles,
  dirtyDeployRelevantFiles: changeSet.dirtyFiles,
  files: review,
}, null, 2));
