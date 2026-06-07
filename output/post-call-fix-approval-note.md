# SMIRK deploy approval request

- Branch: main
- Commit: 521fc511294603c51930d9f39e7599ab030b47d1
- Live version current: no
- Expected version: 521fc511294603c51930d9f39e7599ab030b47d1
- Actual live version: 4537b994541b770aa5106ad4fe624f4a895f11b8
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T17:35:55.135Z
- Approval bundle source commit: 521fc511294603c51930d9f39e7599ab030b47d1
- Approval artifact freshness: handoff 2026-06-07T17:35:54.232Z; approval request 2026-06-07T17:35:55.129Z; approval note unknown; high-risk review 2026-06-07T17:35:54.685Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 4537b994541b770aa5106ad4fe624f4a895f11b8, failure version-mismatch)
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
- stale-production-deploy
- Next action: Generate the approval bundle, get approval, then run npm run deploy:post-call-fix
