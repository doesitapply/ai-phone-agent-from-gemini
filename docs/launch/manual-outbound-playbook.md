# SMIRK Manual Outbound Playbook

This playbook supports the 30-day market validation sprint with this hard rule: No cold SMS, no automated phone spam, no purchased-list blasting, and no unsupported claims.

## Goal

Run 200 researched manual touches to home-service owner/operators and stop only when one hard goal is hit:

- 1 paid Starter or Pro activation.
- 10 qualified owner/operator conversations.
- 3 booked proof walkthroughs.
- Negative signal: 500 touches plus $500 spend produce 0 qualified replies, or self-serve activation fails and blocks scale.

## Target Segments

Start with 2-3 regions and no more than 6 verticals at once.

Current researched seed regions:

- Reno/Sparks/Northern Nevada: `docs/launch/prospect-batch-001-reno.csv`.
- Sacramento/Greater Sacramento: `docs/launch/prospect-batch-002-sacramento.csv`.
- Boise/Treasure Valley: `docs/launch/prospect-batch-003-boise.csv`.
- Reno/Sparks/Northern Nevada expansion: `docs/launch/prospect-batch-004-reno-expansion.csv`.

Priority verticals:

- Plumbing
- HVAC
- Roofing
- Electrical
- Handyman/remodeling
- Auto repair

Secondary verticals:

- Landscaping
- Pest control
- Garage door repair
- Cleaning services

## Research Rules

Each prospect must have:

- Company name.
- Vertical.
- Region.
- Website or public business profile.
- Owner/operator or general business contact path.
- Evidence that phone demand matters: emergency work, appointment requests, service area, after-hours language, or missed-call risk.

Do not use purchased lists. Do not scrape personal mobile numbers. Do not add anyone to SMS.

## Approved Touches

- Website contact form.
- Public business email.
- LinkedIn message.
- Human-approved phone call.
- Warm referral intro.

Not approved:

- Cold SMS.
- Automated dialing.
- Voicemail drops.
- Purchased-list blasting.
- Misrepresenting SMIRK as a local service provider.

## Ledger Rules

Log every researched company in `/dashboard/launch` or `docs/launch/traction-ledger-template.csv`.

Use the `/dashboard/launch` manual touch workbench to open the public source/contact page, copy the current message draft, and log the touch only after a human sends an email, submits the website form, sends a LinkedIn message, or places a human-approved call. The workbench is deliberately copy/open/log only; it does not send outreach for you.

Required fields:

- source
- company
- vertical
- region
- owner_contact
- channel
- message_variant
- response
- objection
- proof_walkthrough_status
- checkout_status
- activation_status
- next_state

Use these next states only:

- new
- researched
- contacted
- replied
- qualified
- proof_requested
- checkout_started
- paid
- activated
- lost
- do_not_contact

## Message Variants

### Variant A: Missed-Call Recovery

Subject:

> Quick missed-call question for {{company}}

Body:

> Hi {{first_name_or_team}},
>
> I am testing SMIRK with home-service businesses that miss job calls while crews are already working.
>
> The narrow use case: a missed or forwarded call becomes a caller summary, owner alert, callback task, and dashboard proof instead of sitting in voicemail.
>
> Would one proof call be useful for {{company}}, or is missed-call recovery not a real problem for your team right now?

CTA:

> Start here: https://smirkcalls.com/launch

### Variant B: Trade-Specific Intake

Subject:

> Capturing urgent {{vertical}} calls

Body:

> Hi {{first_name_or_team}},
>
> For {{vertical}} businesses, the useful first step is not a generic AI receptionist. It is catching the job details when a call gets missed: issue, urgency, service area, callback window, and owner alert.
>
> SMIRK is built around that proof loop for home-service teams.
>
> If I showed you one call turning into a summary and callback task, would that be worth a 10-minute look?

CTA:

> Proof page: https://smirkcalls.com/launch

### Variant C: Owner Callback Workflow

Subject:

> What happens after a missed call?

Body:

> Hi {{first_name_or_team}},
>
> When a lead hits voicemail, most tools stop at "you missed a call." SMIRK is trying to make the next step operational: summarize what the caller needed, alert the owner, and create callback work.
>
> I am looking for blunt feedback from home-service operators. Would this workflow solve anything for {{company}}, or would it add noise?

CTA:

> See the sprint: https://smirkcalls.com/launch

### LinkedIn Short Version

> I am testing SMIRK for home-service missed-call recovery: call summary, owner alert, callback task, dashboard proof. Not SMS, not a generic receptionist pitch. Would one proof call be useful for {{company}}?

## Qualification

A qualified conversation is any owner/operator, manager, agency owner, or decision-influencer who confirms one of these:

- Missed calls are a real operating problem.
- They want to see a proof walkthrough.
- They ask about pricing, forwarding, setup, or proof data.
- They start checkout.
- They introduce another qualified owner/operator.

Do not count:

- Auto replies.
- Vendor pitches.
- Generic likes.
- Unqualified consumer messages.

## Kill Rules

- 100 touches and 0 qualified replies: rewrite the segment or message.
- Under 1% qualified replies after 200 touches: pause that channel.
- More than 3 repeated objections about setup: inspect self-serve onboarding.
- Checkout starts without activation: treat as product/onboarding defect.
- Any complaint about SMS or cold outreach: stop that channel variant and record the objection.

## Daily Operating Loop

1. Add researched companies to the ledger.
2. Send 10-20 manual touches.
3. Log response state the same day.
4. Mark demos booked and proof requests immediately.
5. Review objections every 25 touches.
6. Keep any segment/message above 3% qualified reply rate.
7. Do not start paid spend until live readiness and checkout tracking are green.

## Reporting

Every weekly checkpoint should report:

- Touches sent.
- Qualified replies.
- Booked demos.
- Checkout starts.
- Paid activations.
- Top objections.
- Segments killed or kept.
- Whether self-serve activation is still blocking scale.

Organic social replies should use the same qualification rules. If someone replies to a post from `docs/launch/social-post-pack.md`, log the `Log as` value from that post as the message variant in `/dashboard/launch`.
