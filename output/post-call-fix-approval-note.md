# SMIRK deploy approval request

- Branch: main
- Commit: 2213a100ccddc036c81f8a9a1a96a54f3ebea5f0
- Live version current: no
- Expected version: 2213a100ccddc036c81f8a9a1a96a54f3ebea5f0
- Actual live version: c1a547dc34dc7a10e89bacaf9668e1fe822e1edf
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T17:17:13.161Z
- Approval bundle source commit: 2213a100ccddc036c81f8a9a1a96a54f3ebea5f0
- Approval artifact freshness: handoff 2026-06-07T17:17:12.249Z; approval request 2026-06-07T17:17:13.155Z; approval note unknown; high-risk review 2026-06-07T17:17:12.721Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version c1a547dc34dc7a10e89bacaf9668e1fe822e1edf, failure version-mismatch)
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
