#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const staticReasons = {
  'deploy.sh': 'Wait for live commit parity after Railway upload, then run the full ship check automatically.',
  'package.json': 'Adds the live verification, deploy handoff, and real proof-call scripts used to prove the shipped path.',
  'server.ts': 'Always trigger post-call intelligence after call end so summaries are attempted on production calls.',
  'src/App.tsx': 'Tightens buyer activation/login flow so payment follows activation request and invite-based access is clearer.',
};

function statusEntries() {
  return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      const file = line.replace(/^.{1,2}\s+/, '').replace(/^.* -> /, '').trim();
      const status = line.slice(0, 2).trim() || 'M';
      if (status === '??' && existsSync(file) && statSync(file).isDirectory()) {
        return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', file], { encoding: 'utf8' })
          .split(/\r?\n/)
          .filter(Boolean)
          .map((entry) => ({ status, file: entry }));
      }
      return [{ status, file }];
    })
    .filter(({ file }) => file && !file.startsWith('output/') && !file.startsWith('outputs/') && !file.startsWith('tmp/'));
}

function reasonFor(file) {
  if (staticReasons[file]) return staticReasons[file];
  if (file.startsWith('scripts/')) return 'Changes deploy, proof-call, auth, or launch verification helpers that gate first-dollar readiness.';
  if (file.endsWith('.md')) return 'Changes operator or buyer-facing readiness documentation used before production proof.';
  if (file.startsWith('src/')) return 'Changes frontend behavior or copy visible to buyer/operator workflows.';
  return 'Deploy-relevant local change included in the production approval surface.';
}

function diffNumstat(file) {
  const raw = execFileSync('git', ['diff', '--numstat', '--', file], { encoding: 'utf8' }).trim();
  if (!raw && existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    return { added: text.split(/\r?\n/).length, removed: 0 };
  }
  const [added, removed] = raw.split(/\s+/);
  return { added: Number(added || 0), removed: Number(removed || 0) };
}

function diffExcerpt(file) {
  const diff = execFileSync('git', ['diff', '--unified=1', '--', file], { encoding: 'utf8' }).trim();
  if (diff) return diff;
  if (existsSync(file) && statSync(file).isFile()) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 80);
    return [`--- untracked file: ${file}`, ...lines.map((line) => `+${line}`)].join('\n');
  }
  return '';
}

const review = statusEntries().map(({ status, file }) => ({
  file,
  status,
  ...diffNumstat(file),
  reason: reasonFor(file),
  excerpt: diffExcerpt(file),
}));

console.log(JSON.stringify({
  ok: true,
  deployRelevantFileCount: review.length,
  files: review,
}, null, 2));
