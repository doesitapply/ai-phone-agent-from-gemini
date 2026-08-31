# Business Knowledge Pack Audit

**Scope:** Demo and customer workspace business grounding for the SMIRK phone agent.

## Current Capability

SMIRK already has the beginnings of a business-knowledge workflow. A workspace operator can set a business profile, scan an HTTP(S) website, choose extracted profile fields, upload or paste CSV, JSON, or text, and inspect the resulting prompt context. The live call path injects both the workspace identity and the assembled workspace knowledge block before the agent's configured persona. Imports and contacts are scoped to the authenticated workspace.

| Requirement | Current state | Operational assessment |
|---|---|---|
| Business identity and greeting | Workspace profile fields are injected into live calls | Adequate for a basic demo once reviewed |
| Website lookup | Public website scanner collects HTML pages, source-linked excerpts, candidate profile fields, and warnings | Useful for simple sites; not a trustworthy autonomous source of commitments |
| File ingestion | Browser reads CSV, JSON, and TXT files; backend imports records with phone numbers as contacts and saves all source text | Good first input surface; not a CRM adapter platform |
| Agent grounding | Up to eight recent sources are flattened into a capped prompt block | Appropriate for a small demo; unsuitable for an entire operational CRM |
| Workspace isolation | Reads and writes use the authenticated workspace ID | Correct design direction; requires dedicated regression coverage |

## Material Gaps

The current implementation should **not** be presented as a complete CRM integration system. Every import becomes live agent context immediately; it has no draft, review, version, or activation state. Website prose is flattened into a prompt, which means stale marketing claims and prompt-injection text can be treated as useful context unless the caller-facing rules are strengthened. The scanner can find sentences containing pricing language, but it cannot determine whether a price is current, applicable, or authorized.

Contact custom fields from a file import are currently marked human-confirmed automatically. That is too strong for an unreviewed export. A supplied CRM can be a useful source of caller history, but it is not proof that every service, price, or policy is safe to quote. The current context also lacks a fact-type contract: it cannot distinguish a verified fixed price from a price range, promotion, service-area statement, FAQ answer, or mandatory escalation instruction.

Finally, the crawler is deliberately lightweight. It follows a small number of same-origin HTML pages and does not render JavaScript-heavy sites or connect to vendor APIs. That is a reasonable security and reliability trade-off for launch, but it means the operator must be able to correct or complete the generated pack.

## Required Product Boundary

> **The product is not "upload any CRM and the AI knows everything." It is "turn approved business facts into a controlled, workspace-specific answer policy in minutes."**

The minimum safe unit is a versioned **Business Knowledge Pack**. It needs explicit sections for identity, services, service area, hours, price policy, FAQs, escalation rules, customer-context fields, sources, and approval status. Facts should carry source and confidence metadata. Only reviewed facts should reach the live-call prompt. A pricing entry must include a quote policy such as `do_not_quote`, `starting_at`, `range`, `fixed`, or `custom_quote_required`; the default remains `do_not_quote`.

For demos, the operator should be able to paste a website, receive a draft, correct the business name and high-risk fields, press **Activate for this demo**, and hear the agent use that company identity on the next call. The workspace remains isolated, and switching to a different demo activates that workspace's pack rather than mutating global configuration.

## Recommended Delivery Sequence

| Release | Included | Explicitly excluded |
|---|---|---|
| Knowledge Pack v1 | Website or CSV/JSON/TXT import, fact categorization, review, explicit activation, workspace isolation, quote/escalate safety, live preview | Continuous CRM sync, vendor API OAuth, arbitrary document OCR |
| Adapter layer | Header mappings and import templates for common CRM exports, conflict reporting, better source provenance | Live two-way synchronization |
| Connector platform | Scoped OAuth/API connectors and optional scheduled refreshes after provider-specific security review | Universal "connect anything" promise |

The first release is worth building because it directly reduces demo setup from manual prompt writing to a repeatable review-and-activate action. The connector platform should stay deferred until the same narrow workflow converts a paying customer; it is far more expensive, failure-prone, and not needed to prove demand.
