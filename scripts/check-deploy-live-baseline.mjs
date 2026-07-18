#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  assertAuthoritativeProductionLiveOrigin,
  resolveAuthoritativeLiveDeployReviewBase,
} from './lib/deploy-change-set.mjs';

const bundlePath = 'output/deploy-approval-bundle.json';
const failures = [];

if (!existsSync(bundlePath)) {
  failures.push(`${bundlePath} is required for the final live-baseline check`);
}

let bundle = null;
if (failures.length === 0) {
  try {
    bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  } catch (error) {
    failures.push(`${bundlePath} is not valid JSON: ${String(error?.message || error)}`);
  }
}

let currentHead = null;
try {
  currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch (error) {
  failures.push(`Could not resolve current HEAD: ${String(error?.message || error)}`);
}

let authoritativeBase = null;
try {
  authoritativeBase = resolveAuthoritativeLiveDeployReviewBase();
} catch (error) {
  failures.push(String(error?.message || error));
}

if (bundle) {
  if (bundle.ok !== true || bundle.reviewReady !== true) {
    failures.push('bundle must remain approval-ready');
  }
  if (bundle.localDeployClean !== true || (bundle.deployRelevantDirtyFiles || []).length !== 0) {
    failures.push('bundle must describe a clean exact deploy commit');
  }
  if (bundle.deployReviewBaseVerified !== true) {
    failures.push('bundle.deployReviewBaseVerified must be true');
  }
  if (!/^[0-9a-f]{40}$/.test(String(bundle.deployReviewBaseRef || ''))) {
    failures.push('bundle.deployReviewBaseRef must be an exact 40-character commit fingerprint');
  }
  if (bundle.deployReviewBaseCommit !== bundle.deployReviewBaseRef) {
    failures.push('bundle deploy review ref and commit must be identical');
  }
  if (bundle.sourceCommit !== currentHead || bundle.localCommit !== currentHead) {
    failures.push(`bundle source/local commit must both match current HEAD ${currentHead || 'unavailable'}`);
  }
  try {
    assertAuthoritativeProductionLiveOrigin({
      url: bundle.liveHealth?.url || bundle.appUrl || null,
    });
  } catch (error) {
    failures.push(`Saved bundle production origin is invalid: ${String(error?.message || error)}`);
  }
}

if (
  bundle
  && authoritativeBase
  && (
    bundle.deployReviewBaseRef !== authoritativeBase.ref
    || bundle.deployReviewBaseCommit !== authoritativeBase.commit
  )
) {
  failures.push(
    `Live deployment baseline moved after approval: saved=${bundle.deployReviewBaseCommit || bundle.deployReviewBaseRef || 'missing'} current=${authoritativeBase.commit}. Regenerate the approval bundle before deploy.`,
  );
}

const out = {
  ok: failures.length === 0,
  bundlePath,
  sourceCommit: currentHead,
  approvedLiveBaseline: bundle?.deployReviewBaseCommit || null,
  currentLiveBaseline: authoritativeBase?.commit || null,
  productionOrigin: authoritativeBase
    ? assertAuthoritativeProductionLiveOrigin(authoritativeBase.liveCheck)
    : null,
  failures,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
