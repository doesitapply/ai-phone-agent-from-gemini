# SMIRK deploy approval request

- Branch: main
- Commit: f3a447a4975a8774b63ffb1b09122737a9189e13
- Live version current: no
- Expected version: f3a447a4975a8774b63ffb1b09122737a9189e13
- Actual live version: c4eb3266be1e25dc7cde16aceed6844603d71053
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-05-31T23:40:11.838Z
- Approval bundle source commit: f3a447a4975a8774b63ffb1b09122737a9189e13
- Approval artifact freshness: handoff 2026-05-31T23:40:10.999Z; approval request 2026-05-31T23:40:11.832Z; approval note unknown; high-risk review 2026-05-31T23:40:11.445Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version c4eb3266be1e25dc7cde16aceed6844603d71053, failure version-mismatch)
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
