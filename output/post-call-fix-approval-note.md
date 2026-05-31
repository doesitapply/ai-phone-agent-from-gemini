# SMIRK deploy approval request

- Branch: main
- Commit: db0754021c5bdaa90e42e93d84cfe6d07a5e1816
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: db0754021c5bdaa90e42e93d84cfe6d07a5e1816
- Live branch: main
- Changed file count: 7
- High-risk file count: 1
- Approval bundle generated at: 2026-05-31T16:42:03.992Z
- Approval bundle source commit: db0754021c5bdaa90e42e93d84cfe6d07a5e1816
- Approval artifact freshness: handoff 2026-05-31T16:42:03.170Z; approval request 2026-05-31T16:42:03.986Z; approval note unknown; high-risk review 2026-05-31T16:42:03.587Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version db0754021c5bdaa90e42e93d84cfe6d07a5e1816, failure none)
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
- server.ts: +13 / -1 — Always trigger post-call intelligence after call end so summaries are attempted on production calls.

## Current blocker
- unknown
- Next action: unknown
