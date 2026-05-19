#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const out = execFileSync('npm', ['run', '-s', 'print:post-call-fix-handoff'], { encoding: 'utf8' }).trim();
const target = path.resolve(process.cwd(), 'output', 'post-call-fix-handoff.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out + '\n');

const skipApprovalNote = process.env.SMIRK_SKIP_APPROVAL_NOTE === '1';
let approvalNotePath = null;
let approvalNoteExists = false;

if (!skipApprovalNote) {
  const approvalNote = execFileSync('node', ['scripts/write-deploy-approval-note.mjs'], { encoding: 'utf8' }).trim();
  try {
    approvalNotePath = JSON.parse(approvalNote)?.path || null;
  } catch {
    approvalNotePath = null;
  }
  approvalNoteExists = !!(approvalNotePath && fs.existsSync(approvalNotePath));
}

const ok = skipApprovalNote ? true : approvalNoteExists;
console.log(JSON.stringify({ ok, path: target, approvalNotePath, approvalNoteExists, skipApprovalNote }, null, 2));
if (!ok) process.exit(1);
