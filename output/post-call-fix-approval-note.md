# SMIRK deploy approval request

- Branch: main
- Commit: 59037bc31eed27b51d52fccb50edc7982dccc88d
- Live version current: no
- Expected version: 59037bc31eed27b51d52fccb50edc7982dccc88d
- Actual live version: 9a8bd9d5333f4984fc0540f1a7ec619532ac39f4
- Live branch: main
- Changed file count: 4
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T16:19:19.426Z
- Approval bundle source commit: 59037bc31eed27b51d52fccb50edc7982dccc88d
- Approval artifact freshness: handoff 2026-06-07T16:19:18.446Z; approval request 2026-06-07T16:19:19.418Z; approval note unknown; high-risk review 2026-06-07T16:19:18.935Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 9a8bd9d5333f4984fc0540f1a7ec619532ac39f4, failure version-mismatch)
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
