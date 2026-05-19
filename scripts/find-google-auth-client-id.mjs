#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');

const roots = [
  process.cwd(),
  '/Users/cameronchurch/.openclaw/workspace/SMIRK_ACCESS_BRIEF.md',
  '/Users/cameronchurch/.openclaw/workspace/SMIRK_OPERATOR_ACCESS.md',
  '/Users/cameronchurch/.openclaw/workspace/project-logs/SMIRK.md',
  '/Users/cameronchurch/.openclaw/workspace/smirk/system-status.md',
];
const skipDirNames = new Set(['node_modules', '.git', 'dist', 'dist-server', '.next', '.turbo', 'coverage', 'browser']);
const allowedExt = new Set(['.md', '.mdx', '.txt', '.json', '.jsonl', '.env', '.sh', '.mjs', '.cjs', '.js', '.ts', '.tsx', '.yml', '.yaml']);
const placeholderValues = new Set([
  'your-google-web-client-id.apps.googleusercontent.com',
  'your-client-id.apps.googleusercontent.com',
]);
const seen = new Set();
const hits = [];

function scanFile(full) {
  const ext = path.extname(full).toLowerCase();
  const name = path.basename(full);
  if (!allowedExt.has(ext) && !name.startsWith('.env')) return;
  let text = '';
  try {
    const size = statSync(full).size;
    if (size > 512_000) return;
    text = readFileSync(full, 'utf8');
  } catch {
    return;
  }
  const matches = text.match(/[0-9A-Za-z._-]+\.apps\.googleusercontent\.com/g) || [];
  for (const match of matches) {
    if (placeholderValues.has(match)) continue;
    const key = `${full}::${match}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ file: full, clientId: match });
  }
}

function walk(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirNames.has(entry.name)) continue;
      walk(full);
      continue;
    }
    scanFile(full);
  }
}

for (const root of roots) {
  try {
    const st = statSync(root);
    if (st.isDirectory()) walk(root);
    else if (st.isFile()) scanFile(root);
  } catch {
    // ignore missing roots
  }
}

if (jsonMode) {
  console.log(JSON.stringify({ hits }, null, 2));
  process.exit(hits.length === 0 ? 1 : 0);
}

if (hits.length === 0) {
  console.log('No non-placeholder Google OAuth web client IDs found in the repo/workspace scan.');
  process.exit(1);
}

console.log('Found Google OAuth client ID candidates:');
for (const hit of hits) {
  console.log(`- ${hit.clientId}`);
  console.log(`  ${hit.file}`);
}
