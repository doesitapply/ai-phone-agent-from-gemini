# SMIRK deploy approval request

- Branch: main
- Commit: 853361f1d1f31784d6ca4aaf389e6db77d8a7799
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: 853361f1d1f31784d6ca4aaf389e6db77d8a7799
- Live branch: main
- Changed file count: 6
- High-risk file count: 0
- Approval bundle generated at: 2026-05-31T15:40:58.916Z
- Approval bundle source commit: 853361f1d1f31784d6ca4aaf389e6db77d8a7799
- Approval artifact freshness: handoff 2026-05-31T15:40:58.099Z; approval request 2026-05-31T15:40:58.910Z; approval note unknown; high-risk review 2026-05-31T15:40:58.513Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 853361f1d1f31784d6ca4aaf389e6db77d8a7799, failure none)
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
- unknown
- Next action: unknown
