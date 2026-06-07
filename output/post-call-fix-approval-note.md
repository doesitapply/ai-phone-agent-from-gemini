# SMIRK deploy approval request

- Branch: main
- Commit: 1f057d641432ae444b04c277c03723aa7f20c06c
- Live version current: no
- Expected version: 1f057d641432ae444b04c277c03723aa7f20c06c
- Actual live version: facb7daa50521343118a4f51693a4dffa362bdf9
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T16:38:30.914Z
- Approval bundle source commit: 1f057d641432ae444b04c277c03723aa7f20c06c
- Approval artifact freshness: handoff 2026-06-07T16:38:29.997Z; approval request 2026-06-07T16:38:30.906Z; approval note unknown; high-risk review 2026-06-07T16:38:30.464Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version facb7daa50521343118a4f51693a4dffa362bdf9, failure version-mismatch)
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
