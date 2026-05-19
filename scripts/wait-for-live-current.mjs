#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const timeoutMs = Number(process.env.SMIRK_WAIT_TIMEOUT_MS || process.argv[2] || 180000);
const intervalMs = Number(process.env.SMIRK_WAIT_INTERVAL_MS || process.argv[3] || 10000);
const started = Date.now();
let lastDetail = null;

while (true) {
  try {
    const out = execFileSync('npm', ['run', '-s', 'check:live-is-current'], { encoding: 'utf8' }).trim();
    if (out) console.log(out);
    process.exit(0);
  } catch (error) {
    const text = String(error?.stdout || error?.stderr || error?.message || '').trim();
    if (text) console.log(text);
    try {
      lastDetail = text ? JSON.parse(text) : lastDetail;
    } catch {
      // keep last parsed detail if current output is not JSON
    }
    if (Date.now() - started >= timeoutMs) {
      console.error(JSON.stringify({
        ok: false,
        timeoutMs,
        intervalMs,
        waitedMs: Date.now() - started,
        failure: 'live-version-did-not-match-before-timeout',
        expectedVersion: lastDetail?.expectedVersion || null,
        actualVersion: lastDetail?.actualVersion || lastDetail?.detail?.actualVersion || null,
        liveBranch: lastDetail?.actualBranch || lastDetail?.detail?.actualBranch || null,
        appUrl: lastDetail?.appUrl || lastDetail?.detail?.url || null,
        nextAction: 'Check Railway deploy status, then rerun npm run deploy:post-call-fix if live is still stale.'
      }, null, 2));
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
