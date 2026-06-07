# SMIRK deploy approval request

- Branch: main
- Commit: b6342bca83dc68dd62195280a71f4451fb4a1ddd
- Live version current: no
- Expected version: b6342bca83dc68dd62195280a71f4451fb4a1ddd
- Actual live version: dec424a8332d58af8269ec938094970e687b828a
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T15:27:49.909Z
- Approval bundle source commit: b6342bca83dc68dd62195280a71f4451fb4a1ddd
- Approval artifact freshness: handoff 2026-06-07T15:27:49.004Z; approval request 2026-06-07T15:27:49.903Z; approval note unknown; high-risk review 2026-06-07T15:27:49.469Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version dec424a8332d58af8269ec938094970e687b828a, failure version-mismatch)
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
