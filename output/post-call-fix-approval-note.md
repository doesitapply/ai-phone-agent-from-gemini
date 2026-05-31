# SMIRK deploy approval request

- Branch: main
- Commit: a713a7f713730a31e1fbd6c72742cbb6ef568880
- Live version current: no
- Expected version: a713a7f713730a31e1fbd6c72742cbb6ef568880
- Actual live version: 9dbc6f7d06a0f284fc0cb116d8cb24f0cf31baed
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-05-31T23:10:16.023Z
- Approval bundle source commit: a713a7f713730a31e1fbd6c72742cbb6ef568880
- Approval artifact freshness: handoff 2026-05-31T23:10:15.216Z; approval request 2026-05-31T23:10:16.015Z; approval note unknown; high-risk review 2026-05-31T23:10:15.629Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 9dbc6f7d06a0f284fc0cb116d8cb24f0cf31baed, failure version-mismatch)
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
