# SMIRK deploy approval request

- Branch: main
- Commit: 2a72b80a110c1880e4b7540f4cacf33a7b48b3a6
- Live version current: no
- Expected version: 2a72b80a110c1880e4b7540f4cacf33a7b48b3a6
- Actual live version: fa6aaac1dda027ed581cabafc7d79a4365c7ec5e
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-05-31T13:11:09.876Z
- Approval bundle source commit: 2a72b80a110c1880e4b7540f4cacf33a7b48b3a6
- Approval artifact freshness: handoff 2026-05-31T13:11:09.052Z; approval request 2026-05-31T13:11:09.869Z; approval note unknown; high-risk review 2026-05-31T13:11:09.473Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version fa6aaac1dda027ed581cabafc7d79a4365c7ec5e, failure version-mismatch)
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
