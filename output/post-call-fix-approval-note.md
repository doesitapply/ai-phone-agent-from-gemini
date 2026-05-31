# SMIRK deploy approval request

- Branch: main
- Commit: 179f529ca5d409f37862c12f65d09a865c3ac074
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: 179f529ca5d409f37862c12f65d09a865c3ac074
- Live branch: main
- Changed file count: 4
- High-risk file count: 0
- Approval bundle generated at: 2026-05-31T17:40:19.359Z
- Approval bundle source commit: 179f529ca5d409f37862c12f65d09a865c3ac074
- Approval artifact freshness: handoff 2026-05-31T17:40:18.553Z; approval request 2026-05-31T17:40:19.352Z; approval note unknown; high-risk review 2026-05-31T17:40:18.970Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 179f529ca5d409f37862c12f65d09a865c3ac074, failure none)
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
- none reported

## Current blocker
- unknown
- Next action: unknown
