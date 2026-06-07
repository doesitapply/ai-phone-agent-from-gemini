# SMIRK deploy approval request

- Branch: main
- Commit: dd5f3151cc25da6818bfabe53ae8a0dd5b6e806c
- Live version current: no
- Expected version: dd5f3151cc25da6818bfabe53ae8a0dd5b6e806c
- Actual live version: 56ecd20fc3537d12184bea665775448dcf6827de
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T16:28:29.906Z
- Approval bundle source commit: dd5f3151cc25da6818bfabe53ae8a0dd5b6e806c
- Approval artifact freshness: handoff 2026-06-07T16:28:29.015Z; approval request 2026-06-07T16:28:29.898Z; approval note unknown; high-risk review 2026-06-07T16:28:29.479Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 56ecd20fc3537d12184bea665775448dcf6827de, failure version-mismatch)
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
