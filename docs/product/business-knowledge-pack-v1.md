# SMIRK Business Knowledge Pack v1

## Purpose

The **Business Knowledge Pack** is the reusable context bundle that lets one SMIRK workspace answer as one specific business. It is designed for a fast, controlled demo: an operator supplies an official website and/or an exported CRM file, reviews the facts, activates the pack for that workspace, and then places a call. The agent adopts the business identity and uses only the approved operating facts for the active workspace.

It is deliberately not a promise that SMIRK has performed a full CRM migration or that it can autonomously quote every price in a business system.

## Two Viable Delivery Paths

| Approach | What the operator does | Trade-offs | Incremental cost | Setup complexity |
|---|---|---|---|---|
| **Knowledge Pack v1** | Enters a confirmed website or adds a CSV, JSON, or TXT export; reviews categorized facts; presses Activate for the demo workspace | Does not continuously synchronize with third-party CRM changes; exact pricing is locked behind an explicit policy | Uses current application infrastructure; any optional fact-categorization AI usage should be capped per import | Low; suitable for a demo or a small service business |
| **CRM Connector Platform** | Authorizes a vendor account; chooses objects and fields; SMIRK synchronizes customer, job, pricebook, calendar, and pipeline changes | Each vendor needs its own OAuth/API design, permissions model, data mapping, token rotation, error recovery, and support surface | Ongoing vendor/API and maintenance cost | High; not appropriate before first-dollar validation |

The existing app is already closer to the first path than it appears: it has workspace-scoped website scanning, local-file import, contact merging, a business profile, live prompt injection, and source deletion. The v1 work is to turn that loose pipeline into an **approved, versioned operating package**, not to rebuild CRM ingestion from zero.

## Data Contract

Each active pack has a version, workspace scope, provenance, review state, and a bounded context projection for the call agent.

| Section | Required fields | Answer rule | Default when absent |
|---|---|---|---|
| Identity | Legal/display business name, agent name, public phone, website, service area, hours | State only the active workspace identity | Ask for a callback if identity-specific answer is needed |
| Services | Service name, short description, service area, availability policy | Confirm services listed as active | Say the owner will confirm availability |
| Pricing | Quote policy plus optional fixed price, range, starting price, or deposit language | Quote only when policy is explicit and effective date is valid | **Do not quote**; capture request and escalate |
| FAQs and policies | Question, approved answer, source, expiry/review date | Use only approved answers | Offer owner confirmation |
| Escalation | Trigger, urgency, destination, task template | Create handoff/callback with the caller’s request | Default callback task |
| Caller context | Contact identifiers, preferences, history, tags, custom fields, data source | Use for recognition and routing, never to infer a new promise | Treat as unknown |
| Provenance | Source type, source URL or file name, imported time, source snippet, operator reviewer | Display in review screen and retain in audit history | Source remains draft |

## Lifecycle and Guardrails

```text
Website / CRM export / operator note
        ↓
Draft sources + normalized facts
        ↓
Operator review and correction
        ↓
Approved Business Knowledge Pack version
        ↓
Activated for one workspace or demo only
        ↓
Bounded prompt projection used during calls
        ↓
Escalation for anything absent, ambiguous, expired, or quote-restricted
```

The first release needs **draft vs. active** state. Current imports become live prompt text immediately, which is fast but unsafe for temporary demos. A website scan should remain a source candidate until the operator confirms the identity, services, and any high-risk details. Imported price language should always enter as `do_not_quote` unless an operator explicitly selects a quote policy. The system should never infer pricing from a marketing sentence or customer record.

## Supported Inputs in v1

The v1 interface should accept a direct public website, a CSV export, JSON, plain text, and manual facts. The app already supports the first four mechanics. The prioritized adapters should be **field mappings**, not vendor-specific live connections:

| Source | Ingest method | Useful content | v1 treatment |
|---|---|---|---|
| Any public website | Operator-confirmed URL | Identity, hours, services, service area, FAQ wording, contact details | Scan small same-origin HTML page set; require review before activation |
| HubSpot | Exported contacts, companies, deals, and tickets in CSV | Contact history, business associations, open requests | CSV mapping templates; no OAuth connector initially |
| Jobber | Client CSV export | Contacts, tags, property addresses, custom fields | CSV mapping template; no job or schedule automation initially |
| ServiceTitan | Customer/job/pricebook export | Customer context, jobs, approved service catalog/pricebook data | Import only operator-selected export; no production API connection initially |
| Other CRMs | CSV/JSON/TXT | Contacts, services, FAQs, policies, notes | Detect common headers and show an unmapped-field report |

HubSpot supports record exports with properties and associations, Jobber supports CSV client exports including contacts, tags, property addresses, and custom fields, and ServiceTitan exposes an OAuth/API model for jobs and pricebook data. Those facts make **export-first** the correct compatibility layer: it gets useful data without making a customer grant broad API access during a demo. [1] [2] [3]

## Required Operator Experience

The screen should lead with **Build demo context**, not “CRM.” The operator enters the business website or uploads a file. SMIRK proposes a clear business identity and an answer policy, then shows a review table with three states: **safe to say**, **needs owner approval**, and **always escalate**. A single **Activate for this demo** action applies the pack to only the selected workspace. The operator should see the greeting and the live call prompt preview immediately.

The workflow needs an obvious **Reset demo** action that deactivates only the workspace pack and does not delete the source audit record or touch another customer workspace.

## Non-Negotiable Constraints

1. A website is a data source, not authority. Its content can inform the draft but cannot authorize commitments by itself.
2. No fixed price, availability promise, discount, warranty, or appointment confirmation is spoken unless the approved pack explicitly permits it.
3. Imports remain workspace-scoped; selecting a demo must not alter the global agent, another workspace, or the dedicated SMIRK sales line.
4. Imports must reject private network URLs, oversized pages, non-HTML responses, redirects to unsafe hosts, and unbounded crawl behavior.
5. A CRM export may contain personal data. The system must keep only fields required for caller recognition and service, identify the source, and let the workspace delete it.
6. A live third-party connector is a separate product with scoped access, consent, token security, data-retention rules, change detection, and a connector-specific failure path.

## Success Definition

The feature is successful when an operator can create a clean electrician demo in under ten minutes, the next inbound call answers with that business name and approved services, a question about an unapproved price routes to a callback without invention, and switching to another workspace changes the business context without leakage.

## References

[1] [HubSpot: Export your records](https://knowledge.hubspot.com/import-and-export/export-records)

[2] [Jobber: Export Client Information](https://help.getjobber.com/en/articles/export-client-information/)

[3] [ServiceTitan: Get started with API dev portal V2](https://help.servicetitan.com/roofing/docs/get-started-with-api-dev-portal-v2)
