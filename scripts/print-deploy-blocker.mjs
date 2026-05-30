#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const localCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const localBranch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() || 'main';
const handoffFilePath = path.resolve(process.cwd(), 'output', 'post-call-fix-handoff.json');
const handoffFileExists = fs.existsSync(handoffFilePath);
const operatorAuthFilePath = path.resolve(process.env.HOME || '', '.openclaw/workspace/.env.operator');
let clipboardAvailable = false;
try {
  execFileSync('bash', ['-lc', 'command -v pbpaste >/dev/null 2>&1']);
  clipboardAvailable = true;
} catch {
  clipboardAvailable = false;
}
const localAuthFiles = [
  operatorAuthFilePath,
  path.resolve(process.env.HOME || '', '.openclaw/workspace/.env.smirk'),
  path.resolve(process.env.HOME || '', '.openclaw/workspace/.env'),
];
const localAuthSummary = localAuthFiles.map((filePath) => {
  if (!fs.existsSync(filePath)) return { file: filePath, state: 'missing' };
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const tokenLine = lines.find((line) => line.startsWith('RAILWAY_API_TOKEN=') || line.startsWith('RAILWAY_TOKEN='));
  if (!tokenLine) return { file: filePath, state: 'no-token-lines' };
  const [key, rawValue] = tokenLine.split(/=(.*)/s);
  const value = String(rawValue || '').replace(/^['"]|['"]$/g, '');
  const state = !value ? 'blank' : (['***', 'fake-token', '<token>', '<valid-token>', 'your-token-here', 'replace-me'].includes(value) ? 'placeholder' : 'present');
  return { file: filePath, key, state };
});

let railwayDetail = '';
try {
  railwayDetail = execFileSync('npm', ['run', '-s', 'check:railway'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
} catch (error) {
  railwayDetail = [String(error?.stdout || ''), String(error?.stderr || '')].filter(Boolean).join('\n').trim();
  if (/Railway auth missing/i.test(railwayDetail || '') || railwayDetail) {
    const blocker = /Railway auth missing/i.test(railwayDetail || '') ? 'railway-auth-missing' : 'railway-auth-invalid';
    console.log(JSON.stringify({
      ok: false,
      blocker,
      requiresApproval: false,
    localBranch,
    localCommit,
    nextAction: blocker === 'railway-auth-missing'
      ? (clipboardAvailable
          ? 'Run npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy, then copy a real Railway token when the page opens; the helper will run auth checks, generate the approval bundle, and deploy.'
          : 'Restore Railway auth, then generate the approval bundle and rerun deploy readiness.')
      : 'Replace the invalid Railway token, then rerun deploy readiness, generate the approval bundle, and deploy.',
    authSetupCommand: 'npm run -s print:railway-auth-setup',
    authOpenTokenPageCommand: 'npm run -s open:railway-token-page',
    authStatusCommand: 'npm run -s print:railway-auth-status',
    authInitCommand: 'npm run -s init:railway-auth-file',
    authFilePath: operatorAuthFilePath,
    authFileReady: fs.existsSync(operatorAuthFilePath),
    clipboardAvailable,
    authBootstrapCommand: "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth",
    authReplaceCommand: blocker === 'railway-auth-invalid'
      ? "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth"
      : null,
    authSaveOnlyCommand: "printf '%s' '<real-token>' | SKIP_CHECK=1 TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth",
    authEnvCommand: "RAILWAY_API_TOKEN='<real-token>' TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth",
    authOneShotCommand: "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy",
    authReplaceAndDeployCommand: blocker === 'railway-auth-invalid'
      ? "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy"
      : null,
    authClipboardCommand: 'npm run -s bootstrap:railway-auth-from-clipboard-and-deploy',
    authClipboardWatchCommand: 'npm run -s bootstrap:railway-auth-watch-clipboard-and-deploy',
    authOpenPageWatchClipboardCommand:
      'npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy',
    authPrimaryCommand: clipboardAvailable
      ? 'npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy'
      : "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy",
    authRecommendedSequence: blocker === 'railway-auth-invalid'
      ? [
          'npm run -s open:railway-token-page',
          "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth",
          'npm run -s check:deploy-post-call-fix-ready',
          'npm run write:deploy-approval-bundle',
          'npm run deploy:post-call-fix'
        ]
      : (clipboardAvailable
          ? [
              'npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy',
              'npm run write:deploy-approval-bundle',
              'npm run deploy:post-call-fix'
            ]
          : [
              'npm run -s print:railway-auth-setup',
              "printf '%s' '<real-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy",
              'npm run write:deploy-approval-bundle',
              'npm run deploy:post-call-fix'
            ]),
    authNextSteps: [
      'npm run -s check:railway',
      'npm run -s check:deploy-post-call-fix-ready',
      'npm run write:deploy-approval-bundle',
      'npm run deploy:post-call-fix'
    ],
    localAuthSummary,
      detail: railwayDetail || null,
    }, null, 2));
    process.exit(1);
  }
}

let detail = '';
try {
  execFileSync('npm', ['run', '-s', 'check:live-is-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(JSON.stringify({ ok: true, message: 'Live Railway already matches local HEAD.', localBranch, localCommit }, null, 2));
} catch (error) {
  detail = String(error?.stdout || error?.stderr || '').trim();
  let parsedDetail = null;
  try {
    parsedDetail = detail ? JSON.parse(detail) : null;
  } catch {
    parsedDetail = null;
  }
  const fingerprintDetail = parsedDetail?.detail || parsedDetail || null;
  console.log(JSON.stringify({
    ok: false,
    blocker: 'stale-production-deploy',
    requiresApproval: true,
    localBranch,
    localCommit,
    expectedVersion: parsedDetail?.expectedVersion || localCommit,
    actualVersion: parsedDetail?.actualVersion || fingerprintDetail?.actualVersion || fingerprintDetail?.versionHeader || null,
    liveBranch: parsedDetail?.actualBranch || fingerprintDetail?.actualBranch || fingerprintDetail?.branchHeader || null,
    liveReadinessHeader: fingerprintDetail?.readinessHeader || null,
    liveStatus: fingerprintDetail?.status ?? null,
    appUrl: parsedDetail?.appUrl || fingerprintDetail?.url || null,
    nextAction: "Generate the approval bundle, get approval, then run npm run deploy:post-call-fix",
    approvalBundleCommand: "npm run write:deploy-approval-bundle",
    approvalBundlePath: "output/deploy-approval-bundle.json",
    approvalRequestCommand: "npm run write:deploy-approval-request",
    handoffFileCommand: "npm run write:post-call-fix-handoff",
    handoffFilePath,
    handoffFileExists,
    detail: parsedDetail || detail || null,
  }, null, 2));
  process.exit(1);
}
