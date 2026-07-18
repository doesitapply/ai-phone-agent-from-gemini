#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materializeExactCommitArchive } from './prepare-exact-deploy-archive.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'smirk-archive-fixture.'));
const output = mkdtempSync(path.join(os.tmpdir(), 'smirk-railway-deploy.'));
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

try {
  git(['init', '-q']);
  git(['config', 'user.email', 'archive-fixture@smirk.invalid']);
  git(['config', 'user.name', 'Archive Fixture']);
  writeFileSync(path.join(root, 'app.ts'), 'export const ready = true;\n');
  git(['add', 'app.ts']);
  git(['commit', '-qm', 'fixture']);

  mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'info', 'exclude'), 'PRIVATE_PROSPECTS.md\n');
  writeFileSync(path.join(root, 'PRIVATE_PROSPECTS.md'), 'must never upload\n');
  assert.equal(git(['status', '--porcelain=v1', '--', 'PRIVATE_PROSPECTS.md']), '', 'private exclude must hide the fixture from status');

  const previous = process.cwd();
  process.chdir(root);
  try {
    const result = materializeExactCommitArchive({ commit: 'HEAD', outputDirectory: output });
    assert.equal(result.fileCount, 1);
  } finally {
    process.chdir(previous);
  }
  assert.equal(existsSync(path.join(output, 'app.ts')), true, 'tracked source must be archived');
  assert.equal(existsSync(path.join(output, 'PRIVATE_PROSPECTS.md')), false, 'Git-private excluded bytes must not enter exact-commit archive');
  console.log('OK exact-commit deploy archive excludes Git-private and untracked bytes');
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(output, { recursive: true, force: true });
}
