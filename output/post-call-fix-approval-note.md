# SMIRK deploy approval request

- Branch: main
- Commit: c19c4feae6d55ab4a6094a19cdb789fa22a80be8
- Live version current: no
- Expected version: c19c4feae6d55ab4a6094a19cdb789fa22a80be8
- Actual live version: eb241f3dd5d29c516b616a8dc4dbc68094da33c6
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T15:06:38.214Z
- Approval bundle source commit: c19c4feae6d55ab4a6094a19cdb789fa22a80be8
- Approval artifact freshness: handoff 2026-06-07T15:06:37.343Z; approval request 2026-06-07T15:06:38.207Z; approval note unknown; high-risk review 2026-06-07T15:06:37.792Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version eb241f3dd5d29c516b616a8dc4dbc68094da33c6, failure version-mismatch)
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
