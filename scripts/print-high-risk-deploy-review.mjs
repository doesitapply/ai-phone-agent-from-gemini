#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const files = ['deploy.sh', 'package.json', 'server.ts', 'src/App.tsx'];
const reasons = {
  'deploy.sh': 'Wait for live commit parity after Railway upload, then run the full ship check automatically.',
  'package.json': 'Adds the live verification, deploy handoff, and real proof-call scripts used to prove the shipped path.',
  'server.ts': 'Always trigger post-call intelligence after call end so summaries are attempted on production calls.',
  'src/App.tsx': 'Tightens buyer activation/login flow so payment follows activation request and invite-based access is clearer.',
};

function diffNumstat(file) {
  const raw = execFileSync('git', ['diff', '--numstat', '--', file], { encoding: 'utf8' }).trim();
  const [added, removed] = raw.split(/\s+/);
  return { added: Number(added || 0), removed: Number(removed || 0) };
}

function diffExcerpt(file) {
  return execFileSync('git', ['diff', '--unified=1', '--', file], { encoding: 'utf8' }).trim();
}

const review = files.map((file) => ({
  file,
  ...diffNumstat(file),
  reason: reasons[file] || null,
  excerpt: diffExcerpt(file),
}));

console.log(JSON.stringify({
  ok: true,
  files: review,
}, null, 2));
