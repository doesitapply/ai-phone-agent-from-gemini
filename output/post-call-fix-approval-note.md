# SMIRK deploy approval request

- Branch: main
- Commit: 12094d450a6c24689d5eafcb17ca3b2c92332da4
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: 12094d450a6c24689d5eafcb17ca3b2c92332da4
- Live branch: main
- Changed file count: 11
- High-risk file count: 2
- Approval bundle generated at: 2026-05-31T15:13:03.823Z
- Approval bundle source commit: 12094d450a6c24689d5eafcb17ca3b2c92332da4
- Approval artifact freshness: handoff 2026-05-31T15:13:02.996Z; approval request 2026-05-31T15:13:03.817Z; approval note unknown; high-risk review 2026-05-31T15:13:03.411Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 12094d450a6c24689d5eafcb17ca3b2c92332da4, failure none)
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
- server.ts: +18 / -19 — Always trigger post-call intelligence after call end so summaries are attempted on production calls.
- src/App.tsx: +1 / -1 — Hides Mission Control and advanced operational screens from customer workspace sessions.

## Current blocker
- unknown
- Next action: unknown
