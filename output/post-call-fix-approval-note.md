# SMIRK deploy approval request

- Branch: main
- Commit: a4118d5a2b1b746e1bcd35f2b0f83ead26381fc6
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: a4118d5a2b1b746e1bcd35f2b0f83ead26381fc6
- Live branch: main
- Changed file count: 6
- High-risk file count: 1
- Approval bundle generated at: 2026-05-31T19:40:23.379Z
- Approval bundle source commit: a4118d5a2b1b746e1bcd35f2b0f83ead26381fc6
- Approval artifact freshness: handoff 2026-05-31T19:40:22.538Z; approval request 2026-05-31T19:40:23.372Z; approval note unknown; high-risk review 2026-05-31T19:40:22.953Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version a4118d5a2b1b746e1bcd35f2b0f83ead26381fc6, failure none)
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
- package.json: +2 / -1 — Adds the live verification, deploy handoff, and real proof-call scripts used to prove the shipped path.

## Current blocker
- unknown
- Next action: unknown
