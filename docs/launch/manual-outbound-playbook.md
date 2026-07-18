# SMIRK Manual Outbound Playbook

This playbook supports the 30-day market validation sprint with this hard rule: No cold SMS, no automated phone spam, no purchased-list blasting, and no unsupported claims.

## Goal

Run 200 researched manual touches to home-service owner/operators and stop only when one hard goal is hit:

- 1 paid Starter $197/month activation.
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
- Sacramento/Greater Sacramento expansion: `docs/launch/prospect-batch-005-sacramento-expansion.csv`.
- Boise/Treasure Valley expansion: `docs/launch/prospect-batch-006-boise-expansion.csv`.
- Salt Lake City/Wasatch Front expansion: `docs/launch/prospect-batch-007-salt-lake-expansion.csv`.
- Fresno/Central Valley expansion: `docs/launch/prospect-batch-008-fresno-expansion.csv`.

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

`researched` and `execution-ready` are separate states. A row is execution-ready only when the checked-in evidence has a current `refreshed YYYY-MM-DD` marker, a verified direct public contact path rather than an assumed homepage form, explicit public-contact evidence, and either a named owner/operator or phone-demand evidence. Audit the distinction offline:

```bash
npm run check:launch-prospect-readiness
```

The check does not browse, send outreach, write to the live ledger, place calls, create payments, or spend money. Do not edit a row merely to make the count pass; refresh it only from evidence.

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

To prepare a human-reviewed batch without sending anything:

```bash
npm run check:launch-touch-packet
npm run write:launch-touch-packet
```

This writes `output/launch-touch-packets/first-20-manual-touch-packet.md` and `.csv` only when at least 20 researched, zero-touch, zero-spend rows are also execution-ready. It fails closed when the evidence-backed pool is smaller; the total researched-row count cannot satisfy the packet gate.

Packet write and check commands make one authenticated, read-only `GET /api/launch/ledger` reconciliation against the canonical production API. Every selected company must have exactly one live row that is still `researched`, untouched, zero-spend, non-DNC, with response unchanged and proof, checkout, and activation unstarted. Missing, duplicate, touched, progressed, malformed, incomplete-window, cacheable, or do-not-contact state stops packet generation. The packet records the production source, snapshot time, selected-state SHA-256, and that no write occurred. It never sends outreach or writes to the live ledger.

It also writes `output/launch-touch-packets/first-20-manual-touch-execution.csv`. Keep that file open during the manual send block and fill it only after each human-reviewed send. Use it to capture `sent_at`, `human_sender`, `actual_contact_path`, `response_status`, `qualified_reason`, `objection`, and `skip_reason` before updating `/dashboard/launch`. Draft rows stay `next_state_after_send=researched` with `touch_count_delta=0`; change them only after a touch has actually been sent.

Every packet now includes a canonical approval manifest, an approval payload SHA-256, a per-draft SHA-256, and one exact `APPROVE_SMIRK_OUTREACH_BATCH` token. The batch hash binds the ordered company names, channels, public contact paths, exact individualized copy, canonical production ledger source, and selected live-state SHA-256. Changing any of those fields—or regenerating after a selected live-state change—invalidates the approval and requires a newly generated packet and approval.

For a narrow reviewed batch, pass repeated `--company=` arguments. The output preserves that exact order and refuses missing, duplicate, or count-mismatched targets:

```bash
node scripts/write-launch-touch-packet.mjs \
  --company="Exact Company One" \
  --company="Exact Company Two" \
  --company="Exact Company Three"
```

Generating the packet is not outreach authority. Do not send, queue, or log a touch until Cameron approves the exact token printed in that packet.

Immediately before relying on a prepared packet, rerun its exact `--check --company=...` command. That check performs a fresh production-ledger `GET` and rejects the packet if selected live state has changed since the recorded snapshot.

To build the daily handoff zip for Computer Use or manual file transfer:

```bash
npm run build:launch-zip
```

This runs `check:billing-lifecycle`, validates all researched prospect CSVs offline, performs the packet's GET-only production-ledger reconciliation, writes the fresh 20-row packet, validates `first-20-manual-touch-execution.csv`, and creates:

- `output/smirk-launch-packet.zip`
- `output/launch-packet-archives/smirk-launch-packet-<timestamp>.zip`

The zip includes the markdown packet, packet CSV, execution CSV, `manifest.json`, and `telegram-handoff.txt`. It does not send outreach, count touches, write to Railway, spend money, place calls, run Stripe smoke, or touch SMS.

Computer Use / Telegram handoff is paused until the hardened approval path passes a fake-target test. Do not upload this zip to Telegram, Hermes, or any external channel merely because the packet exists.

Approval path requirements before any Telegram handoff:

- Validate Telegram's `X-Telegram-Bot-Api-Secret-Token` webhook secret header.
- Require allowlisted Telegram user ID and chat ID.
- Use opaque approval IDs, never public target IDs.
- Record approver, timestamp, original payload hash, intended action, and audit rows.
- Make callbacks single-use and idempotent.
- Keep `PREPARED`, `APPROVED`, `SENDING`, `SENT`, and `FAILED` distinct.
- Report success only when the expected database row changed.
- Provide preview, reject, expire, and cancel controls.
- Prove the full path with a fake target before touching a real prospect.

Proper sequence:

1. Secure approval path.
2. Harmless fake-target end-to-end test.
3. First three outreach drafts for human review only.
4. One manually approved send.
5. Record outcome.

Optional local cron entry:

```cron
0 9 * * * cd /Users/cameronchurch/OpenClaw/workspace/ai-phone-agent-from-gemini && npm run build:launch-zip
```

Generate the full first-sprint 200-row queue when planning the complete manual-touch batch:

```bash
npm run write:launch-touch-packet:200
```

This writes `output/launch-touch-packets/first-200-manual-touch-packet.md`, `.csv`, and `first-200-manual-touch-execution.csv` only after all 200 requested rows are locally execution-ready and independently confirmed eligible in the current production ledger. Until then it fails closed rather than converting generic research into an executable queue. When available, use the 200-row packet as the sprint queue, then work it in smaller reviewed blocks. It still does not send outreach, count touches, write to Railway, spend money, or touch SMS.

Before copying execution-sheet results into `/dashboard/launch`, run:

```bash
npm run check:launch-touch-execution
```

This is an offline validation only. It checks response states, qualification reasons, skip reasons, zero spend, and no SMS/auto-dial/voicemail-drop/purchased-list language. It does not write to Railway, send outreach, or count touches.

For the full sprint worksheet:

```bash
npm run check:launch-touch-execution -- output/launch-touch-packets/first-200-manual-touch-execution.csv
```

To avoid hand-copying completed sends, dry-run the live ledger import:

```bash
npm run import:launch-touch-execution
```

Apply the import only after the touches were actually sent by a human and the dry run matches the intended rows:

```bash
CONFIRM_SMIRK_LAUNCH_TOUCH_IMPORT=log-human-launch-touches npm run import:launch-touch-execution:apply
```

This importer only patches existing `/dashboard/launch` researched rows. It requires `sent_at`, `human_sender`, `actual_contact_path`, `next_state_after_send`, and `touch_count_delta=1`; it skips rows already marked with `touch_logged_at`; and it never sends outreach, SMS, calls, payments, or paid spend. If a real second touch is intentionally being logged for a company that already has `touch_count > 0`, run the importer with `--allow-repeat-touch` after reviewing that row.

Before writing researched rows to the live ledger, run `npm run import:launch-ledger:all:validate`. This checks every `docs/launch/prospect-batch-*.csv` file offline for researched-only rows, duplicate companies, forbidden outreach channels, zero touches, and zero spend. Live import still requires operator auth plus `CONFIRM_SMIRK_LAUNCH_LEDGER_IMPORT=import-researched-launch-prospects`.

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

## Message Safety Rule

Do not claim a prospect is losing money, has critical leaks, or that an audit costs us zero labor. Public copy must describe observed friction and possible risk, not established loss.

Internal joke language like “visual crime scene” stays internal only. External phrasing should survive hostile review:

> I noticed a possible mobile booking issue that may be creating friction.

## Message Variants

### Variant A: Missed-Call Recovery

Subject:

> Quick missed-call question for {{company}}

Body:

> Hi {{first_name_or_team}},
>
> I am testing SMIRK with home-service businesses that miss job calls while crews are already working.
>
> The narrow use case: a caller who reaches the dedicated recovery number becomes a caller summary, owner alert, callback task, and dashboard proof instead of sitting in voicemail.
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

Until the Telegram approval path is hardened and harmlessly tested, do not send outreach. Current sequence:

1. Secure approval path.
2. Harmless end-to-end test with a fake target.
3. Prepare three outreach drafts for human review only.
4. Send exactly one manually approved message.
5. Record the outcome.
6. Only then consider increasing daily touch volume.

After the first complete, observable, reversible transaction works, normal batch rhythm may resume:

1. Add researched companies to the ledger.
2. Send 10-20 manual touches only when approval, ledger, and send controls are working.
3. Fill the execution CSV as each human-reviewed touch is sent or skipped.
4. Run `npm run check:launch-touch-execution`.
5. Dry-run `npm run import:launch-touch-execution`, then log response state in `/dashboard/launch` or apply the guarded importer the same day.
6. Mark demos booked and proof requests immediately.
7. Review objections every 25 touches and run `npm run check:launch-segment-decisions` to inspect keep/rewrite/pause/product-fix decisions by segment and message.
8. Keep any segment/message above 3% qualified reply rate.
9. Do not start paid spend until live readiness and checkout tracking are green.

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

Use `npm run check:launch-segment-decisions` before each weekly checkpoint. The report aggregates by channel, vertical, message variant, channel+message, and vertical+message; it does not print raw company, owner, contact path, or notes fields.

Organic social replies should use the same qualification rules. If someone replies to a post from `docs/launch/social-post-pack.md`, log the `Log as` value from that post as the message variant in `/dashboard/launch`.
