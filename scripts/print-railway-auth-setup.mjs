import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const targetFile = `${process.env.HOME}/.openclaw/workspace/.env.operator`;
const candidateFiles = [
  targetFile,
  `${process.env.HOME}/.openclaw/workspace/.env.smirk`,
  `${process.env.HOME}/.openclaw/workspace/.env`,
  `${process.env.HOME}/.zshrc`,
  `${process.env.HOME}/.zprofile`,
  `${process.env.HOME}/.zshenv`,
  `${process.env.HOME}/.profile`,
];

const readTokenState = () => {
  if (!fs.existsSync(targetFile)) return 'missing-file';
  const lines = fs.readFileSync(targetFile, 'utf8').split(/\r?\n/);
  const line = lines.find((entry) => entry.startsWith('RAILWAY_API_TOKEN='));
  if (!line) return 'missing-entry';
  const value = line.slice('RAILWAY_API_TOKEN='.length).trim().replace(/^['"]|['"]$/g, '');
  if (!value) return 'blank-entry';
  if (['***', 'fake-token', '<token>', '<valid-token>', 'your-token-here', 'replace-me'].includes(value)) return 'placeholder-entry';
  return 'present';
};

const tokenState = readTokenState();
const statusPath = `${process.cwd()}/scripts/print-railway-auth-status.mjs`;
let authStatus = 'unknown';
try {
  if (fs.existsSync(statusPath)) {
    const raw = execFileSync('node', [statusPath], { encoding: 'utf8' }).trim();
    authStatus = JSON.parse(raw)?.authCheck?.state || 'unknown';
  }
} catch {
  authStatus = 'unknown';
}
const stateLine = {
  'missing-file': `3. ${targetFile} does not exist yet; bootstrap/save will create it`,
  'missing-entry': `3. ${targetFile} currently has no RAILWAY_API_TOKEN entry`,
  'blank-entry': `3. ${targetFile} has a blank RAILWAY_API_TOKEN entry that should be replaced`,
  'placeholder-entry': `3. ${targetFile} has a placeholder RAILWAY_API_TOKEN entry that should be replaced`,
  'present': authStatus === 'invalid'
    ? `3. ${targetFile} has a present but invalid RAILWAY_API_TOKEN entry that should be replaced with a fresh Railway account token`
    : `3. ${targetFile} already has a RAILWAY_API_TOKEN entry; replace it if it is invalid`,
}[tokenState];

const localCandidateSummary = (() => {
  let present = 0;
  let blank = 0;
  let placeholder = 0;
  for (const file of candidateFiles) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!(line.startsWith('RAILWAY_API_TOKEN=') || line.startsWith('RAILWAY_TOKEN='))) continue;
      const value = line.slice(line.indexOf('=') + 1).replace(/^['"]|['"]$/g, '');
      if (!value) blank += 1;
      else if (['***', 'fake-token', '<token>', '<valid-token>', 'your-token-here', 'replace-me'].includes(value)) placeholder += 1;
      else present += 1;
    }
  }
  if (present > 0) return `Found ${present} non-blank local Railway token candidate(s); reuse one if it is valid.`;
  if (placeholder > 0) return `Only placeholder Railway token entries were found locally; replace them with a real token.`;
  if (blank > 0) return `Only blank Railway token entries were found locally; paste a real token from Railway.`;
  return 'No local Railway token candidates were found in common env/shell files; get a fresh token from Railway.';
})();

console.log(
  [
    'Railway auth setup:',
    '1. Open https://railway.app/account/tokens',
    '1a. Shortcut: npm run -s open:railway-token-page',
    '2. Create/copy a real Railway token (not fake-token, <token>, or ***)',
    stateLine,
    `4. ${localCandidateSummary}`,
    '5. Inspect local Railway auth status anytime: npm run -s print:railway-auth-status',
    `6. Fast path: printf '%s' '<real-token>' | TARGET_FILE='${targetFile}' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth`,
    '7. bootstrap:railway-auth will save the token, run npm run -s check:railway, then continue only if auth is valid',
    `8. Save-only path: printf '%s' '<real-token>' | SKIP_CHECK=1 TARGET_FILE='${targetFile}' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth`,
    `9. Env-var path: RAILWAY_API_TOKEN='<real-token>' TARGET_FILE='${targetFile}' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth`,
    `10. One-shot path: printf '%s' '<real-token>' | TARGET_FILE='${targetFile}' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy`,
    '11. Clipboard path (macOS): copy the Railway token, then run: npm run -s bootstrap:railway-auth-from-clipboard-and-deploy',
    '11a. Fastest macOS path: npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy',
    authStatus === 'invalid'
      ? `12. Preferred invalid-token recovery: npm run -s open:railway-token-page && printf '%s' '<real-token>' | TARGET_FILE='${targetFile}' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth`
      : `12. Alternative: printf '%s' '<real-token>' | TARGET_FILE='${targetFile}' KEY_NAME='RAILWAY_API_TOKEN' npm run -s save:railway-auth`,
    '13. After saving manually, run: npm run -s check:railway',
    '14. Then run: npm run -s check:deploy-post-call-fix-ready',
    '15. Then run: npm run write:deploy-approval-bundle',
    '16. Then run: npm run deploy:post-call-fix',
  ].join('\n'),
);
