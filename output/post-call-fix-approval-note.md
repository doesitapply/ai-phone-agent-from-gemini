# SMIRK deploy approval request

- Branch: main
- Commit: 057a668adb55b4275e52763004bff0f009bfb3ed
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: 057a668adb55b4275e52763004bff0f009bfb3ed
- Live branch: main
- Changed file count: 15
- High-risk file count: 1
- Approval bundle generated at: 2026-05-31T11:42:02.572Z
- Approval bundle source commit: 057a668adb55b4275e52763004bff0f009bfb3ed
- Approval artifact freshness: handoff 2026-05-31T11:42:01.728Z; approval request 2026-05-31T11:42:02.566Z; approval note unknown; high-risk review 2026-05-31T11:42:02.170Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 057a668adb55b4275e52763004bff0f009bfb3ed, failure none)
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
- src/App.tsx: +22 / -9 — Hides Mission Control and advanced operational screens from customer workspace sessions.

## Current blocker
- unknown
- Next action: unknown
