# SMIRK deploy approval request

- Branch: main
- Commit: 6f1cb9bfb588a4c1aef6cdb59a48ccee2c141ea3
- Live version current: no
- Expected version: 6f1cb9bfb588a4c1aef6cdb59a48ccee2c141ea3
- Actual live version: f8dd2d62ae8bd82a88c8c8e620c97836053dc317
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T15:31:25.036Z
- Approval bundle source commit: 6f1cb9bfb588a4c1aef6cdb59a48ccee2c141ea3
- Approval artifact freshness: handoff 2026-06-07T15:31:24.142Z; approval request 2026-06-07T15:31:25.028Z; approval note unknown; high-risk review 2026-06-07T15:31:24.608Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version f8dd2d62ae8bd82a88c8c8e620c97836053dc317, failure version-mismatch)
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
