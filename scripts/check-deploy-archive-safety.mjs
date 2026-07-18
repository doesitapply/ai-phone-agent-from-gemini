#!/usr/bin/env node
import { assertDeployArchiveSafety } from './lib/deploy-change-set.mjs';
import fs from 'node:fs';

try {
  assertDeployArchiveSafety();
  const deployScript = fs.readFileSync('deploy.sh', 'utf8');
  for (const required of [
    'prepare-exact-deploy-archive.mjs --commit "$TARGET_COMMIT"',
    'railway up --detach --no-gitignore',
    '--project 90599f03-6d6f-4044-8933-e0301be67a82',
    '--service 96bcd6e7-9487-4197-bcd1-a6bd0546e6b2',
    '--environment 22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a',
    '"$DEPLOY_ARCHIVE_DIR"',
  ]) {
    if (!deployScript.includes(required)) throw new Error(`Deploy script must upload an exact-commit archive: missing ${required}`);
  }
  console.log('OK deploy archive matches the trusted Git root/index and contains no path-name, link, built-in-exclusion, or ignore-walker bypasses');
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: 'unsafe-deploy-archive-shape',
    message: String(error?.message || error),
  }, null, 2));
  process.exit(1);
}
