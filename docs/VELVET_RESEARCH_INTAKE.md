# Velvet Alchemy Research Intake

SMIRK exposes a dedicated research-only endpoint for importing one reviewed
prospect at a time:

```text
POST /api/integrations/velvet/prospects
```

This capability is intentionally separate from the synthetic callback-handoff
receiver. It can create only a research batch, a prospect record, and an
idempotency receipt. It cannot send email or SMS, place a call, create a
callback task, or register a call handoff.

## Configuration

Set both variables in the SMIRK runtime:

```text
VELVET_ALCHEMY_RESEARCH_API_KEY
VELVET_ALCHEMY_RESEARCH_WORKSPACE_ID
```

The API key must contain at least 32 characters. Do not reuse
`DASHBOARD_API_KEY`, a workspace API key, or
`VELVET_ALCHEMY_HANDOFF_API_KEY`.

If either value is missing or invalid, the endpoint returns `503` and writes
nothing.

## Request

Authenticate with the dedicated research token:

```text
Authorization: Bearer <VELVET_ALCHEMY_RESEARCH_API_KEY>
Content-Type: application/json
```

Synthetic example:

```json
{
  "contractVersion": "velvet-smirk.prospect.v1",
  "workspaceId": 1,
  "externalId": "velvet-prospect-00000001",
  "batch": {
    "externalId": "velvet-reno-plumbers-20260729",
    "name": "Reno Plumbers Review",
    "targetIndustry": "plumbing",
    "targetLocation": "Reno, NV"
  },
  "prospect": {
    "companyName": "Synthetic Plumbing Test",
    "phone": "+17755550142",
    "phoneContactMode": "operator_review_only",
    "email": "owner@example.com",
    "emailVerification": "verified_owner_email",
    "website": "https://example.com/synthetic-plumbing",
    "industry": "plumbing",
    "city": "Reno",
    "state": "NV",
    "score": 75,
    "evidence": [
      {
        "url": "https://example.com/synthetic-plumbing/contact",
        "observation": "Public contact page reviewed for a synthetic test.",
        "observedAt": "2026-07-29T18:00:00.000Z",
        "kind": "contact_path",
        "basis": "observed",
        "confidence": "high"
      }
    ],
    "notes": "Synthetic contract test only."
  }
}
```

`externalId` and `batch.externalId` are opaque integration identifiers, not
public database IDs. The same `externalId` and exact payload returns
`200 DUPLICATE`. Reusing the ID with changed data returns `409`.

Every evidence item must identify its public source, observation time, kind,
basis, and confidence. `observed` means a public record or page value was
recorded, `measured` requires an actual measurement, and `inferred` identifies
a review judgment such as a screenshot usability observation. SMIRK rejects
unclassified evidence instead of treating every audit statement as fact.

Contact fields also carry provenance. `email` is valid only when paired with
`emailVerification: "verified_owner_email"`. `phone` is valid only when paired
with `phoneContactMode: "operator_review_only"`. That mode supports a reviewed
manual call brief only; it never permits SMS or automated dialing.

## Responses

New import:

```json
{
  "ok": true,
  "state": "IMPORTED",
  "campaignId": 17,
  "prospectId": 23,
  "externalAction": "none"
}
```

Idempotent replay:

```json
{
  "ok": true,
  "state": "DUPLICATE",
  "campaignId": 17,
  "prospectId": 23,
  "externalAction": "none"
}
```

`IMPORTED` means the prospect is visible in SMIRK's review queue. It does not
mean approved, contacted, queued for contact, or sent.

## Activation Sequence

1. Review the startup DDL, approve a database backup, and approve the exact
   SMIRK commit. `initProspectorSchema` runs during service startup, so this is
   not a code-only deploy.
2. Deploy the receiver only after that combined approval.
3. Generate a new dedicated research token.
4. Configure the token and target workspace in both systems.
5. Submit one synthetic prospect.
6. Verify `IMPORTED`, review-queue visibility, hard-refresh persistence, and
   `DUPLICATE` replay behavior.
7. Confirm that no contact, call, task, or handoff record was created.
8. Only then import one real researched prospect for human review.

No outreach approval is implied by any step in this sequence.
