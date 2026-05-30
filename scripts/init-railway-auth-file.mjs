#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.env.HOME || '', '.openclaw/workspace/.env.operator');
const header = [
  '# Railway operator auth',
  '# Paste a real Railway personal token after the equals sign below.',
  '# Get one from https://railway.app/account/tokens',
].join('\n');

fs.mkdirSync(path.dirname(target), { recursive: true });
let text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';

if (!text.includes('# Railway operator auth')) {
  text = text ? `${header}\n\n${text}` : `${header}\n\n`;
}
if (!/^RAILWAY_API_TOKEN=/m.test(text)) {
  if (text && !text.endsWith('\n')) text += '\n';
  text += 'RAILWAY_API_TOKEN=\n';
}
fs.writeFileSync(target, text);
fs.chmodSync(target, 0o600);
const finalText = fs.readFileSync(target, 'utf8');
const hasEntry = /^RAILWAY_API_TOKEN=/m.test(finalText);
const hasHeader = finalText.includes('# Railway operator auth');
console.log(JSON.stringify({ ok: hasEntry && hasHeader, path: target, initialized: hasEntry, hasHeader }, null, 2));
if (!hasEntry) process.exit(1);
