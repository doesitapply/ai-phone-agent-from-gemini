#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const raw = execFileSync('npm', ['run', '-s', 'print:deploy-approval-request'], { encoding: 'utf8' }).trim();
const data = JSON.parse(raw);
const target = path.resolve(process.cwd(), 'output', 'deploy-approval-request.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, path: target, commit: data.commit || null }, null, 2));
