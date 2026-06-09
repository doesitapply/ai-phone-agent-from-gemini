#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = process.env.HOME || '';
const files = [
  path.resolve(home, '.openclaw/workspace/.env.operator'),
  path.resolve(home, '.openclaw/workspace/.env.smirk'),
  path.resolve(home, '.openclaw/workspace/.env'),
  path.resolve(home, '.zshrc'),
  path.resolve(home, '.zprofile'),
  path.resolve(home, '.zshenv'),
  path.resolve(home, '.profile'),
];

const placeholders = new Set(['***', 'fake-token', '<token>', '<valid-token>', 'your-token-here', 'replace-me']);

const inspectFile = (file) => {
  if (!fs.existsSync(file)) return { file, state: 'missing' };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const matches = lines
    .filter((line) => line.startsWith('RAILWAY_API_TOKEN=') || line.startsWith('RAILWAY_TOKEN='))
    .map((line) => {
      const [key, rawValue] = line.split(/=(.*)/s);
      const value = String(rawValue || '').replace(/^['"]|['"]$/g, '');
      const state = !value ? 'blank' : (placeholders.has(value) ? 'placeholder' : 'present');
      return { key, state, length: value.length || 0 };
    });
  if (!matches.length) return { file, state: 'no-token-lines' };
  return { file, state: 'found', entries: matches };
};

const results = files.map(inspectFile);
const summary = {
  present: results.flatMap((r) => r.entries || []).filter((e) => e.state === 'present').length,
  blank: results.flatMap((r) => r.entries || []).filter((e) => e.state === 'blank').length,
  placeholder: results.flatMap((r) => r.entries || []).filter((e) => e.state === 'placeholder').length,
};
const primaryFile = path.resolve(home, '.openclaw/workspace/.env.operator');
const deployBranch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || 'main';
const deployCommand = deployBranch !== 'main'
  ? `CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=${deployBranch} npm run deploy:post-call-fix`
  : 'CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix';
const primaryResult = results.find((r) => r.file === primaryFile) || null;
const primaryToken = primaryResult?.entries?.find((e) => e.key === 'RAILWAY_API_TOKEN') || null;
let authCheck = { state: 'unknown', detail: null };
try {
  const output = execFileSync('npm', ['run', '-s', 'check:railway'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  authCheck = { state: 'valid', detail: output || null };
} catch (error) {
  const detail = [String(error?.stdout || ''), String(error?.stderr || '')].filter(Boolean).join('\n').trim() || null;
  authCheck = {
    state: /Railway auth missing/i.test(detail || '') ? 'missing' : 'invalid',
    detail,
  };
}
const openTokenPageCommand = 'npm run -s open:railway-token-page';
const replaceCommand = `printf '%s' '<real-token>' | TARGET_FILE='${primaryFile}' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth`;
const replaceAndDeployCommand = `printf '%s' '<real-token>' | TARGET_FILE='${primaryFile}' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy`;
const authRecommendedSequence = authCheck.state === 'valid'
  ? [
      'npm run -s check:deploy-post-call-fix-ready',
      'npm run write:deploy-approval-bundle',
      deployCommand
    ]
  : [
      openTokenPageCommand,
      replaceCommand,
      'npm run -s check:deploy-post-call-fix-ready',
      'npm run write:deploy-approval-bundle',
      deployCommand
    ];
const nextAction = authCheck.state === 'valid'
  ? 'Railway auth is valid; continue with deploy readiness and deploy.'
  : (primaryToken?.state === 'present'
      ? `Replace invalid RAILWAY_API_TOKEN in ${primaryFile} with a fresh Railway account token, then rerun deploy readiness.`
      : `Save a real RAILWAY_API_TOKEN to ${primaryFile}, then rerun deploy readiness.`);

console.log(JSON.stringify({ ok: summary.present > 0, summary, primaryFile, primaryTokenState: primaryToken?.state || 'missing', authCheck, openTokenPageCommand, nextAction, replaceCommand, replaceAndDeployCommand, authRecommendedSequence, results }, null, 2));
