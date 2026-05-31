# SMIRK deploy approval request

- Branch: main
- Commit: 4e70c751fbc516a7ec318f4913ec18de0c9c1af1
- Live version current: no
- Expected version: 4e70c751fbc516a7ec318f4913ec18de0c9c1af1
- Actual live version: b9a51fb7fe8204f516b6267291af7666aa8b0504
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-05-31T22:12:38.100Z
- Approval bundle source commit: 4e70c751fbc516a7ec318f4913ec18de0c9c1af1
- Approval artifact freshness: handoff 2026-05-31T22:12:37.285Z; approval request 2026-05-31T22:12:38.095Z; approval note unknown; high-risk review 2026-05-31T22:12:37.707Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version b9a51fb7fe8204f516b6267291af7666aa8b0504, failure version-mismatch)
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
