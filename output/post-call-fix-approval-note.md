# SMIRK deploy approval request

- Branch: main
- Commit: 17b8da2c37e6e814f202780e938ada2cd6fa4d16
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: 17b8da2c37e6e814f202780e938ada2cd6fa4d16
- Live branch: main
- Changed file count: 7
- High-risk file count: 1
- Approval bundle generated at: 2026-05-31T14:12:06.587Z
- Approval bundle source commit: 17b8da2c37e6e814f202780e938ada2cd6fa4d16
- Approval artifact freshness: handoff 2026-05-31T14:12:05.757Z; approval request 2026-05-31T14:12:06.581Z; approval note unknown; high-risk review 2026-05-31T14:12:06.190Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 17b8da2c37e6e814f202780e938ada2cd6fa4d16, failure none)
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
- server.ts: +5 / -0 — Always trigger post-call intelligence after call end so summaries are attempted on production calls.

## Current blocker
- unknown
- Next action: unknown
