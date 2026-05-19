#!/usr/bin/env node
console.log(`SMIRK real-call setup

1. Set a safe real phone number in one of these local env vars:
   TEST_CALL_TO=+15551234567
   # or
   TWILIO_TEST_TO=+15551234567
   # or
   ALLOWLIST_TEST_NUMBER=+15551234567

2. Make sure production will allow that number:
   COMPLIANCE_ALWAYS_ALLOW_NUMBERS=+15551234567
   # if production already has an allowlist, add the same number there

3. Verify readiness:
   npm run check:real-call-readiness
   # or pass a number directly:
   npm run check:real-call-readiness -- +15551234567

4. Place the live production proof call:
   npm run call:real-test
   # or pass a number directly:
   npm run call:real-test -- +15551234567

5. Verify proof artifacts:
   npm run check:proof-artifacts-live
   npm run check:post-call-intelligence-live
`);
