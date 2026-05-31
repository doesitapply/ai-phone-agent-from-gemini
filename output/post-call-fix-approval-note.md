# SMIRK deploy approval request

- Branch: main
- Commit: 3830c7ccdcf36efbc8db77b84b120d53113a1af2
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: 3830c7ccdcf36efbc8db77b84b120d53113a1af2
- Live branch: main
- Changed file count: 6
- High-risk file count: 0
- Approval bundle generated at: 2026-05-31T12:11:14.938Z
- Approval bundle source commit: 3830c7ccdcf36efbc8db77b84b120d53113a1af2
- Approval artifact freshness: handoff 2026-05-31T12:11:14.126Z; approval request 2026-05-31T12:11:14.931Z; approval note unknown; high-risk review 2026-05-31T12:11:14.537Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 3830c7ccdcf36efbc8db77b84b120d53113a1af2, failure none)
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
