# SMIRK deploy approval request

- Branch: main
- Commit: ca0198e389e0b6094f0a3158ea08f9a9f59a9789
- Live version current: no
- Expected version: ca0198e389e0b6094f0a3158ea08f9a9f59a9789
- Actual live version: 90f9b4d3055faaf67e1d63efc6cd1fd42b17ef94
- Live branch: main
- Changed file count: 46
- High-risk file count: 4
- Approval bundle generated at: 2026-05-19T19:35:57.230Z
- Approval bundle source commit: ca0198e389e0b6094f0a3158ea08f9a9f59a9789
- Approval artifact freshness: handoff 2026-05-19T19:35:55.324Z; approval note unknown; high-risk review 2026-05-19T19:35:57.133Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 90f9b4d3055faaf67e1d63efc6cd1fd42b17ef94, failure version-mismatch)
- Approval bundle command: npm run write:deploy-approval-bundle
- High-risk review command: npm run print:high-risk-deploy-review
- Deploy command: npm run deploy:post-call-fix
- Reason: Deploy local HEAD to Railway so live matches the current code before the real proof-call verification run.

## Approval artifacts
- output/deploy-approval-bundle.json
- output/post-call-fix-handoff.json
- output/post-call-fix-approval-note.md
- output/high-risk-deploy-review.json

## Approval steps
- 1. npm run write:deploy-approval-bundle
- 2. npm run print:high-risk-deploy-review
- 3. npm run deploy:post-call-fix

## High-risk files
- deploy.sh: +23 / -2 — Wait for live commit parity after Railway upload, then run the full ship check automatically.
- package.json: +30 / -0 — Adds the live verification, deploy handoff, and real proof-call scripts used to prove the shipped path.
- server.ts: +3 / -5 — Always trigger post-call intelligence after call end so summaries are attempted on production calls.
- src/App.tsx: +109 / -28 — Tightens buyer activation/login flow so payment follows activation request and invite-based access is clearer.

## Current blocker
- stale-production-deploy
- Next action: Approve and run npm run deploy:post-call-fix
