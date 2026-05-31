#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || 'main';
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const changedFiles = execFileSync('git', ['status', '--short'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((line) => line.trim());

const changedFilePaths = changedFiles.map((line) => {
  return line.replace(/^.{1,2}\s+/, '').replace(/^.* -> /, '').trim();
});
const deployRelevantDirtyFiles = changedFilePaths.filter((file) => !file.startsWith('output/') && !file.startsWith('tmp/'));
const hasDeployRelevantDirtyFiles = deployRelevantDirtyFiles.length > 0;

const changedFileGroups = changedFilePaths.reduce((acc, file) => {
  if (file.startsWith('scripts/')) acc.scripts += 1;
  else if (file.startsWith('src/') || file === 'server.ts' || file === 'package.json' || file === 'deploy.sh') acc.app += 1;
  else if (file.startsWith('output/')) acc.output += 1;
  else if (file.endsWith('.md') || file === '.env.example') acc.docs += 1;
  else acc.other += 1;
  return acc;
}, { docs: 0, scripts: 0, app: 0, output: 0, other: 0 });

const highRiskFiles = changedFilePaths.filter((file) =>
  file === 'server.ts' ||
  file === 'src/App.tsx' ||
  file === 'package.json' ||
  file === 'deploy.sh'
);

const highRiskDiffStats = highRiskFiles.map((file) => {
  try {
    const raw = execFileSync('git', ['diff', '--numstat', '--', file], { encoding: 'utf8' }).trim();
    const [added, removed] = raw.split(/\s+/);
    return {
      file,
      added: Number(added || 0),
      removed: Number(removed || 0),
    };
  } catch {
    return { file, added: null, removed: null };
  }
});

const highRiskFileReasons = {
  'deploy.sh': 'Wait for live commit parity after Railway upload, then run the full ship check automatically.',
  'package.json': 'Adds the live verification, deploy handoff, and real proof-call scripts used to prove the shipped path.',
  'server.ts': 'Always trigger post-call intelligence after call end so summaries are attempted on production calls.',
  'src/App.tsx': 'Hides Mission Control and advanced operational screens from customer workspace sessions.',
};

let liveCheck = null;
try {
  const raw = execFileSync('npm', ['run', '-s', 'check:live-is-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  liveCheck = raw ? JSON.parse(raw) : null;
} catch (error) {
  const text = String(error?.stdout || error?.stderr || '').trim();
  try {
    liveCheck = text ? JSON.parse(text) : null;
  } catch {
    liveCheck = text ? { raw: text } : null;
  }
}

const liveFingerprint = liveCheck?.detail || liveCheck || null;

console.log(JSON.stringify({
  requiresApproval: true,
  branch,
  commit,
  liveVersionCurrent: hasDeployRelevantDirtyFiles ? false : liveCheck?.ok === true,
  expectedVersion: hasDeployRelevantDirtyFiles ? 'pending-local-commit' : (liveCheck?.expectedVersion || commit),
  actualVersion: liveCheck?.actualVersion || liveFingerprint?.actualVersion || liveFingerprint?.versionHeader || null,
  liveBranch: liveCheck?.actualBranch || liveFingerprint?.actualBranch || liveFingerprint?.branchHeader || null,
  liveReadinessHeader: liveCheck?.liveReadinessHeader || liveFingerprint?.readinessHeader || null,
  liveStatus: liveCheck?.liveStatus ?? liveFingerprint?.status ?? null,
  appUrl: liveCheck?.appUrl || liveFingerprint?.url || null,
  changedFileCount: changedFiles.length,
  deployRelevantDirtyFiles,
  changedFileGroups,
  highRiskFileCount: highRiskFiles.length,
  highRiskFiles,
  highRiskDiffStats,
  highRiskFileReasons,
  changedFiles: changedFiles.slice(0, 25),
  changedFilesTruncated: changedFiles.length > 25,
  command: 'npm run deploy:post-call-fix',
  reason: 'Deploy local HEAD to Railway so live matches the current code before the real proof-call verification run.'
}, null, 2));
