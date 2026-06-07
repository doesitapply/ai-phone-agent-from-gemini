# SMIRK deploy approval request

- Branch: main
- Commit: ea7b3d974b0c4916a74eb63bc37242e77fd1835c
- Live version current: no
- Expected version: pending-local-commit
- Actual live version: ea7b3d974b0c4916a74eb63bc37242e77fd1835c
- Live branch: main
- Changed file count: 12
- High-risk file count: 2
- Approval bundle generated at: 2026-06-07T19:58:50.859Z
- Approval bundle source commit: ea7b3d974b0c4916a74eb63bc37242e77fd1835c
- Approval artifact freshness: handoff 2026-06-07T19:58:49.893Z; approval request 2026-06-07T19:58:50.853Z; approval note unknown; high-risk review 2026-06-07T19:58:50.377Z
- Live health check: 200 @ https://ai-phone-agent-production-6811.up.railway.app/health (readiness 1, branch main, version ea7b3d974b0c4916a74eb63bc37242e77fd1835c, failure none)
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
- package.json: +2 / -0 — Adds the live verification, deploy handoff, and real proof-call scripts used to prove the shipped path.
- server.ts: +289 / -13 — Always trigger post-call intelligence after call end so summaries are attempted on production calls.

## Current blocker
- unknown
- Next action: unknown
