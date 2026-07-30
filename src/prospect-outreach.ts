import { createHash } from "node:crypto";
import { z } from "zod";

export const PROSPECT_OUTREACH_CONTRACT_VERSION =
  "smirk.prospect-outreach.v1" as const;

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
    const unsupportedClaims = [
      /\byou(?:'re| are) losing (?:money|jobs?|customers?|revenue)\b/i,
      /\blost (?:emergency |service |potential )?(?:jobs?|customers?|leads?|money|revenue|income|profit)\b/i,
      /\bguaranteed revenue\b/i,
      /\bcritical (?:revenue )?leaks?\b/i,
      /\bcosting you\b/i,
      /\bthe \$[\d,.]+ (?:phone )?call you (?:just )?missed\b/i,
    ];
    if (unsupportedClaims.some((pattern) => pattern.test(value))) {
      ctx.addIssue({
        code: "custom",
        message:
          "Draft copy contains an unsupported business-outcome claim.",
      });
    }
  });

export const prepareProspectOutreachSchema = z.discriminatedUnion("channel", [
  z
    .object({
      channel: z.literal("email"),
      subject: z.string().trim().min(3).max(160),
      body: copyWithNoUnsupportedOutcomeClaims,
      emailCompliance: z
        .object({
          senderIdentity: z.string().trim().min(2).max(160),
          physicalPostalAddress: z.string().trim().min(10).max(500),
          optOutInstructions: z.string().trim().min(10).max(500),
        })
        .strict(),
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

export type ProspectOutreachPayload = {
  contractVersion: typeof PROSPECT_OUTREACH_CONTRACT_VERSION;
  workspaceId: number;
  campaignId: number;
  prospectId: number;
  channel: ProspectOutreachChannel;
  recipient: string;
  subject?: string;
  content: string;
  variantKey: string;
  evidenceHash: string;
  maxCostCents: number;
  preparedAt: string;
  expiresAt: string;
  emailCompliance?: {
    senderIdentity: string;
    physicalPostalAddress: string;
    optOutInstructions: string;
  };
  controls: {
    recipientSpecific: true;
    bulkExecution: false;
    smsAllowed: false;
    providerExecution: "disabled";
    humanApprovalRequired: true;
    compliance:
      | {
          channel: "email";
          verifiedRecipientRequired: true;
          suppressionCheckRequired: true;
          truthfulSenderIdentityRequired: true;
          physicalPostalAddressIncluded: true;
          optOutInstructionsIncluded: true;
          automatedSending: false;
        }
      | {
          channel: "call";
          businessNumberReviewRequired: true;
          doNotCallCheckRequired: true;
          callingWindowCheckRequired: true;
          automatedDialing: false;
        };
  };
};

export const prospectOutreachApprovalSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    attestations: z
      .object({
        recipientReviewed: z.literal(true),
        suppressionChecked: z.literal(true),
        emailComplianceReviewed: z.boolean().optional(),
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
  approval: ProspectOutreachApproval
): void {
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
  const content =
    draft.channel === "email"
      ? [
          draft.body.trim(),
          draft.emailCompliance.senderIdentity,
          draft.emailCompliance.physicalPostalAddress,
          draft.emailCompliance.optOutInstructions,
        ].join("\n\n")
      : draft.callBrief;

  return {
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
    controls: {
      recipientSpecific: true,
      bulkExecution: false,
      smsAllowed: false,
      providerExecution: "disabled",
      humanApprovalRequired: true,
      compliance:
        draft.channel === "email"
          ? {
              channel: "email",
              verifiedRecipientRequired: true,
              suppressionCheckRequired: true,
              truthfulSenderIdentityRequired: true,
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
  };
}

export function hashProspectOutreachPayload(
  payload: ProspectOutreachPayload
): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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
