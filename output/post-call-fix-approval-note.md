# SMIRK deploy approval request

- Branch: main
- Commit: 4ce2aea1462da852d95be070d1ced8cb1d24a2de
- Live version current: no
- Expected version: 4ce2aea1462da852d95be070d1ced8cb1d24a2de
- Actual live version: 6f7fd61508021b99b0f4458285caa9be97d178d1
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-05-31T22:40:23.352Z
- Approval bundle source commit: 4ce2aea1462da852d95be070d1ced8cb1d24a2de
- Approval artifact freshness: handoff 2026-05-31T22:40:22.527Z; approval request 2026-05-31T22:40:23.345Z; approval note unknown; high-risk review 2026-05-31T22:40:22.945Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 6f7fd61508021b99b0f4458285caa9be97d178d1, failure version-mismatch)
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
