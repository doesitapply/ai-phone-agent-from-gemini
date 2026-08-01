import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProspectOutreachApprovalAttestations,
  prepareProspectOutreachSchema,
  prospectOutreachApprovalSchema,
} from "../src/prospect-outreach.ts";
import {
  buildProspectMessageContext,
  renderProspectMessageVariant,
} from "../src/prospect-message-variants.ts";
import {
  buildProspectQcModelReview,
  buildProspectQcReceipt,
  prospectQcReceiptSchema,
} from "../src/prospect-qc.ts";

const evaluatedAt = "2026-07-30T16:00:00.000Z";
const evidenceHash = "e".repeat(64);
const emailCompliance = {
  senderIdentity: "SMIRK",
  advertisementDisclosure: "This is a commercial message from SMIRK.",
  physicalPostalAddress: "1605 McKinley Drive, Reno, NV 89509",
  optOutInstructions:
    "If this is not relevant, reply no and I will not follow up.",
};
const context = buildProspectMessageContext({
  businessName: "Silver State Home Services Demo",
  industry: "plumbing",
  researchEvidence: [
    {
      kind: "contact_path",
      basis: "observed",
      observation: "The public page offers emergency service contact.",
    },
  ],
});

function emailDraft(input: {
  subject?: string;
  body?: string;
  variantKey?: string;
}) {
  return prepareProspectOutreachSchema.parse({
    channel: "email",
    subject: input.subject || "Synthetic subject",
    body:
      input.body ||
      "Cameron with SMIRK. This is a synthetic review-only email draft.",
    emailCompliance,
    variantKey: input.variantKey || "operator-v1",
    maxCostCents: 2,
    expiresInHours: 24,
  });
}

test("transparent micro variants pass deterministic QC without authorizing contact", () => {
  for (const key of [
    "micro-after-hours-v1",
    "micro-urgent-workflow-v1",
    "micro-weekend-work-v1",
  ]) {
    const rendered = renderProspectMessageVariant(key, context);
    assert.ok(rendered?.subject);
    const receipt = buildProspectQcReceipt({
      draft: emailDraft({
        subject: rendered.subject,
        body: rendered.content,
        variantKey: key,
      }),
      context,
      evidenceHash,
      evaluatedAt,
    });
    assert.equal(receipt.verdict, "ELIGIBLE_FOR_HUMAN_APPROVAL");
    assert.match(receipt.receiptId, /^qcr_[a-f0-9]{24}$/);
    assert.equal(receipt.deterministicPassed, true);
    assert.equal(receipt.contactAuthorized, false);
    assert.equal(receipt.executionAuthorized, false);
    assert.equal(receipt.automatedSendingAuthorized, false);
    assert.equal(receipt.automatedDialingAuthorized, false);
    assert.equal(receipt.modelReview.status, "NOT_RUN");
    assert.match(
      receipt.ruleResults.find(
        (rule) => rule.code === "MICRO_TOUCH_TRANSPARENT"
      )?.detail || "",
      /\d+ words/
    );
  }
});

test("unresolved placeholders and deceptive anonymous micro copy require revision", () => {
  const receipt = buildProspectQcReceipt({
    draft: emailDraft({
      subject: "quick question [Company]",
      body:
        "Hi {{first_name}} - do you have someone answering calls after 5 PM, or does everything go to voicemail?",
      variantKey: "micro-after-hours-v1",
    }),
    context,
    evidenceHash,
    evaluatedAt,
  });
  assert.equal(receipt.verdict, "REVISION_REQUIRED");
  assert.equal(receipt.deterministicPassed, false);
  assert.match(receipt.failureReasons.join("\n"), /PLACEHOLDERS_RESOLVED/);
  assert.match(
    receipt.failureReasons.join("\n"),
    /MICRO_TOUCH_TRANSPARENT/
  );
});

test("unsupported claims, ungrounded observations, and industry mismatch fail closed", () => {
  const claims = buildProspectQcReceipt({
    draft: {
      channel: "email",
      subject: "Synthetic subject",
      body:
        "Cameron with SMIRK. I noticed your electrical website is costing you money and urgently needs repairs.",
      emailCompliance,
      variantKey: "operator-v1",
      maxCostCents: 2,
      expiresInHours: 24,
    },
    context,
    evidenceHash,
    evaluatedAt,
  });
  assert.equal(claims.verdict, "REVISION_REQUIRED");
  assert.match(claims.failureReasons.join("\n"), /OUTCOME_CLAIMS_SUPPORTED/);
  assert.match(claims.failureReasons.join("\n"), /SOURCE_CLAIMS_GROUNDED/);
  assert.match(claims.failureReasons.join("\n"), /INDUSTRY_ALIGNED/);
});

test("spam phrases, excessive punctuation, and extra links fail deterministic QC", () => {
  const receipt = buildProspectQcReceipt({
    draft: emailDraft({
      body:
        "Cameron with SMIRK. ACT NOW!! Get 100% free results at https://example.invalid/a and https://example.invalid/b",
    }),
    context,
    evidenceHash,
    evaluatedAt,
  });
  assert.equal(receipt.verdict, "REVISION_REQUIRED");
  assert.match(receipt.failureReasons.join("\n"), /SPAM_LANGUAGE_BOUNDED/);
  assert.match(receipt.failureReasons.join("\n"), /LINK_COUNT_BOUNDED/);
});

test("bare www links cannot bypass the zero-link micro-touch rule", () => {
  const receipt = buildProspectQcReceipt({
    draft: emailDraft({
      body:
        "Cameron with SMIRK. Quick operational question. Details are at www.example.invalid/demo",
      variantKey: "micro-after-hours-v1",
    }),
    context,
    evidenceHash,
    evaluatedAt,
  });
  assert.equal(receipt.verdict, "REVISION_REQUIRED");
  assert.match(receipt.failureReasons.join("\n"), /LINK_COUNT_BOUNDED/);
});

test("HTML and tracking artifacts fail before human approval", () => {
  for (const body of [
    'Cameron with SMIRK. <img src="https://track.example.invalid/open?id=1" width="1" height="1">',
    "Cameron with SMIRK. [See details](https://example.invalid/?utm_source=outreach)",
    "Cameron with SMIRK. Embedded image data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP",
    "Cameron with SMIRK. <strong>Plain text only</strong>",
  ]) {
    const receipt = buildProspectQcReceipt({
      draft: emailDraft({ body }),
      context,
      evidenceHash,
      evaluatedAt,
    });
    assert.equal(receipt.verdict, "REVISION_REQUIRED");
    assert.match(
      receipt.failureReasons.join("\n"),
      /PLAIN_TEXT_NO_TRACKING/
    );
    assert.equal(receipt.contactAuthorized, false);
    assert.equal(receipt.executionAuthorized, false);
  }
});

test("a QC receipt cannot omit rules or forge its version, ID, or prompt hash", () => {
  const receipt = buildProspectQcReceipt({
    draft: emailDraft({}),
    context,
    evidenceHash,
    evaluatedAt,
  });
  assert.throws(() =>
    prospectQcReceiptSchema.parse({
      ...receipt,
      ruleResults: receipt.ruleResults.filter(
        (rule) => rule.code !== "PLAIN_TEXT_NO_TRACKING"
      ),
    })
  );
  assert.throws(() =>
    prospectQcReceiptSchema.parse({
      ...receipt,
      ruleVersion: "smirk.prospect-qc-rules.2026-08-01",
    })
  );
  assert.throws(() =>
    prospectQcReceiptSchema.parse({
      ...receipt,
      receiptId: `qcr_${"f".repeat(24)}`,
    })
  );
  assert.throws(() =>
    prospectQcReceiptSchema.parse({
      ...receipt,
      modelReview: {
        ...receipt.modelReview,
        promptHash: "f".repeat(64),
      },
    })
  );
});

test("commercial disclosure, postal structure, and opt-out instructions fail independently", () => {
  const receipt = buildProspectQcReceipt({
    draft: {
      channel: "email",
      subject: "Synthetic subject",
      body: "Cameron with SMIRK. This is a synthetic review-only email draft.",
      emailCompliance: {
        senderIdentity: "SMIRK",
        advertisementDisclosure: "An ordinary informational introduction.",
        physicalPostalAddress: "This is not a postal address anywhere",
        optOutInstructions: "Thank you for reading this message.",
      },
      variantKey: "operator-v1",
      maxCostCents: 2,
      expiresInHours: 24,
    },
    context,
    evidenceHash,
    evaluatedAt,
  });
  assert.equal(receipt.verdict, "REVISION_REQUIRED");
  assert.match(receipt.failureReasons.join("\n"), /EMAIL_SENDER_DISCLOSURE_PRESENT/);
  assert.match(receipt.failureReasons.join("\n"), /EMAIL_POSTAL_ADDRESS_PLAUSIBLE/);
  assert.match(receipt.failureReasons.join("\n"), /EMAIL_OPT_OUT_PRESENT/);
});

test("model output is strict, advisory-only, and cannot authorize execution", () => {
  const malformed = buildProspectQcModelReview({
    rawOutput: { pass: true, confidence_score: 2, failure_reasons: [] },
    provider: "synthetic",
    model: "synthetic-qc",
    latencyMs: 12,
    estimatedCostCents: 0,
  });
  assert.equal(malformed.status, "ERROR");
  assert.equal(malformed.authority, "advisory-only");

  const flagged = buildProspectQcModelReview({
    rawOutput: {
      pass: false,
      confidence_score: 0.91,
      failure_reasons: ["The tone may be too aggressive."],
    },
    provider: "synthetic",
    model: "synthetic-qc",
    latencyMs: 12,
    estimatedCostCents: 0,
  });
  const receipt = buildProspectQcReceipt({
    draft: emailDraft({}),
    context,
    evidenceHash,
    evaluatedAt,
    modelReview: flagged,
  });
  assert.equal(receipt.deterministicPassed, true);
  assert.equal(receipt.reviewPriority, "elevated");
  assert.equal(receipt.contactAuthorized, false);
  assert.equal(receipt.executionAuthorized, false);

  const approval = prospectOutreachApprovalSchema.parse({
    payloadHash: "a".repeat(64),
    attestations: {
      recipientReviewed: true,
      suppressionChecked: true,
      emailComplianceReviewed: true,
    },
  });
  assert.throws(() =>
    assertProspectOutreachApprovalAttestations("email", approval, receipt)
  );
  assert.doesNotThrow(() =>
    assertProspectOutreachApprovalAttestations(
      "email",
      {
        ...approval,
        attestations: {
          ...approval.attestations,
          qcAdvisoryFlagsReviewed: true,
        },
      },
      receipt
    )
  );
});

test("call QC never substitutes for volatile DNC, time-window, or manual-dial checks", () => {
  const receipt = buildProspectQcReceipt({
    draft: prepareProspectOutreachSchema.parse({
      channel: "call",
      callBrief:
        "Manual-dial-only brief. Cameron with SMIRK asks one operational question. The operator must dial manually.",
      variantKey: "manual-owner-call-v1",
      maxCostCents: 10,
      expiresInHours: 8,
    }),
    context,
    evidenceHash,
    evaluatedAt,
  });
  assert.equal(receipt.deterministicPassed, true);
  assert.equal(receipt.automatedDialingAuthorized, false);
  assert.match(
    receipt.ruleResults.find(
      (rule) => rule.code === "EXECUTION_REMAINS_HUMAN_GATED"
    )?.detail || "",
    /three-scope DNC evidence, a hash-bound recipient-timezone receipt, and manual dialing remain required/
  );
});
