# SMIRK deploy approval request

- Branch: main
- Commit: 75b6f1f2edd024a50aa5e1df73ccd9ef1f315e7f
- Live version current: no
- Expected version: 75b6f1f2edd024a50aa5e1df73ccd9ef1f315e7f
- Actual live version: 83804058a0eab79a4419e38a7c03695ff669e9ca
- Live branch: main
- Changed file count: 4
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T11:21:24.937Z
- Approval bundle source commit: 75b6f1f2edd024a50aa5e1df73ccd9ef1f315e7f
- Approval artifact freshness: handoff 2026-06-07T11:21:24.038Z; approval request 2026-06-07T11:21:24.931Z; approval note unknown; high-risk review 2026-06-07T11:21:24.496Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 83804058a0eab79a4419e38a7c03695ff669e9ca, failure version-mismatch)
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
