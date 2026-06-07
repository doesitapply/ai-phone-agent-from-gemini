# SMIRK deploy approval request

- Branch: main
- Commit: a806569b6334d50162917eb9bc046299c1874d3a
- Live version current: no
- Expected version: a806569b6334d50162917eb9bc046299c1874d3a
- Actual live version: 9773156d944fe14b5b7e53b7fe0d1e7068710a93
- Live branch: main
- Changed file count: 3
- High-risk file count: 0
- Approval bundle generated at: 2026-06-07T18:11:59.746Z
- Approval bundle source commit: a806569b6334d50162917eb9bc046299c1874d3a
- Approval artifact freshness: handoff 2026-06-07T18:11:58.845Z; approval request 2026-06-07T18:11:59.737Z; approval note unknown; high-risk review 2026-06-07T18:11:59.308Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version 9773156d944fe14b5b7e53b7fe0d1e7068710a93, failure version-mismatch)
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
