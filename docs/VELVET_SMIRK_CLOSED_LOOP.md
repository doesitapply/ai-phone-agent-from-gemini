# Velvet + SMIRK Closed-Loop Revenue System

> **Operating doctrine:** Velvet identifies and evidences an opportunity. SMIRK routes only approved, eligible work into a conversation and records what happened. The resulting evidence is used to improve the next selection decision. No feature is a priority unless it moves, measures, protects, or improves this loop.

## Why This Exists

SMIRK began as an inbound missed-call recovery system. That remains the most proven customer-facing wedge: a business misses a call, SMIRK answers, captures the need, creates follow-up work, and preserves a record.

The broader operating system joins that capability to Velvet Alchemy. Velvet performs discovery and research; SMIRK performs the controlled contact and conversation work. The product is not “more AI features.” It is a closed evidence loop from a discovered business to an attributable commercial outcome.

The intended feedback loop resembles a **Karpathy loop** in the useful operational sense: collect high-quality observations, apply a decision policy, execute under guardrails, score the outcome, and use the resulting labeled data to improve the next policy. It does **not** mean SMIRK or Velvet currently retrains a model automatically, nor does it authorize unreviewed outreach.

## The System in One Diagram

```text
Velvet discovery and research
  -> immutable lead identity + source evidence
  -> qualification / contactability / channel decision
  -> approval bound to a specific outreach payload
  -> authenticated handoff to SMIRK
  -> SMIRK contact, task, handoff, call, transcript, and summary records
  -> qualified conversation / booking / activation / terminal reason
  -> customer, workspace, Stripe, and retention records
  -> outcome evidence returned to Velvet
  -> comparison of prediction, route, message, and outcome
  -> better future Velvet selection and routing policy
```

The loop is only credible when the same lead identity survives every transition. If a later payment cannot be traced to the original business and evidence, the system produced activity rather than attributable revenue.

## The Two Systems Have Different Jobs

| System | Job | It must not do |
| --- | --- | --- |
| **Velvet Alchemy** | Discover, research, score, evidence, qualify, and explain why a business is an opportunity. | Treat a score as permission to contact a person, invent source/consent evidence, or claim conversion without a recorded outcome. |
| **SMIRK** | Enforce operational controls; create the work record; handle approved calls/conversations; qualify, schedule, recover, or escalate; and preserve the interaction record. | Make an unapproved outbound decision, bypass DNC or applicable contact controls, treat a shared key as a person’s identity, or claim the outcome automatically improved Velvet. |
| **Operator** | Review exceptions, approve consequential work, inspect the evidence chain, and decide whether an outcome is reliable enough to feed back. | Use a dashboard click or chat request as implicit approval for a call, message, billing change, deployment, or credential change. |

## The Evidence Chain

The production target is an immutable chain rooted at one `acquisition_record`. The identifiers below are conceptual requirements; the current database has several downstream records but does not yet persist the complete root-to-revenue model.

| Link | Required evidence | Current state |
| --- | --- | --- |
| Discovery | External Velvet lead ID, business identity, source URL or source evidence, discovery time, research snapshot. | **Partial.** Velvet retains this; SMIRK’s receiver currently stores an external handoff ID and payload hash, not a durable full source-evidence root. |
| Decision | Contactability decision, selected channel, rules evaluated, reason, and decision version. | **Target.** Existing compliance and DNC controls exist, but a Velvet-specific durable routing decision is not yet linked to the inbound record. |
| Authorization | Actor/policy that approved the exact outreach payload, time, and expiry. | **Target.** Operator confirmation and chat confirmation gates exist, but an immutable Velvet approval artifact is not yet bound to every downstream touch. |
| Execution | Unique touch ID, exact channel, time, workspace, call/task/handoff links, and outcome. | **Partial/live.** SMIRK persists contacts, calls, handoffs, tasks, call events, transcripts, and summaries; complete cross-system touch lineage remains incomplete. |
| Conversion | Demo, activation, Stripe customer/subscription/payment, workspace, and owner identity links. | **Partial.** SaaS and Stripe/provisioning records exist; live paid billing remains separately gated and not yet tied to an immutable Velvet root. |
| Retention | Renewal, churn, refund/failure, and revenue period evidence attached to the same chain. | **Target.** |
| Feedback | Idempotent summary sent to Velvet with outcome, reason, timestamps, and linked records. | **Target.** The outcome callback credential boundary is defined, but source code does not currently implement durable automatic outbound outcome delivery. |

## What Is Live and Proven

The following capabilities are not roadmap claims; they are implemented integration behavior in the AI Phone Agent repository and separately verified receiver-recovery evidence.

| Capability | Evidence and behavior |
| --- | --- |
| Authenticated Velvet handoff receiver | `POST /api/integrations/velvet/handoffs` requires the dedicated inbound bearer and validates a configured workspace. The receiver rejects mismatched credentials with `401`. |
| Input validation and idempotency | The receiver validates a strict payload schema, requires a stable external ID, hashes the payload, rejects a reuse with different content, and returns the existing handoff/task on an exact replay. |
| Durable SMIRK work records | A valid receiver call writes a contact, an `external_handoff` call record, a pending handoff, an open task, a receipt, and a call event. It does not start a telephone call merely because it received the handoff. |
| Sender-side proof | The separate Velvet task recorded a protected synthetic proof with `201 RECEIVED` followed by `200 DUPLICATE`; no real lead, call, SMS, email, payment, or retry was used. |
| Operator portal | SMIRK exposes an operator-only Velvet portal and the existing handoff queue. The portal explicitly reports `sourceAttributionAvailable: false` rather than fabricating source lineage. |
| Chat safety boundary | The repaired SMIRK chat returns safe provider failures, restricts tool-capable mode to verified owner identity, keeps shared operator-key chat read-only, and requires exact confirmation strings for writes and calls. |

## Non-Negotiable Safety Rules

1. **Handoff is not outreach.** An inbound Velvet handoff creates internal work. It does not authorize a call, SMS, email, payment, or CRM sequence.
2. **A score is not consent.** Velvet research is evidence for review; it is not legal permission for outreach.
3. **Every consequential touch needs a durable reason.** The record must show the business, route, approval, actor/policy, channel, and outcome.
4. **No silent retries.** Receiver replay is idempotent only for the same payload. A changed payload using the same external ID is rejected rather than overwriting history.
5. **DNC and contact restrictions win.** Existing SMIRK compliance controls are guards, not a blanket legal conclusion. Apply qualified review and local rules before enabling outbound automation.
6. **No secret leakage across the boundary.** The inbound handoff bearer, Velvet read key, and outcome key are different credentials with different scopes. They are never sent to the browser, model context, logs, or documentation.
7. **Chat is not infrastructure control.** The operator chat cannot change credentials, deploy code, modify Railway variables, alter payment settings, or execute arbitrary remote code.

## The Operator Workflow

### 1. Velvet decides that an opportunity is worth review

Velvet produces the business identity, source evidence, research signals, qualification rationale, and an external lead ID. The operator should be able to answer: “Why did Velvet select this business, and what evidence supports that decision?”

### 2. The router decides whether an action is eligible

Before any contact action, the system evaluates the permitted channel, available contact basis, DNC or suppression state, time/window rules, lead status, and required human approval. This is the **acquisition router**. It is the missing middle layer that prevents a discovery tool from becoming uncontrolled outreach.

### 3. Approved work enters SMIRK through an authenticated handoff

Velvet sends a narrowly scoped payload to SMIRK’s protected receiver. SMIRK validates the bearer, workspace, external ID, and payload. A successful handoff becomes a durable pending work item, not an autonomous phone call.

### 4. SMIRK handles the conversation and writes the operational record

For inbound demand, Twilio and the AI voice flow capture the caller’s need, details, urgency, transcript, summary, next action, and related task. For approved outbound work, the exact contact action must pass the applicable SMIRK control and confirmation path. Calls, tasks, handoffs, contact updates, and call events stay workspace-scoped.

### 5. The system classifies the commercial result

The result must be more than “activity happened.” It needs a reasoned state such as qualified, booked, activated, paid, retained, disqualified, unreachable, suppressed, or closed-lost, with the reason and evidence required for future review.

### 6. The outcome becomes feedback data

Only after the outcome is reliable should it be sent back to Velvet. Velvet can then compare the original evidence and prediction with the actual result. That enables later improvements to targeting, qualification, routing, messaging, and human review rules.

## What “Learning and Growing” Means

The loop should improve through measured policy changes, not by letting a model silently rewrite its own rules.

| Signal | Example question | Improvement surface |
| --- | --- | --- |
| Discovery quality | Which evidence patterns predict a qualified conversation? | Velvet research and selection policy. |
| Routing quality | Which businesses are eligible for which channel and which are blocked? | Acquisition router and compliance policy. |
| Conversation quality | Which approved messages, scripts, or questions lead to bookings or productive next steps? | SMIRK prompt, playbook, and escalation policy. |
| Commercial quality | Which source, segment, and route produce paid activation and retained revenue? | Budget/priority allocation and sales process. |
| Negative outcomes | Why did a lead fail: bad evidence, no fit, no consent, no answer, timing, offer, or execution? | Suppression rules, research prompts, qualification, and follow-up policy. |

The correct loop is therefore:

```text
Evidence -> policy -> guarded action -> recorded outcome -> reviewed label -> policy improvement
```

It is not:

```text
Score -> automatic outreach -> opaque model update -> repeat
```

## Acceptance Test

The system is complete only when one real business can be traced in both directions.

| Direction | Required question |
| --- | --- |
| Revenue backward | “Why did we make this dollar?” The system returns the customer, workspace, payment/retention event, conversion, touches, approval, route, Velvet lead, and original evidence. |
| Lead forward | “What happened to this Velvet lead and why?” The system returns the decision, blocks/approvals, every touch, conversation, result, and feedback status. |

Until both answers come from records rather than operator memory, the work is still an integration, not an attributable revenue system.

## Build Order

1. Implement `acquisition_record` as an immutable root with Velvet external lead ID and source evidence.
2. Persist the route/contactability decision and approval artifact before any outbound touch.
3. Bind every task, handoff, call, message, summary, and appointment to that root.
4. Bind activation, workspace, Stripe customer/subscription/payment, and retention records to the same root.
5. Add idempotent outcome feedback to Velvet and a reconciliation view for delivery failures.
6. Run the one-real-lead acceptance test, then repeat at ten and fifty leads before expanding automation.

## Relevant Source Files

| File | Responsibility |
| --- | --- |
| `src/routes/velvet-handoff-routes.ts` | Inbound bearer validation, payload validation, receipt/idempotency, and durable handoff/task creation. |
| `src/velvet-handoff.ts` | Shared handoff schema, configuration, constant-time bearer comparison, payload hashing, and deterministic handoff call identity. |
| `src/routes/operations-routes.ts` | Handoff queue and operator Velvet portal; currently discloses missing source attribution instead of inferring it. |
| `src/compliance.ts` and `src/routes/compliance-routes.ts` | Existing DNC/compliance control surfaces. |
| `src/intelligence.ts`, `src/function-calling.ts`, `src/tools.ts` | Call handling, post-call intelligence, summaries, and operational actions. |
| `src/saas.ts` and buyer/provisioning routes | Workspace, plan, Stripe, activation, and lifecycle records. |
| `src/smirk-chat.ts`, `src/routes/lead-routes.ts`, `src/owner-chat-identity.ts` | Owner-only tool-capable chat boundary and safe provider-failure behavior. |
