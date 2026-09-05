# Velvet Acquisition Evidence Inbox

## Purpose

The evidence inbox gives SMIRK one immutable identity inside an existing operator tenant before any contact, call, handoff, approval, checkout, or downstream customer workspace exists. It records provenance; it does not execute outreach or provider actions.

`POST /api/integrations/velvet/acquisitions` requires a dedicated `VELVET_ALCHEMY_ACQUISITION_API_KEY`, an exact configured workspace, durable Postgres storage, and completed acquisition-schema initialization. `POST /api/integrations/velvet/handoffs` remains a separate, hardened queue receiver with its own credential and write contract; it is not an acquisition-inbox alias, and synthetic acquisition fixtures must not be sent to it.

## Identity Contract

Every receipt carries two independent upstream identities:

- `sourceRecordId` identifies the durable Velvet lead and is the future feedback target.
- `sourceEventId` identifies this delivery and is the idempotency key.

SMIRK derives opaque `acq_…` and `ace_…` identifiers. Replaying the same event and payload returns the original receipt. Reusing an event ID with changed evidence returns `409` and does not alter the original.

## Classification and Contact Fence

The caller must explicitly send `recordKind`:

- `synthetic` is accepted only with the reserved `velvet-manus-fake-…` identities, `+12025550124`, low urgency, and synthetic/test labels. It is persisted as `not_permitted` with basis `synthetic_fixture`.
- `real` is accepted only in `evidence-inbox-v1` mode and may not use reserved fixture identities. It is persisted as `unverified`, basis `not_evaluated`, and route decision `hold`.

Both classifications create only `acquisition_records`, `acquisition_events`, and an initial append-only review. Root source and safety fields are immutable in this slice; a later reviewed state-transition design must append evidence instead of directly making a root contactable. Intake never creates a contact, call, message, handoff, task, approval, touch, checkout, or outbound request.

## Example

```json
{
  "workspaceId": 1,
  "recordKind": "real",
  "sourceRecordId": "velvet-lead-12345",
  "sourceEventId": "velvet-event-67890",
  "caller": {
    "phone": "+17755550142",
    "name": "Prospect Owner"
  },
  "companyName": "Prospect Plumbing Company",
  "reason": "Qualified prospect evidence received for operator review.",
  "urgency": "normal"
}
```

The response returns `receiptId`, `acquisitionId`, classification/contact state, `externalAction: "none"`, and a stable feedback identity. Operator-authenticated reads are available through `/api/acquisitions`, `/api/acquisitions/:id`, and `/api/velvet/portal`.

## What Remains Separate

Tenant-matched nullable acquisition links now exist for calls, handoffs, launch analytics/ledger, outreach approvals, Stripe fulfillment, provisioning, and activation events. Their writers do not yet propagate the ID, so the portal deliberately reports lifecycle attribution as unavailable. A separately keyed post-call outcome callback exists for completed calls linked to legacy Velvet handoffs, but it stays disabled without explicit runtime configuration and is not treated as acquisition feedback until exact acquisition linkage is present. Provider touch receipts, dynamic checkout attribution, activation propagation, and a durable acquisition feedback outbox remain separate guarded slices.

Deployments that previously used `velvet_alchemy_handoff_receipts` need a separate reviewed migration. Existing receipt, handoff, and task rows are not inferred or backfilled from names, phone numbers, or formatted IDs; any migration must prove an exact source identity and preserve the old payload hash before attaching an acquisition ID.
