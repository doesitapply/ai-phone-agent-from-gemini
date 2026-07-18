#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

const git = (args, options = {}) => {
  const result = execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: MAX_ARCHIVE_BYTES,
    ...options,
  });
  return Buffer.isBuffer(result) ? result : result.trim();
};

const listExtractedFiles = (root, directory = root, prefix = '') => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`Exact deploy archive rejects symlink ${JSON.stringify(relativePath)}.`);
    if (stat.isDirectory()) {
      files.push(...listExtractedFiles(root, absolutePath, relativePath));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Exact deploy archive rejects special filesystem entry ${JSON.stringify(relativePath)}.`);
    files.push(relativePath);
  }
  return files.sort();
};

export function materializeExactCommitArchive({ commit = 'HEAD', outputDirectory }) {
  const output = path.resolve(String(outputDirectory || ''));
  if (!outputDirectory || !path.basename(output).startsWith('smirk-railway-deploy.')) {
    throw new Error('Exact deploy archive output must be a dedicated smirk-railway-deploy.* temporary directory.');
  }
  if (readdirSync(output).length !== 0) throw new Error('Exact deploy archive output directory must start empty.');

  const resolvedCommit = git(['rev-parse', '--verify', `${commit}^{commit}`]);
  const treeRecords = git(['ls-tree', '-r', '-z', '--format=%(objectmode)\t%(path)', resolvedCommit], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const expected = [];
  for (const record of treeRecords) {
    const tab = record.indexOf('\t');
    if (tab <= 0) throw new Error(`Unexpected Git tree record: ${JSON.stringify(record)}`);
    const mode = record.slice(0, tab);
    const file = record.slice(tab + 1);
    if (!['100644', '100755'].includes(mode)) {
      throw new Error(`Exact deploy archive rejects non-regular Git entry ${JSON.stringify(file)} with mode ${mode}.`);
    }
    if (file.split('/').some((segment) => segment === '.git' || segment === 'node_modules')) {
      throw new Error(`Exact deploy archive rejects Railway built-in excluded path ${JSON.stringify(file)}.`);
    }
    expected.push(file);
  }
  expected.sort();

  const archivePath = path.join(output, '.smirk-exact-source.tar');
  const archive = execFileSync('git', ['archive', '--format=tar', resolvedCommit], { maxBuffer: MAX_ARCHIVE_BYTES });
  writeFileSync(archivePath, archive);
  try {
    execFileSync('tar', ['-xf', archivePath, '-C', output], { stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    unlinkSync(archivePath);
  }

  const actual = listExtractedFiles(output);
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    const missing = expected.find((file) => !actual.includes(file));
    const extra = actual.find((file) => !expected.includes(file));
    throw new Error(`Exact deploy archive manifest differs from commit ${resolvedCommit}; missing=${JSON.stringify(missing || null)} extra=${JSON.stringify(extra || null)}.`);
  }

  return {
    ok: true,
    commit: resolvedCommit,
    outputDirectory: realpathSync(output),
    fileCount: actual.length,
  };
}

const isCli = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = process.argv.slice(2);
  const commitIndex = args.indexOf('--commit');
  const outputIndex = args.indexOf('--output');
  const result = materializeExactCommitArchive({
    commit: commitIndex >= 0 ? args[commitIndex + 1] : 'HEAD',
    outputDirectory: outputIndex >= 0 ? args[outputIndex + 1] : '',
  });
  console.log(JSON.stringify(result));
}
