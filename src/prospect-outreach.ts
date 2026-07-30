import { createHash } from "node:crypto";
import { z } from "zod";
import {
  prospectMessageExperimentAssignmentSchema,
  type ProspectMessageExperimentAssignment,
} from "./prospect-message-experiments.js";
import type { ProspectMessageContext } from "./prospect-message-variants.js";
import {
  assertProspectQcApprovalEligible,
  buildProspectQcReceipt,
  containsUnsupportedBusinessOutcomeClaim,
  hashProspectQcDraft,
  prospectQcReceiptSchema,
  type ProspectQcModelReview,
  type ProspectQcReceipt,
} from "./prospect-qc.js";

export const PROSPECT_OUTREACH_CONTRACT_VERSION =
  "smirk.prospect-outreach.v2" as const;
export const PROSPECT_MANUAL_CALL_RECORD_CONFIRMATION =
  "record-one-manual-call-v1" as const;

export const PROSPECT_OUTREACH_STATES = [
  "PREPARED",
  "APPROVED",
  "SENDING",
  "SENT",
  "FAILED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
] as const;

export type ProspectOutreachState =
  (typeof PROSPECT_OUTREACH_STATES)[number];
export type ProspectOutreachChannel = "email" | "call";

const copyWithNoUnsupportedOutcomeClaims = z
  .string()
  .trim()
  .min(20)
  .max(5_000)
  .superRefine((value, ctx) => {
    if (containsUnsupportedBusinessOutcomeClaim(value)) {
      ctx.addIssue({
        code: "custom",
        message:
          "Draft copy contains an unsupported business-outcome claim.",
      });
    }
  });

const emailComplianceSchema = z
  .object({
    senderIdentity: z.string().trim().min(2).max(160),
    advertisementDisclosure: z.string().trim().min(10).max(500),
    physicalPostalAddress: z.string().trim().min(10).max(500),
    optOutInstructions: z.string().trim().min(10).max(500),
  })
  .strict();

export const prepareProspectOutreachSchema = z.discriminatedUnion("channel", [
  z
    .object({
      channel: z.literal("email"),
      subject: z.string().trim().min(3).max(160),
      body: copyWithNoUnsupportedOutcomeClaims,
      emailCompliance: emailComplianceSchema,
      variantKey: z
        .string()
        .trim()
        .min(2)
        .max(64)
        .regex(/^[A-Za-z0-9:_-]+$/)
        .default("operator-v1"),
      maxCostCents: z.number().int().min(0).max(5).default(2),
      expiresInHours: z.number().int().min(1).max(72).default(24),
    })
    .strict(),
  z
    .object({
      channel: z.literal("call"),
      callBrief: copyWithNoUnsupportedOutcomeClaims,
      variantKey: z
        .string()
        .trim()
        .min(2)
        .max(64)
        .regex(/^[A-Za-z0-9:_-]+$/)
        .default("operator-v1"),
      maxCostCents: z.number().int().min(1).max(100),
      expiresInHours: z.number().int().min(1).max(24).default(8),
    })
    .strict(),
]);

export type PrepareProspectOutreachInput = z.input<
  typeof prepareProspectOutreachSchema
>;

const emailControlSchema = z
  .object({
    channel: z.literal("email"),
    verifiedRecipientRequired: z.literal(true),
    suppressionCheckRequired: z.literal(true),
    truthfulSenderIdentityRequired: z.literal(true),
    advertisementDisclosureIncluded: z.literal(true),
    physicalPostalAddressIncluded: z.literal(true),
    optOutInstructionsIncluded: z.literal(true),
    automatedSending: z.literal(false),
  })
  .strict();

const callControlSchema = z
  .object({
    channel: z.literal("call"),
    businessNumberReviewRequired: z.literal(true),
    doNotCallCheckRequired: z.literal(true),
    callingWindowCheckRequired: z.literal(true),
    automatedDialing: z.literal(false),
  })
  .strict();

export const prospectOutreachPayloadSchema = z
  .object({
    contractVersion: z.literal(PROSPECT_OUTREACH_CONTRACT_VERSION),
    workspaceId: z.number().int().positive(),
    campaignId: z.number().int().positive(),
    prospectId: z.number().int().positive(),
    channel: z.enum(["email", "call"]),
    recipient: z.string().trim().min(3).max(320),
    subject: z.string().trim().min(3).max(160).optional(),
    content: copyWithNoUnsupportedOutcomeClaims,
    variantKey: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    maxCostCents: z.number().int().min(0).max(100),
    preparedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    emailCompliance: emailComplianceSchema.optional(),
    qcReceipt: prospectQcReceiptSchema.optional(),
    experimentAssignment:
      prospectMessageExperimentAssignmentSchema.optional(),
    controls: z
      .object({
        recipientSpecific: z.literal(true),
        bulkExecution: z.literal(false),
        smsAllowed: z.literal(false),
        providerExecution: z.enum([
          "operator-triggered-single-recipient",
          "disabled",
        ]),
        humanApprovalRequired: z.literal(true),
        compliance: z.discriminatedUnion("channel", [
          emailControlSchema,
          callControlSchema,
        ]),
      })
      .strict(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (
      payload.channel === "email" &&
      (!payload.subject ||
        !payload.emailCompliance ||
        payload.controls.providerExecution !==
          "operator-triggered-single-recipient" ||
        payload.controls.compliance.channel !== "email")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "An email payload requires exact email controls and compliance.",
      });
    }
    if (
      payload.channel === "call" &&
      (payload.subject ||
        payload.emailCompliance ||
        payload.controls.providerExecution !== "disabled" ||
        payload.controls.compliance.channel !== "call")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A call payload cannot enable provider execution.",
      });
    }
    if (payload.qcReceipt) {
      if (
        payload.qcReceipt.channel !== payload.channel ||
        payload.qcReceipt.variantKey !== payload.variantKey ||
        payload.qcReceipt.evidenceHash !== payload.evidenceHash
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "The QC receipt must match the payload channel, variant, and evidence.",
        });
      }
      let auditedContent = payload.content;
      if (payload.channel === "email" && payload.emailCompliance) {
        const complianceSuffix = [
          payload.emailCompliance.advertisementDisclosure,
          payload.emailCompliance.senderIdentity,
          payload.emailCompliance.physicalPostalAddress,
          payload.emailCompliance.optOutInstructions,
        ].join("\n\n");
        const suffixWithSeparator = `\n\n${complianceSuffix}`;
        if (!payload.content.endsWith(suffixWithSeparator)) {
          ctx.addIssue({
            code: "custom",
            message:
              "The email payload must end with the exact QC-reviewed compliance footer.",
          });
        } else {
          auditedContent = payload.content.slice(
            0,
            -suffixWithSeparator.length
          );
        }
      }
      if (
        payload.qcReceipt.draftHash !==
        hashProspectQcDraft({
          channel: payload.channel,
          subject: payload.subject,
          content: auditedContent,
        })
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "The QC receipt draft hash does not match the immutable payload copy.",
        });
      }
    }
  });

export type ProspectOutreachPayload = z.infer<
  typeof prospectOutreachPayloadSchema
>;

export const prospectOutreachApprovalSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    attestations: z
      .object({
        recipientReviewed: z.literal(true),
        suppressionChecked: z.literal(true),
        emailComplianceReviewed: z.boolean().optional(),
        qcAdvisoryFlagsReviewed: z.boolean().optional(),
        doNotCallChecked: z.boolean().optional(),
        callingWindowChecked: z.boolean().optional(),
        manualDialOnly: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export type ProspectOutreachApproval = z.infer<
  typeof prospectOutreachApprovalSchema
>;

export function assertProspectOutreachApprovalAttestations(
  channel: ProspectOutreachChannel,
  approval: ProspectOutreachApproval,
  qcReceipt?: ProspectQcReceipt
): void {
  if (qcReceipt) {
    assertProspectQcApprovalEligible(qcReceipt);
    if (
      ["FLAGGED", "ERROR"].includes(qcReceipt.modelReview.status) &&
      approval.attestations.qcAdvisoryFlagsReviewed !== true
    ) {
      throw new Error(
        "Advisory QC flags require explicit human review before approval."
      );
    }
  }
  if (channel === "email" && approval.attestations.emailComplianceReviewed !== true) {
    throw new Error(
      "Email approval requires confirmation of sender identity, postal address, and opt-out instructions."
    );
  }
  if (
    channel === "call" &&
    (approval.attestations.doNotCallChecked !== true ||
      approval.attestations.callingWindowChecked !== true ||
      approval.attestations.manualDialOnly !== true)
  ) {
    throw new Error(
      "Call approval requires do-not-call, calling-window, and manual-dial attestations."
    );
  }
}

const E164_PHONE = /^\+[1-9]\d{7,14}$/;

export function normalizeProspectOutreachRecipient(
  channel: ProspectOutreachChannel,
  raw: string | null | undefined
): string {
  const value = String(raw || "").trim();
  if (channel === "email") {
    const email = value.toLowerCase();
    if (
      email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      throw new Error(
        "A verified recipient email is required for an email draft."
      );
    }
    return email;
  }

  if (E164_PHONE.test(value)) return value;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  throw new Error(
    "An unambiguous E.164 business phone is required for a call brief."
  );
}

function parseIsoDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Outreach timestamps must be valid ISO dates.");
  }
  return parsed;
}

export function buildProspectOutreachPayload(input: {
  workspaceId: number;
  campaignId: number;
  prospectId: number;
  recipient: string;
  evidenceHash: string;
  preparedAt: string;
  draft: PrepareProspectOutreachInput;
  qcContext: ProspectMessageContext;
  qcModelReview?: ProspectQcModelReview;
  experimentAssignment?: ProspectMessageExperimentAssignment;
}): ProspectOutreachPayload {
  const draft = prepareProspectOutreachSchema.parse(input.draft);
  for (const [name, value] of [
    ["workspaceId", input.workspaceId],
    ["campaignId", input.campaignId],
    ["prospectId", input.prospectId],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(input.evidenceHash)) {
    throw new Error("A SHA-256 evidence hash is required.");
  }

  const preparedAt = parseIsoDate(input.preparedAt);
  const expiresAt = new Date(
    preparedAt.getTime() + draft.expiresInHours * 60 * 60_000
  );
  const recipient = normalizeProspectOutreachRecipient(
    draft.channel,
    input.recipient
  );
  const qcReceipt = buildProspectQcReceipt({
    draft,
    context: input.qcContext,
    evidenceHash: input.evidenceHash,
    evaluatedAt: preparedAt.toISOString(),
    modelReview: input.qcModelReview,
  });
  assertProspectQcApprovalEligible(qcReceipt);
  const content =
    draft.channel === "email"
      ? [
          draft.body.trim(),
          draft.emailCompliance.advertisementDisclosure,
          draft.emailCompliance.senderIdentity,
          draft.emailCompliance.physicalPostalAddress,
          draft.emailCompliance.optOutInstructions,
        ].join("\n\n")
      : draft.callBrief;

  return prospectOutreachPayloadSchema.parse({
    contractVersion: PROSPECT_OUTREACH_CONTRACT_VERSION,
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    prospectId: input.prospectId,
    channel: draft.channel,
    recipient,
    subject: draft.channel === "email" ? draft.subject : undefined,
    content,
    variantKey: draft.variantKey,
    evidenceHash: input.evidenceHash,
    maxCostCents: draft.maxCostCents,
    preparedAt: preparedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    emailCompliance:
      draft.channel === "email" ? draft.emailCompliance : undefined,
    qcReceipt,
    experimentAssignment: input.experimentAssignment,
    controls: {
      recipientSpecific: true,
      bulkExecution: false,
      smsAllowed: false,
      providerExecution:
        draft.channel === "email"
          ? "operator-triggered-single-recipient"
          : "disabled",
      humanApprovalRequired: true,
      compliance:
        draft.channel === "email"
          ? {
              channel: "email",
              verifiedRecipientRequired: true,
              suppressionCheckRequired: true,
              truthfulSenderIdentityRequired: true,
              advertisementDisclosureIncluded: true,
              physicalPostalAddressIncluded: true,
              optOutInstructionsIncluded: true,
              automatedSending: false,
            }
          : {
              channel: "call",
              businessNumberReviewRequired: true,
              doNotCallCheckRequired: true,
              callingWindowCheckRequired: true,
              automatedDialing: false,
            },
    },
  });
}

export function hashProspectOutreachPayload(
  payload: ProspectOutreachPayload
): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function hashProspectEvidence(evidence: readonly unknown[]): string {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error("At least one source-classified evidence item is required.");
  }
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

const allowedTransitions: Record<
  ProspectOutreachState,
  ProspectOutreachState[]
> = {
  PREPARED: ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED"],
  APPROVED: ["SENDING", "SENT", "EXPIRED", "CANCELLED"],
  SENDING: ["SENT", "FAILED"],
  SENT: [],
  FAILED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function canTransitionProspectOutreach(
  from: ProspectOutreachState,
  to: ProspectOutreachState
): boolean {
  return allowedTransitions[from].includes(to);
}

export const prospectOutcomeSchema = z
  .object({
    externalEventId: z
      .string()
      .trim()
      .min(12)
      .max(160)
      .regex(/^[A-Za-z0-9:_-]+$/),
    outcome: z.enum([
      "delivered",
      "bounced",
      "replied",
      "qualified",
      "demo_booked",
      "converted",
      "not_interested",
      "dnc",
      "call_connected",
      "voicemail",
      "no_answer",
      "failed",
    ]),
    occurredAt: z.string().datetime({ offset: true }),
    outreachApprovalId: z.string().uuid().optional(),
    notes: z.string().trim().max(2_000).optional(),
  })
  .strict();

export type ProspectOutcomeInput = z.infer<typeof prospectOutcomeSchema>;

export function assertProspectOutcomeMatchesChannel(
  channel: ProspectOutreachChannel,
  outcome: ProspectOutcomeInput["outcome"]
): void {
  const shared = [
    "qualified",
    "demo_booked",
    "converted",
    "not_interested",
    "dnc",
    "failed",
  ];
  const allowed =
    channel === "email"
      ? ["delivered", "bounced", "replied", ...shared]
      : ["call_connected", "voicemail", "no_answer", ...shared];
  if (!allowed.includes(outcome)) {
    throw new Error(
      `Outcome ${outcome} is not valid for an ${channel} outreach job.`
    );
  }
}

export function assertRecordedExecutionWindow(input: {
  occurredAt: string;
  approvedAt: string | Date;
  expiresAt: string | Date;
  now?: Date;
}): void {
  const occurredAt = new Date(input.occurredAt);
  const approvedAt = new Date(input.approvedAt);
  const expiresAt = new Date(input.expiresAt);
  const now = input.now || new Date();
  if (
    !Number.isFinite(occurredAt.getTime()) ||
    !Number.isFinite(approvedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime())
  ) {
    throw new Error("Execution timing could not be verified.");
  }
  if (occurredAt.getTime() < approvedAt.getTime()) {
    throw new Error("The external action cannot predate approval.");
  }
  if (occurredAt.getTime() > expiresAt.getTime()) {
    throw new Error("The external action occurred after approval expired.");
  }
  if (occurredAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new Error("The external action cannot be future dated.");
  }
}

export function isValidExecutionProofReference(value: string): boolean {
  return /^(manual|provider):[A-Za-z0-9][A-Za-z0-9:._/-]{6,480}$/.test(
    value.trim()
  );
}

export function isExactRecordedExecutionReplay(
  stored: {
    sentAt: string | Date | null;
    proofReference: string | null;
  },
  expected: {
    occurredAt: string;
    proofReference: string;
  }
): boolean {
  if (!stored.sentAt) return false;
  const storedTime = new Date(stored.sentAt);
  const expectedTime = new Date(expected.occurredAt);
  return (
    Number.isFinite(storedTime.getTime()) &&
    Number.isFinite(expectedTime.getTime()) &&
    storedTime.toISOString() === expectedTime.toISOString() &&
    String(stored.proofReference || "") === expected.proofReference
  );
}

export function isExactProspectOutcomeReplay(
  stored: {
    lead_id: number;
    outreach_job_id: number | null;
    outcome: string;
    occurred_at: string | Date;
    notes: string | null;
  },
  expected: {
    leadId: number;
    outreachJobId: number | null;
    outcome: ProspectOutcomeInput["outcome"];
    occurredAt: string;
    notes?: string;
  }
): boolean {
  const storedTime = new Date(stored.occurred_at);
  const expectedTime = new Date(expected.occurredAt);
  return (
    Number(stored.lead_id) === expected.leadId &&
    (stored.outreach_job_id === null
      ? expected.outreachJobId === null
      : Number(stored.outreach_job_id) === expected.outreachJobId) &&
    stored.outcome === expected.outcome &&
    Number.isFinite(storedTime.getTime()) &&
    Number.isFinite(expectedTime.getTime()) &&
    storedTime.toISOString() === expectedTime.toISOString() &&
    String(stored.notes || "") === String(expected.notes || "")
  );
}

export function outcomeToProspectStatus(
  outcome: ProspectOutcomeInput["outcome"]
):
  | "pending"
  | "interested"
  | "not_interested"
  | "voicemail"
  | "dnc"
  | "no_answer"
  | "contacted"
  | "converted" {
  switch (outcome) {
    case "converted":
      return "converted";
    case "qualified":
    case "demo_booked":
      return "interested";
    case "not_interested":
      return "not_interested";
    case "dnc":
      return "dnc";
    case "voicemail":
      return "voicemail";
    case "no_answer":
      return "no_answer";
    case "delivered":
    case "replied":
    case "call_connected":
      return "contacted";
    case "bounced":
    case "failed":
      return "pending";
  }
}
