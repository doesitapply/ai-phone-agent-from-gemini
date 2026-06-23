#!/usr/bin/env node
console.log(`SMIRK real-call setup

Current gate: prove one fresh live call creates the promised outcome.

Public buyer path is expected to be https://smirkcalls.com. Before placing a
call, make sure the target is a safe number you control or have permission to
call.

1. Run the no-target readiness check:
   npm run check:real-call-readiness

   If readiness reports liveVersionFailure: "pending-local-deploy-work", stop.
   The proof runner will not place a real call until the current local proof
   hardening is deployed, live version parity passes, and the worktree is clean
   for deploy-relevant files. Do not bypass this by calling lower-level Twilio
   helpers directly.

2. Choose the safe proof-call target number from the masked
   allowlistedTargetHints. Keep the full number private and pass it explicitly:
   npm run check:real-call-readiness -- <safe-number>
   npm run proof:real-call -- <safe-number>

   If no safe target is allowlisted, stop and get explicit approval before any
   allowlist change. Do not use placeholder numbers, env-first target setup, or
   direct production allowlist mutation as the normal proof path.

3. Verify readiness:
   npm run -s check:real-call-readiness -- <safe-number>

4. Run the guarded proof-call flow:
   npm run -s proof:real-call -- <safe-number>

   The guarded flow re-runs check:post-deploy-live and stops before dialing
   unless the deployed app passes the post-deploy live audit.

   If the guarded flow is interrupted after the call starts, use the same
   target and capture/reuse the fresh-proof start timestamp plus the placed
   proof-call SID:
   export PROOF_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
   export PROOF_CALL_SID="<call-sid-from-the-placed-proof-call>"

5. Verify fresh proof artifacts and dashboard proof:
   npm run -s check:proof-loop-live
   PROOF_CALL_SID="$PROOF_CALL_SID" npm run -s check:proof-artifacts-live -- "$PROOF_STARTED_AT"
   PROOF_CALL_SID="$PROOF_CALL_SID" npm run -s check:post-call-intelligence-live -- "$PROOF_STARTED_AT"
   npm run -s check:dashboard-proof-live

   The guarded proof-call flow fails unless the dashboard counters for
   totalCalls, summariesGenerated, callbackTasksCreated, ownerEmailAlertsSent,
   and completeProofCalls all increase after the fresh call. For manual
   recovery, the artifact checks must be pinned to PROOF_CALL_SID; a green
   timestamp-only artifact check alone is not enough for Gate 4.
`);
