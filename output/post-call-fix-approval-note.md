# SMIRK deploy approval request

- Branch: main
- Commit: 26d822e21fc9122ce984d92eeda39344c62b2d50
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: 26d822e21fc9122ce984d92eeda39344c62b2d50
- Live branch: main
- Changed file count: 9
- High-risk file count: 1
- Approval bundle generated at: 2026-05-31T14:41:51.894Z
- Approval bundle source commit: 26d822e21fc9122ce984d92eeda39344c62b2d50
- Approval artifact freshness: handoff 2026-05-31T14:41:51.092Z; approval request 2026-05-31T14:41:51.888Z; approval note unknown; high-risk review 2026-05-31T14:41:51.495Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 26d822e21fc9122ce984d92eeda39344c62b2d50, failure none)
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
- package.json: +1 / -0 — Adds the live verification, deploy handoff, and real proof-call scripts used to prove the shipped path.

## Current blocker
- unknown
- Next action: unknown
