import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProspectMessageContext,
  findMatchingProspectMessageVariant,
  getDefaultProspectMessageVariantKey,
  getProspectMessageVariantDefinitions,
  renderProspectMessageVariant,
} from "../src/prospect-message-variants.ts";
import { prepareProspectOutreachSchema } from "../src/prospect-outreach.ts";

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

test("registered email strategies render distinct truth-safe copy", () => {
  const first = renderProspectMessageVariant("owner-language-v1", context);
  const second = renderProspectMessageVariant("owner-language-v2", context);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.channel, "email");
  assert.equal(second.channel, "email");
  assert.notEqual(first.subject, second.subject);
  assert.notEqual(first.content, second.content);
  for (const rendered of [first, second]) {
    const parsed = prepareProspectOutreachSchema.safeParse({
      channel: "email",
      subject: rendered.subject,
      body: rendered.content,
      emailCompliance: {
        senderIdentity: "SMIRK",
        advertisementDisclosure: "This is a commercial message from SMIRK.",
        physicalPostalAddress: "1605 McKinley Drive, Reno, NV 89509",
        optOutInstructions:
          "If this is not relevant, reply no and I will not follow up.",
      },
      variantKey: rendered.key,
      maxCostCents: 2,
      expiresInHours: 24,
    });
    assert.equal(parsed.success, true);
  }
});

test("registered call strategies are manual-dial-only and distinct", () => {
  const first = renderProspectMessageVariant("manual-owner-call-v1", context);
  const second = renderProspectMessageVariant("manual-owner-call-v2", context);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.channel, "call");
  assert.equal(second.channel, "call");
  assert.notEqual(first.content, second.content);
  assert.match(first.content, /operator must dial manually/i);
  assert.match(second.content, /operator must dial manually/i);
  assert.equal(
    prepareProspectOutreachSchema.safeParse({
      channel: "call",
      callBrief: second.content,
      variantKey: second.key,
      maxCostCents: 50,
      expiresInHours: 8,
    }).success,
    true
  );
});

test("actual rendered content determines the measured strategy", () => {
  const rendered = renderProspectMessageVariant("owner-language-v2", context);
  assert.ok(rendered);
  assert.equal(
    findMatchingProspectMessageVariant({
      channel: "email",
      subject: rendered.subject,
      content: rendered.content,
      context,
    })?.key,
    "owner-language-v2"
  );
  assert.equal(
    findMatchingProspectMessageVariant({
      channel: "email",
      subject: rendered.subject,
      content: `${rendered.content}\nOperator edit.`,
      context,
    }),
    null
  );
});

test("unsafe source language is excluded from rendered copy", () => {
  const unsafeContext = buildProspectMessageContext({
    businessName: "Synthetic Trade Demo",
    industry: "HVAC",
    researchEvidence: [
      {
        kind: "contact_path",
        basis: "observed",
        observation: "You are losing money from every call.",
      },
    ],
  });
  assert.equal(unsafeContext.evidenceObservation, null);
  const rendered = renderProspectMessageVariant(
    getDefaultProspectMessageVariantKey("email"),
    unsafeContext
  );
  assert.ok(rendered);
  assert.doesNotMatch(rendered.content, /losing money/i);
});

test("inferred evidence remains review-only and is not phrased as observed", () => {
  const inferredContext = buildProspectMessageContext({
    businessName: "Synthetic Trade Demo",
    industry: "HVAC",
    researchEvidence: [
      {
        kind: "visual_usability",
        basis: "inferred",
        observation:
          "Screenshot review inference: the booking path may create friction.",
      },
    ],
  });
  assert.equal(inferredContext.evidenceObservation, null);
  const rendered = renderProspectMessageVariant(
    "owner-language-v2",
    inferredContext
  );
  assert.ok(rendered);
  assert.doesNotMatch(rendered.content, /booking path may create friction/i);
});

test("the registry has measured long-form and transparent micro email strategies", () => {
  assert.equal(getProspectMessageVariantDefinitions("email").length, 5);
  assert.equal(getProspectMessageVariantDefinitions("call").length, 2);
  assert.equal(
    getDefaultProspectMessageVariantKey("email"),
    "owner-language-v1"
  );
  assert.equal(
    getDefaultProspectMessageVariantKey("call"),
    "manual-owner-call-v1"
  );
});
