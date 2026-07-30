import assert from "node:assert/strict";
import test from "node:test";
import {
  PROSPECT_INBOX_PLACEMENT_PREPARE_CONFIRMATION,
  buildProspectInboxPlacementDefinition,
  buildProspectInboxPlacementReceipt,
  assertProspectInboxPlacementAllowlist,
  hashProspectInboxPlacementValue,
  prepareProspectInboxPlacementSchema,
  readProspectInboxPlacementConfig,
  type ProspectInboxPlacementEvaluationItem,
} from "../src/prospect-inbox-placement.ts";

const preparedAt = "2026-07-30T18:00:00.000Z";
const testId = "11111111-1111-4111-8111-111111111111";
const baseInput = {
  campaignId: 7,
  controlVariantKey: "micro-after-hours-v1",
  challengerVariantKey: "micro-weekend-work-v1",
  mailboxes: [
    {
      label: "Google seed 1",
      provider: "google_workspace" as const,
      email: "google-one@example.invalid",
    },
    {
      label: "Microsoft seed 1",
      provider: "microsoft_365" as const,
      email: "microsoft-one@example.invalid",
    },
    {
      label: "Google seed 2",
      provider: "google_workspace" as const,
      email: "google-two@example.invalid",
    },
    {
      label: "Microsoft seed 2",
      provider: "microsoft_365" as const,
      email: "microsoft-two@example.invalid",
    },
    {
      label: "Yahoo seed",
      provider: "yahoo_aol" as const,
      email: "yahoo-one@example.invalid",
    },
  ],
  emailCompliance: {
    senderIdentity: "SMIRK",
    advertisementDisclosure: "This is a commercial message from SMIRK.",
    physicalPostalAddress: "1605 McKinley Drive, Reno, NV 89509",
    optOutInstructions:
      "Reply stop if you do not want another commercial email.",
  },
  maxCostCents: 2,
  expiresInHours: 72,
  confirmation: PROSPECT_INBOX_PLACEMENT_PREPARE_CONFIRMATION,
  attestations: {
    controlledMailboxesOnly: true as const,
    mailboxAccessVerified: true as const,
    noRealProspectsIncluded: true as const,
    noContactOrSpendAuthorized: true as const,
  },
};

function buildItems(
  definition: ReturnType<
    typeof buildProspectInboxPlacementDefinition
  >,
  overrides?: Partial<
    ProspectInboxPlacementEvaluationItem["inspection"] extends infer T
      ? NonNullable<T>
      : never
  >
): ProspectInboxPlacementEvaluationItem[] {
  return definition.mailboxes.map((mailbox) => {
    const providerMessageId = `provider-${mailbox.slot}`;
    const inspection = {
      definitionHash: hashProspectInboxPlacementValue(definition),
      payloadHash: String(mailbox.slot).repeat(64),
      providerMessageId,
      inspectedAt: "2026-07-30T19:00:00.000Z",
      folder: "primary" as const,
      smtpAccepted: true,
      spf: "PASS" as const,
      dkim: "PASS" as const,
      dmarc: "PASS" as const,
      fromAligned: true,
      plainTextOnly: true,
      trackingPixelAbsent: true,
      unexpectedLinksAbsent: true,
      complianceFooterRendered: true,
      confirmation:
        "record-one-controlled-inbox-inspection-v1" as const,
      attestations: {
        mailboxOpenedByOperator: true as const,
        folderLocationObserved: true as const,
        rawHeadersReviewed: true as const,
      },
      ...overrides,
    };
    return {
      slot: mailbox.slot,
      label: mailbox.label,
      provider: mailbox.provider,
      approvalId: `00000000-0000-4000-8000-${String(
        mailbox.slot
      ).padStart(12, "0")}`,
      payloadHash: inspection.payloadHash,
      jobState: "SENT",
      storedProviderMessageId: providerMessageId,
      inspection,
      inspectionHash: hashProspectInboxPlacementValue(inspection),
    };
  });
}

test("controlled inbox preparation requires the exact 2/2/1 provider array", () => {
  assert.equal(
    prepareProspectInboxPlacementSchema.safeParse(baseInput).success,
    true
  );
  const wrongDistribution = {
    ...baseInput,
    mailboxes: baseInput.mailboxes.map((mailbox) => ({
      ...mailbox,
      provider: "google_workspace",
    })),
  };
  assert.equal(
    prepareProspectInboxPlacementSchema.safeParse(wrongDistribution)
      .success,
    false
  );
});

test("the exact five-address environment allowlist is hash-bound", () => {
  const config = readProspectInboxPlacementConfig({
    PROSPECT_INBOX_SEED_ALLOWLIST: baseInput.mailboxes
      .map((mailbox) => mailbox.email)
      .join(","),
  });
  assert.equal(config.configured, true);
  assert.equal(config.recipientHashes.length, 5);
  assert.doesNotThrow(() =>
    assertProspectInboxPlacementAllowlist({
      config,
      recipients: baseInput.mailboxes
        .slice()
        .reverse()
        .map((mailbox) => mailbox.email),
    })
  );
  assert.throws(
    () =>
      assertProspectInboxPlacementAllowlist({
        config,
        recipients: [
          ...baseInput.mailboxes.slice(0, 4).map((mailbox) => mailbox.email),
          "unknown@example.invalid",
        ],
      }),
    /do not match/
  );
});

test("the immutable definition hashes recipients and assigns a 3/2 seed split", () => {
  const parsed = prepareProspectInboxPlacementSchema.parse(baseInput);
  const definition = buildProspectInboxPlacementDefinition({
    testId,
    workspaceId: 1,
    preparedAt,
    data: parsed,
  });
  assert.deepEqual(
    definition.mailboxes.map((mailbox) => mailbox.assignedVariantKey),
    [
      "micro-after-hours-v1",
      "micro-weekend-work-v1",
      "micro-after-hours-v1",
      "micro-weekend-work-v1",
      "micro-after-hours-v1",
    ]
  );
  assert.equal(
    JSON.stringify(definition).includes("google-one@example.invalid"),
    false
  );
  assert.equal(definition.contactAuthorized, false);
  assert.equal(definition.spendAuthorized, false);
});

test("all five primary placements and authentication checks produce one bounded PASS", () => {
  const definition = buildProspectInboxPlacementDefinition({
    testId,
    workspaceId: 1,
    preparedAt,
    data: prepareProspectInboxPlacementSchema.parse(baseInput),
  });
  const definitionHash = hashProspectInboxPlacementValue(definition);
  const receipt = buildProspectInboxPlacementReceipt({
    definition,
    definitionHash,
    finalizedAt: "2026-07-30T20:00:00.000Z",
    items: buildItems(definition),
  });
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.authorizesExperimentActivation, true);
  assert.equal(receipt.authorizesContact, false);
  assert.equal(receipt.authorizesSpend, false);
  assert.equal(receipt.itemReceipts.length, 5);
});

test("spam placement, missing authentication, or message-ID drift fail closed", () => {
  const definition = buildProspectInboxPlacementDefinition({
    testId,
    workspaceId: 1,
    preparedAt,
    data: prepareProspectInboxPlacementSchema.parse(baseInput),
  });
  const definitionHash = hashProspectInboxPlacementValue(definition);
  const items = buildItems(definition);
  items[0].inspection = {
    ...items[0].inspection!,
    folder: "spam",
    dmarc: "FAIL",
    providerMessageId: "different-message",
  };
  items[0].inspectionHash = hashProspectInboxPlacementValue(
    items[0].inspection
  );
  const receipt = buildProspectInboxPlacementReceipt({
    definition,
    definitionHash,
    finalizedAt: "2026-07-30T20:00:00.000Z",
    items,
  });
  assert.equal(receipt.verdict, "FAIL");
  assert.equal(receipt.authorizesExperimentActivation, false);
  assert.match(receipt.failureReasons.join(" "), /spam/);
  assert.match(receipt.failureReasons.join(" "), /DMARC/);
  assert.match(receipt.failureReasons.join(" "), /message ID/);
});
