# SMIRK deploy approval request

- Branch: main
- Commit: a6d812cba848a3404f5d40ad0fe785d1764d405d
- Live version current: no
- Expected version: a6d812cba848a3404f5d40ad0fe785d1764d405d
- Actual live version: 360fd4d19df363a8ef6d41c9a8a4e776d26a8e77
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T15:22:23.807Z
- Approval bundle source commit: a6d812cba848a3404f5d40ad0fe785d1764d405d
- Approval artifact freshness: handoff 2026-06-07T15:22:07.841Z; approval request 2026-06-07T15:22:23.798Z; approval note unknown; high-risk review 2026-06-07T15:22:23.273Z
- Live health check: 502 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness unknown, branch unknown, version unknown, failure missing-readiness-header)
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
