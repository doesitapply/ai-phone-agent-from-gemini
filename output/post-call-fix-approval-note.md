# SMIRK deploy approval request

- Branch: main
- Commit: b2ee1c98dc4138dde9be3937bf26ff5a1b5c3e19
- Live version current: no
- Expected version: b2ee1c98dc4138dde9be3937bf26ff5a1b5c3e19
- Actual live version: 04faeebd913c438ecc0368436c8535ef79bdba12
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T17:08:40.237Z
- Approval bundle source commit: b2ee1c98dc4138dde9be3937bf26ff5a1b5c3e19
- Approval artifact freshness: handoff 2026-06-07T17:08:39.281Z; approval request 2026-06-07T17:08:40.230Z; approval note unknown; high-risk review 2026-06-07T17:08:39.765Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 04faeebd913c438ecc0368436c8535ef79bdba12, failure version-mismatch)
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
