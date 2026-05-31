# SMIRK deploy approval request

- Branch: main
- Commit: 6969e11cd91e5cc7fabf1cd313bb6b4b54a4061b
- Live version current: no
- Expected version: 6969e11cd91e5cc7fabf1cd313bb6b4b54a4061b
- Actual live version: 486cacd8e118c5d0f6dac960d14806ebf171d2fa
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-05-31T13:41:10.120Z
- Approval bundle source commit: 6969e11cd91e5cc7fabf1cd313bb6b4b54a4061b
- Approval artifact freshness: handoff 2026-05-31T13:41:09.301Z; approval request 2026-05-31T13:41:10.114Z; approval note unknown; high-risk review 2026-05-31T13:41:09.730Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 486cacd8e118c5d0f6dac960d14806ebf171d2fa, failure version-mismatch)
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
