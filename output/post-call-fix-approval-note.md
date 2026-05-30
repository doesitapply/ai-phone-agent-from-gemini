# SMIRK deploy approval request

- Branch: main
- Commit: 07601180a57efbe36b94cb3ba1c275b7a16d107a
- Live version current: no
- Expected version: 07601180a57efbe36b94cb3ba1c275b7a16d107a
- Actual live version: 17d44157014a550a97369fb1edf66769694dec8e
- Live branch: main
- Changed file count: 62
- High-risk file count: 4
- Approval bundle generated at: 2026-05-29T18:04:16.790Z
- Approval bundle source commit: 07601180a57efbe36b94cb3ba1c275b7a16d107a
- Approval artifact freshness: handoff 2026-05-29T18:04:15.890Z; approval request 2026-05-29T18:04:16.784Z; approval note unknown; high-risk review 2026-05-29T18:04:16.350Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 17d44157014a550a97369fb1edf66769694dec8e, failure version-mismatch)
- Approval bundle command: npm run write:deploy-approval-bundle
- High-risk review command: npm run print:high-risk-deploy-review
- Deploy command: npm run deploy:post-call-fix
- Reason: Deploy local HEAD to Railway so live matches the current code before the real proof-call verification run.

## Approval artifacts
- output/deploy-approval-bundle.json
- output/deploy-approval-request.json
- output/post-call-fix-handoff.json
- output/post-call-fix-approval-note.md
- output/high-risk-deploy-review.json

## Approval steps
- 1. npm run write:deploy-approval-bundle
- 2. npm run print:high-risk-deploy-review
- 3. npm run deploy:post-call-fix

## High-risk files
- deploy.sh: +0 / -0 — Wait for live commit parity after Railway upload, then run the full ship check automatically.
- package.json: +0 / -0 — Adds the live verification, deploy handoff, and real proof-call scripts used to prove the shipped path.
- server.ts: +1 / -1 — Always trigger post-call intelligence after call end so summaries are attempted on production calls.
- src/App.tsx: +0 / -0 — Tightens buyer activation/login flow so payment follows activation request and invite-based access is clearer.

## Current blocker
- stale-production-deploy
- Next action: Generate the approval bundle, get approval, then run npm run deploy:post-call-fix
