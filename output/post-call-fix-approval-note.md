# SMIRK deploy approval request

- Branch: main
- Commit: d9b8abcb34d8c6ae2e73e68ea28fcb8868910129
- Live version current: no
- Expected version: d9b8abcb34d8c6ae2e73e68ea28fcb8868910129
- Actual live version: 225f9f4cd1df633a1679bbaba67666fb69698d3c
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-01T00:41:33.967Z
- Approval bundle source commit: d9b8abcb34d8c6ae2e73e68ea28fcb8868910129
- Approval artifact freshness: handoff 2026-06-01T00:41:33.162Z; approval request 2026-06-01T00:41:33.961Z; approval note unknown; high-risk review 2026-06-01T00:41:33.573Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 225f9f4cd1df633a1679bbaba67666fb69698d3c, failure version-mismatch)
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
