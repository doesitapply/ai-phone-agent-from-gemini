import { createHash } from "node:crypto";
import { z } from "zod";

export const PROSPECT_CALL_COMPLIANCE_CONTRACT =
  "smirk.prospect-call-compliance.v1" as const;
export const PROSPECT_CALL_WINDOW_START_MINUTE = 9 * 60;
export const PROSPECT_CALL_WINDOW_END_MINUTE = 17 * 60;
export const PROSPECT_CALL_COMPLIANCE_MAX_AGE_MS =
  24 * 60 * 60 * 1_000;

const E164_PHONE = /^\+[1-9]\d{7,14}$/;
const dncScopeSchema = z.enum(["federal", "state", "internal"]);

export const prospectCallComplianceEvidenceSchema = z
  .object({
    checkedAt: z.string().datetime({ offset: true }),
    recipientTimezone: z.string().trim().min(3).max(100),
    dncChecks: z
      .array(
        z
          .object({
            scope: dncScopeSchema,
            status: z.literal("clear"),
            source: z.string().trim().min(2).max(160),
            reference: z.string().trim().min(6).max(240),
          })
          .strict()
      )
      .length(3),
  })
  .strict()
  .superRefine((value, ctx) => {
    const scopes = new Set(value.dncChecks.map(check => check.scope));
    for (const scope of dncScopeSchema.options) {
      if (!scopes.has(scope)) {
        ctx.addIssue({
          code: "custom",
          path: ["dncChecks"],
          message: `Missing ${scope} do-not-call evidence.`,
        });
      }
    }
    if (scopes.size !== value.dncChecks.length) {
      ctx.addIssue({
        code: "custom",
        path: ["dncChecks"],
        message: "Do-not-call evidence scopes must be unique.",
      });
    }
  });

export type ProspectCallComplianceEvidence = z.infer<
  typeof prospectCallComplianceEvidenceSchema
>;

export const prospectCallComplianceReceiptSchema = z
  .object({
    contractVersion: z.literal(PROSPECT_CALL_COMPLIANCE_CONTRACT),
    workspaceId: z.number().int().positive(),
    approvalId: z.string().uuid(),
    outreachJobId: z.number().int().positive(),
    leadId: z.number().int().positive(),
    recipient: z.string().regex(E164_PHONE),
    recipientTimezone: z.string().trim().min(3).max(100),
    checkedAt: z.string().datetime({ offset: true }),
    approvedAt: z.string().datetime({ offset: true }),
    validUntil: z.string().datetime({ offset: true }),
    dncChecks: z
      .array(
        z
          .object({
            scope: dncScopeSchema,
            status: z.literal("clear"),
            source: z.string().trim().min(2).max(160),
            reference: z.string().trim().min(6).max(240),
          })
          .strict()
      )
      .length(3),
    callingWindow: z
      .object({
        start: z.literal("09:00"),
        end: z.literal("17:00"),
        basis: z.literal("recipient-local-time"),
      })
      .strict(),
    checkedBy: z.string().trim().min(2).max(200),
    humanApprovalRequired: z.literal(true),
    manualDialOnly: z.literal(true),
    contactAuthorizedByReceipt: z.literal(false),
    automatedDialingAuthorized: z.literal(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    const evidence = prospectCallComplianceEvidenceSchema.safeParse({
      checkedAt: value.checkedAt,
      recipientTimezone: value.recipientTimezone,
      dncChecks: value.dncChecks,
    });
    if (!evidence.success) {
      ctx.addIssue({
        code: "custom",
        message: "Stored call-compliance evidence is invalid.",
      });
    }
  });

export type ProspectCallComplianceReceipt = z.infer<
  typeof prospectCallComplianceReceiptSchema
>;

function iso(value: string): string {
  return new Date(value).toISOString();
}

function assertTimezone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(
      new Date(0)
    );
  } catch {
    throw new Error("A valid IANA recipient timezone is required.");
  }
}

function localMinuteOfDay(
  occurredAt: string,
  recipientTimezone: string
): { minute: number; localTime: string } {
  assertTimezone(recipientTimezone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: recipientTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(occurredAt));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(item => item.type === type)?.value || "";
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error("Recipient-local call time could not be calculated.");
  }
  return {
    minute: hour * 60 + minute,
    localTime: `${part("year")}-${part("month")}-${part("day")} ${String(
      hour
    ).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

export function hashProspectCallComplianceReceipt(
  receipt: ProspectCallComplianceReceipt
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(prospectCallComplianceReceiptSchema.parse(receipt))
    )
    .digest("hex");
}

export function buildProspectCallComplianceReceipt(input: {
  workspaceId: number;
  approvalId: string;
  outreachJobId: number;
  leadId: number;
  recipient: string;
  evidence: ProspectCallComplianceEvidence;
  actor: string;
  approvedAt: string;
  jobExpiresAt: string;
}): {
  receipt: ProspectCallComplianceReceipt;
  receiptHash: string;
} {
  const evidence = prospectCallComplianceEvidenceSchema.parse(input.evidence);
  assertTimezone(evidence.recipientTimezone);
  const approvedAt = new Date(input.approvedAt).getTime();
  const checkedAt = new Date(evidence.checkedAt).getTime();
  const jobExpiresAt = new Date(input.jobExpiresAt).getTime();
  if (
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(checkedAt) ||
    !Number.isFinite(jobExpiresAt)
  ) {
    throw new Error("Call-compliance timestamps are invalid.");
  }
  if (checkedAt > approvedAt) {
    throw new Error("Do-not-call evidence must predate approval.");
  }
  if (approvedAt - checkedAt > PROSPECT_CALL_COMPLIANCE_MAX_AGE_MS) {
    throw new Error("Do-not-call evidence is more than 24 hours old.");
  }
  const validUntil = Math.min(
    checkedAt + PROSPECT_CALL_COMPLIANCE_MAX_AGE_MS,
    jobExpiresAt
  );
  if (validUntil <= approvedAt) {
    throw new Error("Call-compliance evidence expires before approval.");
  }
  const scopeOrder = new Map(
    dncScopeSchema.options.map((scope, index) => [scope, index])
  );
  const receipt = prospectCallComplianceReceiptSchema.parse({
    contractVersion: PROSPECT_CALL_COMPLIANCE_CONTRACT,
    workspaceId: input.workspaceId,
    approvalId: input.approvalId,
    outreachJobId: input.outreachJobId,
    leadId: input.leadId,
    recipient: input.recipient,
    recipientTimezone: evidence.recipientTimezone,
    checkedAt: iso(evidence.checkedAt),
    approvedAt: iso(input.approvedAt),
    validUntil: new Date(validUntil).toISOString(),
    dncChecks: [...evidence.dncChecks].sort(
      (left, right) =>
        (scopeOrder.get(left.scope) || 0) -
        (scopeOrder.get(right.scope) || 0)
    ),
    callingWindow: {
      start: "09:00",
      end: "17:00",
      basis: "recipient-local-time",
    },
    checkedBy: input.actor,
    humanApprovalRequired: true,
    manualDialOnly: true,
    contactAuthorizedByReceipt: false,
    automatedDialingAuthorized: false,
  });
  return {
    receipt,
    receiptHash: hashProspectCallComplianceReceipt(receipt),
  };
}

export function assertProspectCallComplianceForExecution(input: {
  receipt: unknown;
  receiptHash: string;
  workspaceId: number;
  approvalId: string;
  outreachJobId: number;
  leadId: number;
  recipient: string;
  occurredAt: string;
  approvedBy: string;
  approvedAt: string;
  jobExpiresAt: string;
}): { localTime: string } {
  const receipt = prospectCallComplianceReceiptSchema.parse(input.receipt);
  if (hashProspectCallComplianceReceipt(receipt) !== input.receiptHash) {
    throw new Error("The call-compliance receipt hash changed.");
  }
  if (
    receipt.workspaceId !== input.workspaceId ||
    receipt.approvalId !== input.approvalId ||
    receipt.outreachJobId !== input.outreachJobId ||
    receipt.leadId !== input.leadId ||
    receipt.recipient !== input.recipient
  ) {
    throw new Error("The call-compliance receipt is bound to another action.");
  }
  const occurredAt = new Date(input.occurredAt).getTime();
  const approvedAt = new Date(input.approvedAt).getTime();
  const receiptApprovedAt = new Date(receipt.approvedAt).getTime();
  const checkedAt = new Date(receipt.checkedAt).getTime();
  const jobExpiresAt = new Date(input.jobExpiresAt).getTime();
  const validUntil = new Date(receipt.validUntil).getTime();
  const expectedValidUntil = Math.min(
    checkedAt + PROSPECT_CALL_COMPLIANCE_MAX_AGE_MS,
    jobExpiresAt
  );
  if (
    receipt.checkedBy !== input.approvedBy ||
    receiptApprovedAt !== approvedAt ||
    validUntil !== expectedValidUntil
  ) {
    throw new Error(
      "The call-compliance receipt does not match the durable approval."
    );
  }
  if (
    !Number.isFinite(occurredAt) ||
    !Number.isFinite(checkedAt) ||
    occurredAt < approvedAt ||
    occurredAt > jobExpiresAt ||
    occurredAt > validUntil
  ) {
    throw new Error("The call occurred outside its compliance validity window.");
  }
  const local = localMinuteOfDay(
    input.occurredAt,
    receipt.recipientTimezone
  );
  if (
    local.minute < PROSPECT_CALL_WINDOW_START_MINUTE ||
    local.minute >= PROSPECT_CALL_WINDOW_END_MINUTE
  ) {
    throw new Error(
      "Manual prospect calls are restricted to 09:00-17:00 recipient local time."
    );
  }
  return { localTime: local.localTime };
}
