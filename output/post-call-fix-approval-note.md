# SMIRK deploy approval request

- Branch: main
- Commit: a753285db66f3110c2eebd4a50e6c018672c7de2
- Live version current: no
- Expected version: a753285db66f3110c2eebd4a50e6c018672c7de2
- Actual live version: a2d4cad9a4cb4b012354c4fbbd508e4be69a8177
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T14:41:43.776Z
- Approval bundle source commit: a753285db66f3110c2eebd4a50e6c018672c7de2
- Approval artifact freshness: handoff 2026-06-07T14:41:42.807Z; approval request 2026-06-07T14:41:43.768Z; approval note unknown; high-risk review 2026-06-07T14:41:43.285Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version a2d4cad9a4cb4b012354c4fbbd508e4be69a8177, failure version-mismatch)
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
