# SMIRK First Human Run

Purpose: test SMIRK like a real first-time customer, not like the founder.

This is the checkpoint before serious selling:

> Can a normal business owner understand the offer, finish setup, run a test, and trust the result without live rescue?

If the answer is no, the product is still pre-MVP.

---

## Rules for the run

- Use a fresh browser session or incognito window.
- Pretend you do not know where anything is.
- Do not use admin shortcuts unless the customer would have them.
- If you feel confused, stop and write it down.
- If you have to explain the product to yourself, the product is unclear.
- Screen record the entire run.

---

## Success definition

A slightly tired local business owner should be able to:

1. understand the offer in under 15 seconds
2. start signup without confusion
3. get into the dashboard
4. know what to configure next
5. trigger a test call
6. receive a useful result
7. see proof in the dashboard
8. know the next step without asking for help

---

## Test setup

Fill these before the run:

- Public app URL: ____________________
- Test business name: ____________________
- Test owner email: ____________________
- Test business phone: ____________________
- Workspace ID used: ____________________
- Test date/time: ____________________
- Screen recording file: ____________________

### Required preflight for the first real proof call

Before any production deploy, Stripe smoke, cleanup apply, proof call, or outreach, print the guarded first-dollar approval packet:

- `npm run -s print:first-dollar-approval-packet`

If the packet shows `Approval 0: Branch Reconciliation`, stop there and print the dedicated branch handoff:

- `npm run -s print:branch-reconcile-approval`

The only approval to request is `APPROVE_SMIRK_BRANCH_RECONCILE`, and that approval authorizes only the branch reconciliation command printed in the dedicated packet. It does not authorize deploy, Stripe smoke, cleanup apply, proof call, secret access, paid spend, or outreach.

After branch reconciliation, regenerate the packet and rerun deploy readiness before requesting any production deploy approval:

- `npm run write:deploy-approval-bundle`
- `npm run -s check:deploy-post-call-fix-ready`

Before starting the run, use the guarded readiness path to choose a safe proof-call target:

- `npm run check:real-call-readiness`
- `npm run print:real-call-setup`
- Choose one safe number privately from `allowlistedTargetHints` if the readiness check reports them. The hints are masked on purpose.
- `npm run check:real-call-readiness -- <safe-number>`
- `npm run proof:real-call -- <safe-number>`
- The guarded proof runner re-runs `check:post-deploy-live` and stops before dialing unless the deployed app passes the post-deploy live audit.
- If recovering a manual/interrupted run, set `PROOF_STARTED_AT` to the proof-call start timestamp and `PROOF_CALL_SID` to the call SID returned by the placed proof call.
- `npm run check:proof-artifacts-live -- "$PROOF_STARTED_AT"`
- `npm run check:post-call-intelligence-live -- "$PROOF_STARTED_AT"`
- `npm run check:dashboard-proof-live`

Do not mutate the live proof-call allowlist or place a call to a non-approved target without explicit approval.

Pass preflight only if:
- readiness check reports a masked target and passes for the full safe number
- the call command returns a Twilio call SID
- proof-artifact check shows a call, summary, owner email event, and callback task pinned to the placed `PROOF_CALL_SID`
- post-call intelligence check passes against current production for the placed `PROOF_CALL_SID`
- dashboard proof counters increase for `totalCalls`, `summariesGenerated`, `callbackTasksCreated`, `ownerEmailAlertsSent`, and `completeProofCalls`

---

## Human test flow

### 1) Open landing page
Check:
- Can I tell what SMIRK does in one glance?
- Does it clearly say missed-call recovery?
- Does anything still imply customer texting?
- Is the primary CTA obvious?

Pass if:
- value is understandable fast
- CTA feels safe and clear

Log confusion:
- ______________________________________

### 2) Start signup / payment path
Check:
- Can I choose a plan without wondering what the difference is?
- If I click buy/get started, do I know what happens next?
- Does the flow feel real, not half-finished?

Pass if:
- plan choice is understandable
- next step is obvious

Log confusion:
- ______________________________________

### 3) Account / workspace access
Check:
- Can I create or receive access without founder help?
- Do I know what the workspace ID/API key is for?
- If I land on login, do I know what to enter?

Pass if:
- access path is self-explanatory
- no hidden founder knowledge required

Log confusion:
- ______________________________________

### 4) First dashboard impression
Check:
- When the dashboard opens, do I know where I am?
- Is the product obviously about missed-call recovery?
- Are there any scary/operator-only controls visible?
- Do I know what I should do first?

Pass if:
- dashboard feels customer-safe
- first action is obvious

Log confusion:
- ______________________________________

### 5) Settings / setup
Check:
- Can I tell what must be configured before testing?
- Is the phone/webhook/setup language understandable?
- Are important fields explained in human language?
- Does anything feel like “technical debris”?

Pass if:
- required setup is understandable
- no hidden assumptions block progress

Log confusion:
- ______________________________________

### 6) Trigger a test call
Check:
- Can I figure out how to run the test?
- Do I know what number to call and why?
- Does the system confirm that the test is happening?
- If it takes time, do I get reassurance instead of silence?

Pass if:
- test action is obvious
- system feedback is clear

Log confusion:
- ______________________________________

### 7) Receive result
Check:
- Do I get a clear summary of what happened?
- Is the owner email understandable and useful?
- Is a callback task created?
- Does the result feel trustworthy?

Pass if:
- output is clear and actionable
- result matches the promise

Log confusion:
- ______________________________________

### 8) Proof in dashboard
Check:
- Can I find proof of the test without hunting?
- Do I see the lead, summary, and callback task?
- Is it obvious that SMIRK did useful work?

Pass if:
- proof is visible quickly
- business owner can connect cause to result

Log confusion:
- ______________________________________

### 9) What next?
Check:
- After the test, do I know what to do next?
- Does the product explain the next operational step?
- Would I trust this enough to use it on real calls?

Pass if:
- next step is obvious
- trust increased instead of decreased

Log confusion:
- ______________________________________

---

## Friction log

Record every moment that creates uncertainty.

| Step | What confused me? | Severity (low/med/high) | Fix guess |
|---|---|---|---|
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |

---

## Hard fail conditions

If any of these happen, stop and fix before outreach:

- I cannot explain the offer in one sentence
- I do not know how to start
- I need founder knowledge to log in
- I see operator/admin controls I should not see
- I cannot tell how to trigger a test
- the test result is missing, delayed without explanation, or unclear
- email/task/dashboard proof do not line up
- I finish the run still unsure what the product actually did

---

## Final verdict

- Could a normal human finish this without tech support? yes / no
- Biggest confusion point: ____________________
- Biggest trust gap: ____________________
- Biggest wording problem: ____________________
- Biggest UX fix needed before selling: ____________________

If the answer is “no,” the next work should prioritize confusion removal over new features.
