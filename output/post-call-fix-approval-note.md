# SMIRK deploy approval request

- Branch: main
- Commit: b1cacadf4f46d3e2b9c18c50738467559e93e95d
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: b1cacadf4f46d3e2b9c18c50738467559e93e95d
- Live branch: main
- Changed file count: 5
- High-risk file count: 1
- Approval bundle generated at: 2026-06-07T20:01:56.177Z
- Approval bundle source commit: b1cacadf4f46d3e2b9c18c50738467559e93e95d
- Approval artifact freshness: handoff 2026-06-07T20:01:55.221Z; approval request 2026-06-07T20:01:56.169Z; approval note unknown; high-risk review 2026-06-07T20:01:55.683Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version b1cacadf4f46d3e2b9c18c50738467559e93e95d, failure none)
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
- server.ts: +3 / -0 — Always trigger post-call intelligence after call end so summaries are attempted on production calls.

## Current blocker
- unknown
- Next action: unknown
