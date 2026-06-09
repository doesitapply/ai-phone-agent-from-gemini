#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const deployCommand = 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix';

function deployRelevantFiles() {
  return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      const file = line.replace(/^.{1,2}\s+/, '').replace(/^.* -> /, '').trim();
      const status = line.slice(0, 2).trim();
      if (status === '??' && existsSync(file) && statSync(file).isDirectory()) {
        return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', file], { encoding: 'utf8' })
          .split(/\r?\n/)
          .filter(Boolean);
      }
      return [file];
    })
    .filter((file) => file && !file.startsWith('output/') && !file.startsWith('tmp/'));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sameSet(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((item) => !actualSet.has(item)),
    extra: actual.filter((item) => !expectedSet.has(item)),
  };
}

const expectedFiles = deployRelevantFiles();
const bundle = readJson('output/deploy-approval-bundle.json');
const request = readJson('output/deploy-approval-request.json');
const review = readJson('output/high-risk-deploy-review.json');
const handoff = readJson('output/post-call-fix-handoff.json');

const reviewFiles = Array.isArray(review.files) ? review.files.map((item) => item.file) : [];
const requestFiles = Array.isArray(request.highRiskFiles) ? request.highRiskFiles : [];
const requestDirtyFiles = Array.isArray(request.deployRelevantDirtyFiles) ? request.deployRelevantDirtyFiles : [];
const bundleDirtyFiles = Array.isArray(bundle.deployRelevantDirtyFiles) ? bundle.deployRelevantDirtyFiles : [];
const handoffFiles = Array.isArray(handoff.highRiskFiles) ? handoff.highRiskFiles : [];

const failures = [];
const countChecks = [
  ['bundle.highRiskFileCount', bundle.highRiskFileCount],
  ['bundle.reviewFilesCount', bundle.reviewFilesCount],
  ['request.highRiskFileCount', request.highRiskFileCount],
  ['review.files.length', reviewFiles.length],
  ['review.deployRelevantFileCount', review.deployRelevantFileCount],
  ['handoff.highRiskFileCount', handoff.highRiskFileCount],
];

for (const [label, count] of countChecks) {
  if (count !== expectedFiles.length) {
    failures.push(`${label}=${count} does not match deploy-relevant file count ${expectedFiles.length}`);
  }
}

const setChecks = [
  ['bundle.deployRelevantDirtyFiles', bundleDirtyFiles],
  ['request.deployRelevantDirtyFiles', requestDirtyFiles],
  ['request.highRiskFiles', requestFiles],
  ['review.files', reviewFiles],
  ['handoff.highRiskFiles', handoffFiles],
];

for (const [label, files] of setChecks) {
  const { missing, extra } = sameSet(files, expectedFiles);
  if (missing.length || extra.length) {
    failures.push(`${label} does not match deploy-relevant files: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
  }
}

const deployCommands = [
  ['request.command', request.command],
  ['handoff.deployCommand', handoff.deployCommand],
  ['bundle.nextAction', bundle.nextAction],
];
for (const [label, value] of deployCommands) {
  if (typeof value !== 'string' || !value.includes(deployCommand)) {
    failures.push(`${label} must include the confirmed deploy command`);
  }
}

const out = {
  ok: failures.length === 0,
  deployRelevantFileCount: expectedFiles.length,
  checkedArtifacts: [
    'output/deploy-approval-bundle.json',
    'output/deploy-approval-request.json',
    'output/high-risk-deploy-review.json',
    'output/post-call-fix-handoff.json',
  ],
  failures,
};

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
