#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has('--write');
const remoteRef = process.env.SMIRK_BRANCH_SYNC_REMOTE || 'origin/main';
const now = new Date().toISOString();

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function requireOk(label, result) {
  if (result.status !== 0) {
    const message = `${label} failed: ${result.stderr || result.stdout || result.error || 'unknown error'}`;
    throw new Error(message.trim());
  }
  return result.stdout.trim();
}

function git(args, options = {}) {
  return run('git', args, options);
}

function listLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parsePatchFailures(output) {
  const failures = [];
  for (const line of listLines(output)) {
    const patchFailed = line.match(/^error: patch failed: (.+?):/);
    const doesNotApply = line.match(/^error: (.+?): patch does not apply$/);
    const missing = line.match(/^error: (.+?): No such file or directory$/);
    if (patchFailed?.[1]) failures.push(patchFailed[1]);
    if (doesNotApply?.[1]) failures.push(doesNotApply[1]);
    if (missing?.[1]) failures.push(missing[1]);
  }
  return [...new Set(failures)].sort();
}

function fileExistsAtRef(ref, path) {
  return git(['cat-file', '-e', `${ref}:${path}`]).status === 0;
}

let tmpRoot = null;
let cleanupOk = false;

try {
  const localBranch = requireOk('git branch', git(['branch', '--show-current']));
  const localCommit = requireOk('git rev-parse HEAD', git(['rev-parse', 'HEAD']));
  const remoteCommit = requireOk(`git rev-parse ${remoteRef}`, git(['rev-parse', remoteRef]));
  const aheadBehindRaw = requireOk(`git rev-list ${remoteRef}`, git(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]));
  const [ahead = 'unknown', behind = 'unknown'] = aheadBehindRaw.split(/\s+/);
  const remoteChangedRaw = requireOk(`git diff HEAD..${remoteRef}`, git(['diff', '--name-status', `HEAD..${remoteRef}`]));
  const remoteChangedFiles = listLines(remoteChangedRaw).map((line) => {
    const [status, ...rest] = line.split(/\s+/);
    return { status, path: rest.join(' ') };
  });
  const trackedDirtyFiles = listLines(requireOk('git diff --name-only', git(['diff', '--name-only'])));
  const untrackedFiles = listLines(requireOk('git ls-files --others', git(['ls-files', '--others', '--exclude-standard'])));
  const remoteChangedPaths = new Set(remoteChangedFiles.map((entry) => entry.path));
  const trackedDirtyRemoteOverlap = trackedDirtyFiles.filter((path) => remoteChangedPaths.has(path)).sort();
  const untrackedRemoteCollisions = untrackedFiles.filter((path) => fileExistsAtRef(remoteRef, path)).sort();

  tmpRoot = mkdtempSync(join(tmpdir(), 'smirk-branch-sync-forecast.'));
  const patchPath = join(tmpRoot, 'local-tracked.patch');
  const clonePath = join(tmpRoot, 'repo');

  const patch = git(['diff', '--binary']);
  if (patch.status !== 0) {
    throw new Error(`git diff --binary failed: ${patch.stderr || patch.error || patch.stdout}`);
  }
  writeFileSync(patchPath, patch.stdout, 'utf8');

  const clone = git(['clone', '-q', '.', clonePath]);
  if (clone.status !== 0) {
    throw new Error(`git clone failed: ${clone.stderr || clone.error || clone.stdout}`);
  }
  const checkout = git(['checkout', '-q', remoteRef], { cwd: clonePath });
  if (checkout.status !== 0) {
    throw new Error(`git checkout ${remoteRef} failed: ${checkout.stderr || checkout.error || checkout.stdout}`);
  }
  const applyCheck = git(['apply', '--check', patchPath], { cwd: clonePath });
  const applyOutput = `${applyCheck.stdout}\n${applyCheck.stderr}`.trim();
  const patchFailureFiles = parsePatchFailures(applyOutput);

  rmSync(tmpRoot, { recursive: true, force: true });
  cleanupOk = true;

  const ok = applyCheck.status === 0 && untrackedRemoteCollisions.length === 0;
  const result = {
    ok,
    checkedAt: now,
    remoteRef,
    localBranch,
    localCommit,
    remoteCommit,
    ahead: Number(ahead),
    behind: Number(behind),
    remoteChangedFiles,
    trackedDirtyRemoteOverlap,
    untrackedRemoteCollisions,
    patchApplyStatus: applyCheck.status,
    patchFailureFiles,
    dryRunResult: ok ? 'PATCH_APPLIES_CLEANLY_ON_REMOTE' : 'PATCH_CONFLICT_OR_APPLY_FAILURE_ON_REMOTE',
    tempCloneDeleted: cleanupOk,
    approvalMeaning: 'APPROVE_SMIRK_BRANCH_RECONCILE authorizes only a guarded branch synchronization attempt with conflict inspection.',
    stopRule: 'If rebase or git stash pop produces conflicts, stop and preserve the conflicted state for inspection. Do not deploy, run Stripe smoke, or run proof calls.',
  };

  if (shouldWrite) {
    mkdirSync('output', { recursive: true });
    writeFileSync('output/branch-sync-conflict-forecast.json', `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    writeFileSync(
      'output/branch-sync-conflict-forecast.md',
      [
        '# Branch Sync Conflict Forecast',
        '',
        `Generated: ${now}`,
        '',
        `Result: \`${result.dryRunResult}\``,
        '',
        `Local: \`${localBranch}\` at \`${localCommit}\``,
        `Remote: \`${remoteRef}\` at \`${remoteCommit}\``,
        `Ahead/behind: \`${ahead} ahead / ${behind} behind\``,
        '',
        '## Remote Changed Files',
        ...remoteChangedFiles.map((entry) => `- ${entry.status} ${entry.path}`),
        '',
        '## Dirty Files Also Changed Remotely',
        ...(trackedDirtyRemoteOverlap.length
          ? trackedDirtyRemoteOverlap.map((path) => `- ${path}`)
          : ['- none']),
        '',
        '## Untracked Files That Exist On Remote',
        ...(untrackedRemoteCollisions.length
          ? untrackedRemoteCollisions.map((path) => `- ${path}`)
          : ['- none']),
        '',
        '## Patch Apply Failures',
        ...(patchFailureFiles.length
          ? patchFailureFiles.map((path) => `- ${path}`)
          : ['- none']),
        '',
        '## Approval Meaning',
        result.approvalMeaning,
        '',
        '## Stop Rule',
        result.stopRule,
        '',
      ].join('\n'),
      'utf8',
    );
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(ok ? 0 : 1);
} catch (error) {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    cleanupOk = true;
  }
  console.error(JSON.stringify({
    ok: false,
    checkedAt: now,
    remoteRef,
    error: String(error?.message || error),
    tempCloneDeleted: cleanupOk,
  }, null, 2));
  process.exit(1);
}
