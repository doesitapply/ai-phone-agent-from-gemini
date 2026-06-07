# SMIRK deploy approval request

- Branch: main
- Commit: 3b065daec9473738a3b6c38c9c854df227f687f4
- Live version current: no
- Expected version: 3b065daec9473738a3b6c38c9c854df227f687f4
- Actual live version: faada0c3b146dbe755cb71402498651f34457431
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T17:56:13.233Z
- Approval bundle source commit: 3b065daec9473738a3b6c38c9c854df227f687f4
- Approval artifact freshness: handoff 2026-06-07T17:56:12.335Z; approval request 2026-06-07T17:56:13.226Z; approval note unknown; high-risk review 2026-06-07T17:56:12.796Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version faada0c3b146dbe755cb71402498651f34457431, failure version-mismatch)
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
