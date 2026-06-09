#!/usr/bin/env node
console.log(`SMIRK real-call setup

Current gate: prove one fresh live call creates the promised outcome.

Public buyer path is expected to be https://smirkcalls.com. Before placing a
call, make sure the target is a safe number you control or have permission to
call.

1. Run the no-target readiness check:
   npm run check:real-call-readiness

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

   If the guarded flow is interrupted after the call starts, use the same
   target and capture/reuse the fresh-proof start timestamp:
   export PROOF_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

5. Verify fresh proof artifacts and dashboard proof:
   npm run -s check:proof-loop-live
   npm run -s check:proof-artifacts-live -- "$PROOF_STARTED_AT"
   npm run -s check:post-call-intelligence-live -- "$PROOF_STARTED_AT"
   npm run -s check:dashboard-proof-live

   The guarded proof-call flow fails unless the dashboard counters for
   totalCalls, summariesGenerated, callbackTasksCreated, ownerEmailAlertsSent,
   and completeProofCalls all increase after the fresh call. A green artifact
   check alone is not enough for Gate 4.
`);
