# SMIRK deploy approval request

- Branch: main
- Commit: 6877302fb894418e71f92b246cc3971964c3bdb6
- Live version current: no
- Expected version: 6877302fb894418e71f92b246cc3971964c3bdb6
- Actual live version: dev
- Live branch: unknown
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-05-31T12:12:36.044Z
- Approval bundle source commit: 6877302fb894418e71f92b246cc3971964c3bdb6
- Approval artifact freshness: handoff 2026-05-31T12:12:35.230Z; approval request 2026-05-31T12:12:36.038Z; approval note unknown; high-risk review 2026-05-31T12:12:35.647Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch unknown, version dev, failure branch-mismatch)
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
