# SMIRK Inbound Demonstration Funnel

> **Status:** Approved product direction. This document is an operating design, not legal advice. Have qualified counsel review the final outreach, consent, and recording language before broad deployment.

## Operating Principle

SMIRK does **not** originate AI cold calls to local contractors. Velvet identifies a strong fit and prepares a reviewable invitation. The recipient then independently visits the public SMIRK Calls demonstration page or calls a disclosed SMIRK demonstration line. SMIRK demonstrates how its missed-call recovery workflow would work for that business, captures explicit interest, creates an owner dossier, and presents the single approved Starter checkout.

The invitation must never claim that SMIRK is already answering for the recipient's business. The inbound agent must say that it is a **SMIRK demonstration configured for the named business**, not represent itself as the prospect's live receptionist.

## Funnel

| Stage | System | Allowed action | Required evidence |
|---|---|---|---|
| 1. Identify | Velvet | Find local businesses and model public, non-sensitive fit signals such as service category, hours, and publicly listed contact channels. | Source, timestamp, public source URL or operator note, reviewer. |
| 2. Review | Velvet operator queue | Produce an outbound email draft or an owned-channel/public landing-page invitation. SMS remains disabled unless valid recipient-specific consent exists. | Approved copy, operator approval, audience / channel record. |
| 3. Invite | Human-approved email or public web | Send a truthful invitation that identifies SMIRK, says it is promotional, supplies the sender address and opt-out path, and leads to a public demo URL / test number. | Send timestamp, sender identity, unsubscribe handling. |
| 4. Self-initiate | Prospect | Prospect calls the test line or opens the web demo and affirmatively starts a call. | Unique invite token or normalized caller-number match; start timestamp. |
| 5. Demonstrate | SMIRK | Clearly disclose the product demonstration, use the preloaded prospect profile as a simulation, then ask one intent question. | Consent / disclosure event, transcript, call summary. |
| 6. Qualify | SMIRK + Velvet | Create a qualified-interest dossier with business name, intent, call evidence, and recommended next action. | Dossier ID, task ID, result status. |
| 7. Convert | SMIRK Calls | Present the sole approved $197/month Starter checkout. | Checkout-start event and, if paid, webhook / workspace-provisioning record. |

## Channel Rules

### AI voice calls

Do not initiate AI-generated sales calls to prospects. The FCC states that its TCPA restrictions on artificial or prerecorded voice include current AI technologies that generate human voices, and says such calls require the called party’s prior express consent.[^fcc-ai]

### SMS

The existing `sms-guardrails` implementation is the correct default: no promotional SMS unless recipient-specific consent is on record, it has not been revoked, and the message can carry opt-out handling. This requirement remains even when the message promotes an invitation to call a demo line. Do not treat an acquired public business number as consent.

### Email

Human-reviewed commercial email may be used only if every message identifies SMIRK accurately, uses a truthful subject line, identifies itself as an advertisement, includes a valid physical postal address, and offers an easy opt-out that is honored promptly. These apply to business-to-business messages as well.[^ftc-can-spam]

### Public and owned channels

The lowest-risk scalable path is a public SMIRK Calls page, referral links, QR codes, local events, direct human conversations, and other invitation channels where the prospect chooses to begin the interaction. This is the acquisition lane to optimize before any outbound program.

## Test-Call Script Constraints

The initial agent message should state the following substance before simulating a workflow:

> "You reached SMIRK’s private demonstration for **[Business Name]**. This is not their live after-hours line. I can show you how SMIRK would capture a missed caller and send you a callback-ready lead. Would you like to test an emergency request or an estimate request?"

The agent must not claim that the named business has purchased SMIRK, that it represents the business, that a callback is already promised, or that an audit result is verified unless the source and calculation are recorded in the invitation dossier.

## First-Dollar Scope

The first-dollar release contains only this path:

1. One $197/month Starter plan.
2. One approved Stripe-hosted Payment Link.
3. One workspace-provisioning webhook path.
4. One clear onboarding action: forward missed calls to the SMIRK number.
5. One proof record: inbound demo/test call, summary, callback task, owner notification, and checkout event.

Growth sequences, AI cold calling, outbound SMS, and automated email sending remain outside the first-dollar release. They are later additions only after evidence and counsel-reviewed policies support them.

## References

[^fcc-ai]: [Federal Communications Commission, *FCC Confirms that TCPA Applies to AI Technologies that Generate Human Voices* (Feb. 8, 2024)](https://www.fcc.gov/document/fcc-confirms-tcpa-applies-ai-technologies-generate-human-voices)
[^ftc-can-spam]: [Federal Trade Commission, *CAN-SPAM Act: A Compliance Guide for Business*](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)
