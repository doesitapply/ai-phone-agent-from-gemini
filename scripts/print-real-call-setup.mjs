#!/usr/bin/env node
console.log(`SMIRK real-call setup

Current gate: prove one fresh live call creates the promised outcome.

Public buyer path is expected to be https://smirkcalls.com. Before placing a
call, make sure the target is a safe number you control or have permission to
call.

1. Choose the safe proof-call target number. Either pass it directly:
   npm run check:real-call-readiness -- +15551234567
   npm run call:real-test -- +15551234567

   Or set one of these local env vars:
   TEST_CALL_TO=+15551234567
   # or
   TWILIO_TEST_TO=+15551234567
   # or
   ALLOWLIST_TEST_NUMBER=+15551234567

2. Make sure production will allow that number.
   If the readiness check says targetAllowlisted=false, add the same number to
   production COMPLIANCE_ALWAYS_ALLOW_NUMBERS:
   COMPLIANCE_ALWAYS_ALLOW_NUMBERS=+15551234567

3. Verify readiness:
   npm run -s check:real-call-readiness -- +15551234567

4. Place the live production proof call:
   npm run -s call:real-test -- +15551234567

5. Verify proof artifacts:
   npm run -s check:proof-loop-live
   npm run -s check:proof-artifacts-live
   npm run -s check:post-call-intelligence-live
`);
