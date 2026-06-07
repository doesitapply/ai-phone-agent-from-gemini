# SMIRK deploy approval request

- Branch: main
- Commit: 872dbb473a946169f7618c8d440e65c3c37b5a02
- Live version current: no
- Expected version: 872dbb473a946169f7618c8d440e65c3c37b5a02
- Actual live version: 17527d54a2ca0787fe6da3125190d212c846613c
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T16:47:08.508Z
- Approval bundle source commit: 872dbb473a946169f7618c8d440e65c3c37b5a02
- Approval artifact freshness: handoff 2026-06-07T16:47:07.651Z; approval request 2026-06-07T16:47:08.501Z; approval note unknown; high-risk review 2026-06-07T16:47:08.087Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 17527d54a2ca0787fe6da3125190d212c846613c, failure version-mismatch)
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
