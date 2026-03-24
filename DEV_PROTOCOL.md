# DEV PROTOCOL

Single source of truth
- Prod repo: `/Users/cameronchurch/clawdbot/workspaces/smirk-ai-phone-agent`
- Staging repo: _not set yet_
- Prod deploy target: Railway project `ai-phone-agent`, environment `production`
- Staging deploy target: _not set yet_

Default permissions
- Allowed by default: edit code, run tests, inspect logs, commit, deploy, verify endpoints.
- Require confirmation: destructive deletes, schema-destructive migrations, credential rotation, billing logic changes, manual production data edits.

Default command behavior
- Trigger phrase: **"Implement, test, commit, deploy, then verify endpoint."**
- Execution flow:
  1. Inspect current state
  2. Make minimal viable change
  3. Test in available environment
  4. Commit with clean message
  5. Deploy to named target
  6. Verify endpoint/workflow
  7. Report only outcomes

Modes
- Build mode
- Debug mode
- Revenue mode
- Hardening mode

Task format
- Goal
- Done condition
- Constraints
- Deploy target
- Verification target

Truth rules
- Nothing is done until deployed and verified.
- No roadmap claims in status reports.
- No vague status updates.
- Report exact blockers.

Commit rules
- One concern per commit when possible.
- Commit message must say what changed and why.
- No "misc fixes" commits.

Revenue-first priority order
1. Call completion
2. Lead capture
3. Missed-call recovery
4. Booking flow
5. Summaries and alerts
6. Dashboard polish
7. Cosmetic changes

Verification standards
Each shipped task must verify at least one:
- endpoint response
- UI action
- database side effect
- external integration side effect
- customer-visible outcome

Breakpoint reporting format
- changed
- verified
- failed
- risk
- next highest-value fix

SMIRK default verification targets
- `GET /health`
- `GET /api/health`
- `POST /api/prospecting/campaigns/:id/search`
- `POST /api/twilio/incoming` (simulated)
- `POST /api/twilio/process` (simulated)
- `POST /api/twilio/status` (simulated)
- `POST /api/calls/fix-stale`
- `PATCH /api/calls/fix-stale`
