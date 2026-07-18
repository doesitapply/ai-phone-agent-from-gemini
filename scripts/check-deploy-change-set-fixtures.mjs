#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const helperUrl = pathToFileURL(path.join(scriptDir, 'lib/deploy-change-set.mjs'));
const {
  AUTHORITATIVE_PRODUCTION_APP_URL,
  collectDeployChangeSet,
  diffExcerptFromBase,
  extractAuthoritativeLiveFingerprint,
} = await import(helperUrl.href);
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'smirk-deploy-change-set-'));
const originalCwd = process.cwd();
const originalGitIndexFile = process.env.GIT_INDEX_FILE;
const originalGitWorkTree = process.env.GIT_WORK_TREE;
let alternateWorktreeRoot = null;

const git = (...args) => execFileSync('git', args, { cwd: fixtureRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (relativePath, content) => {
  const target = path.join(fixtureRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

try {
  const liveCommit = 'a'.repeat(40);
  const productionHealthUrl = `${AUTHORITATIVE_PRODUCTION_APP_URL}/health`;
  assert.equal(extractAuthoritativeLiveFingerprint({
    ok: true,
    url: productionHealthUrl,
    status: 200,
    readinessHeader: '1',
    versionHeader: liveCommit,
    version: liveCommit,
  }), liveCommit);
  assert.equal(extractAuthoritativeLiveFingerprint({
    ok: false,
    blocker: 'stale-production-deploy',
    actualVersion: liveCommit,
    detail: {
      ok: false,
      url: productionHealthUrl,
      failure: 'version-mismatch',
      status: 200,
      readinessHeader: '1',
      actualVersion: liveCommit,
    },
  }), liveCommit);
  assert.throws(() => extractAuthoritativeLiveFingerprint({
    ok: false,
    url: productionHealthUrl,
    failure: 'missing-readiness-header',
    versionHeader: liveCommit,
  }), /healthy, validated/);
  assert.throws(() => extractAuthoritativeLiveFingerprint({
    ok: true,
    url: productionHealthUrl,
    status: 503,
    readinessHeader: '1',
    version: liveCommit,
  }), /healthy, validated/);
  assert.throws(() => extractAuthoritativeLiveFingerprint({
    ok: false,
    blocker: 'stale-production-deploy',
    actualVersion: liveCommit,
    detail: {
      ok: false,
      url: productionHealthUrl,
      failure: 'branch-mismatch',
      status: 200,
      readinessHeader: '1',
      versionHeader: liveCommit,
    },
  }), /healthy, validated/);
  assert.throws(() => extractAuthoritativeLiveFingerprint({
    ok: true,
    url: 'http://localhost:8787/health',
    status: 200,
    readinessHeader: '1',
    version: liveCommit,
  }), /allowlisted production HTTPS/);
  assert.throws(() => extractAuthoritativeLiveFingerprint({
    ok: true,
    url: 'https://smirk-staging.example.com/health',
    status: 200,
    readinessHeader: '1',
    version: liveCommit,
  }), /allowlisted production HTTPS/);

  git('init', '-q');
  git('config', 'user.email', 'fixture@smirk.invalid');
  git('config', 'user.name', 'SMIRK Fixture');
  write('.gitignore', 'output/*.json\noutputs/\ntmp/\n.artifacts/\n');
  write('tracked.txt', 'base\n');
  write('deleted.txt', 'base\n');
  write('rename-source.txt', 'base\n');
  write('tracked-dir/base.txt', 'base\n');
  write('CasePath/ExactCase.js', 'case-sensitive path\n');
  write('unicode/café.txt', 'unicode path\n');
  write('critical-server.ts', 'security critical\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  alternateWorktreeRoot = mkdtempSync(path.join(tmpdir(), 'smirk-deploy-worktree-'));
  execFileSync('git', ['worktree', 'add', '--detach', alternateWorktreeRoot, base], {
    cwd: fixtureRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  process.chdir(alternateWorktreeRoot);
  assert.doesNotThrow(
    () => collectDeployChangeSet({ baseRef: base }),
    'a valid alternate worktree with an exact .git metadata file must pass repository-root validation',
  );
  process.chdir(fixtureRoot);
  execFileSync('git', ['worktree', 'remove', '--force', alternateWorktreeRoot], {
    cwd: fixtureRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  rmSync(alternateWorktreeRoot, { recursive: true, force: true });
  alternateWorktreeRoot = null;

  git('update-index', '--assume-unchanged', 'tracked.txt');
  write('tracked.txt', 'hidden assume-unchanged bytes\n');
  assert.equal(git('status', '--porcelain=v1', '--', 'tracked.txt'), '', 'assume-unchanged fixture must hide modified bytes from status');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /assume-unchanged index flag/,
    'assume-unchanged tracked bytes must not hide behind clean Git status',
  );
  git('update-index', '--no-assume-unchanged', 'tracked.txt');
  write('tracked.txt', 'base\n');

  git('update-index', '--skip-worktree', 'tracked.txt');
  write('tracked.txt', 'hidden skip-worktree bytes\n');
  assert.equal(git('status', '--porcelain=v1', '--', 'tracked.txt'), '', 'skip-worktree fixture must hide modified bytes from status');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /skip-worktree index flag/,
    'skip-worktree tracked bytes must not hide behind clean Git status',
  );
  git('update-index', '--no-skip-worktree', 'tracked.txt');
  write('tracked.txt', 'base\n');

  write('node_modules/tracked-uploader-gap.js', 'tracked but Railway hard-excludes me\n');
  git('add', '-f', 'node_modules/tracked-uploader-gap.js');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /Railway always excludes.*node_modules/,
    'tracked paths under Railway built-in exclusions must fail closed',
  );
  git('reset', '-q', '--', 'node_modules/tracked-uploader-gap.js');
  rmSync(path.join(fixtureRoot, 'node_modules'), { recursive: true, force: true });

  renameSync(path.join(fixtureRoot, 'CasePath'), path.join(fixtureRoot, 'case-stage'));
  renameSync(path.join(fixtureRoot, 'case-stage'), path.join(fixtureRoot, 'casepath'));
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /case or Unicode normalization mismatch/,
    'case-only filesystem path renames must not differ from the reviewed index spelling',
  );
  renameSync(path.join(fixtureRoot, 'casepath'), path.join(fixtureRoot, 'case-stage'));
  renameSync(path.join(fixtureRoot, 'case-stage'), path.join(fixtureRoot, 'CasePath'));

  const unicodeNfcPath = path.join(fixtureRoot, 'unicode', 'café.txt');
  const unicodeStagePath = path.join(fixtureRoot, 'unicode', 'unicode-stage.txt');
  const unicodeNfdPath = path.join(fixtureRoot, 'unicode', 'cafe\u0301.txt');
  renameSync(unicodeNfcPath, unicodeStagePath);
  renameSync(unicodeStagePath, unicodeNfdPath);
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /case or Unicode normalization mismatch/,
    'canonically equivalent Unicode filesystem names must exactly match the reviewed index spelling',
  );
  renameSync(unicodeNfdPath, unicodeStagePath);
  renameSync(unicodeStagePath, unicodeNfcPath);

  write('tracked.txt', 'committed delta\n');
  write('output/marketing/smirk-collateral/new-proof.html', '<p>review me</p>\n');
  git('mv', 'critical-server.ts', 'innocent-note.txt');
  git('add', '.');
  git('commit', '-qm', 'committed deploy delta');

  write('tracked.txt', 'committed and dirty\n');
  unlinkSync(path.join(fixtureRoot, 'deleted.txt'));
  git('mv', 'rename-source.txt', 'rename-destination.txt');
  write('literal -> filename.txt', 'arrow\n');
  write(' leading-space.txt', 'space\n');
  write('line\nbreak.txt', 'newline\n');
  write('output/generated.json', '{}\n');
  write('outputs/generated.txt', 'ignored\n');

  process.chdir(fixtureRoot);
  const changeSet = collectDeployChangeSet({ baseRef: base });
  for (const expected of [
    'tracked.txt',
    'deleted.txt',
    'rename-destination.txt',
    'rename-source.txt',
    'critical-server.ts',
    'innocent-note.txt',
    'literal -> filename.txt',
    ' leading-space.txt',
    'line\nbreak.txt',
    'output/marketing/smirk-collateral/new-proof.html',
  ]) {
    assert(changeSet.files.includes(expected), `missing reviewed path ${JSON.stringify(expected)}`);
  }
  assert(changeSet.committedFiles.includes('output/marketing/smirk-collateral/new-proof.html'));
  assert(changeSet.committedFiles.includes('critical-server.ts'), 'committed rename source must remain review-visible');
  assert(changeSet.committedFiles.includes('innocent-note.txt'), 'committed rename destination must remain review-visible');
  assert(changeSet.dirtyFiles.includes('rename-destination.txt'));
  assert(changeSet.dirtyFiles.includes('rename-source.txt'), 'dirty rename source must remain review-visible');
  assert.match(diffExcerptFromBase('critical-server.ts', base), /deleted file mode|security critical/);
  assert.match(diffExcerptFromBase('rename-source.txt', base), /deleted file mode|base/);
  assert.equal(changeSet.files.includes('output/generated.json'), false);
  assert.equal(changeSet.files.includes('outputs/generated.txt'), false);
  assert.throws(() => collectDeployChangeSet({ baseRef: 'definitely-not-a-commit' }), /did not resolve/);

  write('tmp/symlink-target/secret.txt', 'must not upload\n');
  mkdirSync(path.join(fixtureRoot, 'tmp/hidden-ignore-control'), { recursive: true });
  symlinkSync('../../.gitignore', path.join(fixtureRoot, 'tmp/hidden-ignore-control/.GitIgnore'));
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /filesystem \.gitignore symlink/,
    'a .gitignore symlink must fail closed even under a Git-ignored parent',
  );
  unlinkSync(path.join(fixtureRoot, 'tmp/hidden-ignore-control/.GitIgnore'));
  symlinkSync(path.join(fixtureRoot, 'tmp/symlink-target'), path.join(fixtureRoot, 'public-link'));
  assert.throws(() => collectDeployChangeSet({ baseRef: base }), /filesystem symlink/);
  git('add', '-f', 'public-link');
  assert.throws(() => collectDeployChangeSet({ baseRef: base }), /tracked symlink/);
  git('reset', '-q', 'public-link');
  unlinkSync(path.join(fixtureRoot, 'public-link'));

  const nestedRepo = path.join(fixtureRoot, 'nested-app');
  mkdirSync(nestedRepo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: nestedRepo, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'nested@smirk.invalid'], { cwd: nestedRepo, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Nested Fixture'], { cwd: nestedRepo, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(path.join(nestedRepo, 'app.ts'), 'unreviewed nested source\n');
  execFileSync('git', ['add', '.'], { cwd: nestedRepo, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-qm', 'nested'], { cwd: nestedRepo, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.throws(() => collectDeployChangeSet({ baseRef: base }), /collapsed untracked directory/);
  git('add', 'nested-app');
  assert.throws(() => collectDeployChangeSet({ baseRef: base }), /Git link\/submodule/);
  git('reset', '-q', 'nested-app');
  rmSync(nestedRepo, { recursive: true, force: true });

  write('.git/info/exclude', '.ignore\n.Ignore\n.railwayignore\n.RailwayIgnore\ntracked-dir/.GitIgnore\n');

  symlinkSync('../.gitignore', path.join(fixtureRoot, 'tracked-dir/.GitIgnore'));
  assert.equal(git('status', '--porcelain=v1', '--', 'tracked-dir/.GitIgnore'), '', 'fixture .GitIgnore symlink must be invisible to Git status');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /filesystem \.gitignore symlink/,
    'a hidden mixed-case .gitignore symlink must not alter Railway ignore walking',
  );
  unlinkSync(path.join(fixtureRoot, 'tracked-dir/.GitIgnore'));

  write('tracked-dir/.Git/config', 'deploy-visible case alias\n');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /Railway built-in path alias/,
    'a deploy-visible .Git alias must fail closed',
  );
  rmSync(path.join(fixtureRoot, 'tracked-dir/.Git'), { recursive: true, force: true });

  write('tracked-dir/Node_Modules/file.js', 'deploy-visible case alias\n');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /Railway built-in path alias/,
    'a deploy-visible Node_Modules alias must fail closed',
  );
  rmSync(path.join(fixtureRoot, 'tracked-dir/Node_Modules'), { recursive: true, force: true });

  write('.ignore', '!outputs/generated.txt\n');
  assert.equal(git('status', '--porcelain=v1', '--', '.ignore'), '', 'fixture .ignore must be invisible to Git status');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /deploy-visible \.ignore file/,
    'an uploader-visible .ignore must not bypass Git even when the control file is Git-ignored',
  );
  unlinkSync(path.join(fixtureRoot, '.ignore'));

  write('tracked-dir/.ignore', '!../outputs/generated.txt\n');
  assert.equal(git('status', '--porcelain=v1', '--', 'tracked-dir/.ignore'), '', 'nested fixture .ignore must be invisible to Git status');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /deploy-visible \.ignore file "tracked-dir\/\.ignore"/,
    'a nested .ignore hidden from Git status must not alter the uploader path set',
  );
  unlinkSync(path.join(fixtureRoot, 'tracked-dir/.ignore'));

  write('deploy-config/.ignore', '!outputs/generated.txt\n');
  git('add', '-f', 'deploy-config/.ignore');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /deploy-visible \.ignore file "deploy-config\/\.ignore"/,
    'a tracked nested .ignore must not change the uploader path set',
  );
  git('reset', '-q', '--', 'deploy-config/.ignore');
  rmSync(path.join(fixtureRoot, 'deploy-config'), { recursive: true, force: true });

  write('.railwayignore', '# ! inside a comment is inert\nnode_modules/\n');
  assert.doesNotThrow(
    () => collectDeployChangeSet({ baseRef: base }),
    'comments containing ! must not be treated as negating rules',
  );
  write('.railwayignore', '# ordinary exclusions remain allowed\nnode_modules/\n  !outputs/generated.txt\n');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /negating \.railwayignore rule on line 3/,
    'a .railwayignore negation must not re-include Git-ignored files',
  );
  write('.railwayignore', 'tracked.txt\n');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /would omit tracked reviewed path "tracked.txt"/,
    'ordinary .railwayignore exclusions must not omit tracked reviewed code',
  );
  write('.railwayignore', 'literal -> filename.txt\n');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /would omit untracked reviewed path "literal -> filename.txt"/,
    'ordinary .railwayignore exclusions must not omit untracked reviewed files',
  );
  unlinkSync(path.join(fixtureRoot, '.railwayignore'));

  write('tracked-dir/.railwayignore', '# hidden nested override\n  !secret.txt\n');
  assert.equal(git('status', '--porcelain=v1', '--', 'tracked-dir/.railwayignore'), '', 'nested fixture .railwayignore must be invisible to Git status');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /rejects nested \.railwayignore file/,
    'a nested .railwayignore hidden from Git status must not re-include an unreviewed file',
  );
  unlinkSync(path.join(fixtureRoot, 'tracked-dir/.railwayignore'));

  write('tracked-dir/.Ignore', '!../outputs/generated.txt\n');
  assert.equal(git('status', '--porcelain=v1', '--', 'tracked-dir/.Ignore'), '', 'mixed-case nested fixture .Ignore must be invisible to Git status');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /deploy-visible \.ignore file "tracked-dir\/\.Ignore"/,
    'a mixed-case .Ignore alias on a case-insensitive filesystem must fail closed',
  );
  unlinkSync(path.join(fixtureRoot, 'tracked-dir/.Ignore'));

  write('tracked-dir/.RailwayIgnore', '# hidden mixed-case override\n!secret.txt\n');
  assert.equal(git('status', '--porcelain=v1', '--', 'tracked-dir/.RailwayIgnore'), '', 'mixed-case nested fixture .RailwayIgnore must be invisible to Git status');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /rejects nested \.railwayignore file/,
    'a mixed-case .RailwayIgnore alias on a case-insensitive filesystem must fail closed',
  );
  unlinkSync(path.join(fixtureRoot, 'tracked-dir/.RailwayIgnore'));

  write('.gitignore', 'output/*.json\noutputs/\ntmp/\n.artifacts/\ntracked.txt\n');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /tracked path "tracked.txt" because standard Git ignore rules would omit reviewed code/,
    'standard Git ignore rules must not omit a force-tracked reviewed file',
  );
  write('.gitignore', 'output/*.json\noutputs/\ntmp/\n.artifacts/\n');

  process.env.GIT_WORK_TREE = path.join(fixtureRoot, 'tracked-dir');
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /ambient Git context override GIT_WORK_TREE/,
    'ambient Git worktree overrides must not validate a different tree from the Railway upload cwd',
  );
  if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
  else process.env.GIT_WORK_TREE = originalGitWorkTree;

  process.env.GIT_INDEX_FILE = '/dev/null';
  assert.throws(
    () => collectDeployChangeSet({ baseRef: base }),
    /ambient Git context override GIT_INDEX_FILE/,
    'ambient Git index overrides must not validate a different index from the Railway upload cwd',
  );

  console.log('OK deploy change-set review includes committed and dirty paths, handles unusual filenames, rejects uploader ignore overrides, and fails closed');
} finally {
  process.chdir(originalCwd);
  if (originalGitIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
  else process.env.GIT_INDEX_FILE = originalGitIndexFile;
  if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
  else process.env.GIT_WORK_TREE = originalGitWorkTree;
  if (alternateWorktreeRoot) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', alternateWorktreeRoot], {
        cwd: fixtureRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      // Best-effort fixture cleanup.
    }
    rmSync(alternateWorktreeRoot, { recursive: true, force: true });
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}
