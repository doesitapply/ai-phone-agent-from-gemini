# SMIRK deploy approval request

- Branch: main
- Commit: 24315ee7ba2c70a99f820e92867e7648009822d8
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: 24315ee7ba2c70a99f820e92867e7648009822d8
- Live branch: main
- Changed file count: 15
- High-risk file count: 3
- Approval bundle generated at: 2026-06-07T20:25:30.102Z
- Approval bundle source commit: 24315ee7ba2c70a99f820e92867e7648009822d8
- Approval artifact freshness: handoff 2026-06-07T20:25:29.160Z; approval request 2026-06-07T20:25:30.095Z; approval note unknown; high-risk review 2026-06-07T20:25:29.630Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 24315ee7ba2c70a99f820e92867e7648009822d8, failure none)
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
- package.json: +1 / -0 — Adds the live verification, deploy handoff, and real proof-call scripts used to prove the shipped path.
- server.ts: +13 / -4 — Always trigger post-call intelligence after call end so summaries are attempted on production calls.
- src/App.tsx: +44 / -6 — Hides Mission Control and advanced operational screens from customer workspace sessions.

## Current blocker
- unknown
- Next action: unknown
