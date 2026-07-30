import { createHash } from "node:crypto";
import { z } from "zod";
import { prospectEmailComplianceSchema } from "./prospect-outreach.js";

export const PROSPECT_INBOX_PLACEMENT_CONTRACT_VERSION =
  "smirk.prospect-inbox-placement.v1" as const;
export const PROSPECT_INBOX_PLACEMENT_PREPARE_CONFIRMATION =
  "prepare-five-controlled-inbox-seeds-v1" as const;
export const PROSPECT_INBOX_PLACEMENT_INSPECTION_CONFIRMATION =
  "record-one-controlled-inbox-inspection-v1" as const;
export const PROSPECT_INBOX_PLACEMENT_FINALIZE_CONFIRMATION =
  "finalize-five-controlled-inbox-seeds-v1" as const;
export const PROSPECT_INBOX_PLACEMENT_CANCEL_CONFIRMATION =
  "cancel-five-controlled-inbox-seeds-v1" as const;
export const PROSPECT_INBOX_PLACEMENT_PASS_VALIDITY_HOURS = 168;
export const SMIRK_INTERNAL_INBOX_SEED_SOURCE =
  "smirk_inbox_placement_seed" as const;

export const prospectInboxProviderSchema = z.enum([
  "google_workspace",
  "microsoft_365",
  "yahoo_aol",
]);
export type ProspectInboxProvider = z.infer<
  typeof prospectInboxProviderSchema
>;

export const prospectInboxFolderSchema = z.enum([
  "primary",
  "promotions",
  "spam",
  "junk",
  "other",
  "missing",
]);

export const prospectInboxAuthenticationResultSchema = z.enum([
  "PASS",
  "FAIL",
  "NOT_CHECKED",
]);

const controlledMailboxSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/),
    provider: prospectInboxProviderSchema,
    email: z.string().trim().email().max(320),
  })
  .strict();

function validateMailboxArray(
  mailboxes: z.infer<typeof controlledMailboxSchema>[],
  ctx: z.RefinementCtx
): void {
  const providerCounts = new Map<ProspectInboxProvider, number>([
    ["google_workspace", 0],
    ["microsoft_365", 0],
    ["yahoo_aol", 0],
  ]);
  const emails = new Set<string>();
  const labels = new Set<string>();
  for (const mailbox of mailboxes) {
    providerCounts.set(
      mailbox.provider,
      (providerCounts.get(mailbox.provider) || 0) + 1
    );
    const email = mailbox.email.toLowerCase();
    const label = mailbox.label.toLowerCase();
    if (emails.has(email)) {
      ctx.addIssue({
        code: "custom",
        message: "Every controlled inbox address must be unique.",
      });
    }
    if (labels.has(label)) {
      ctx.addIssue({
        code: "custom",
        message: "Every controlled inbox label must be unique.",
      });
    }
    emails.add(email);
    labels.add(label);
  }
  if (
    providerCounts.get("google_workspace") !== 2 ||
    providerCounts.get("microsoft_365") !== 2 ||
    providerCounts.get("yahoo_aol") !== 1
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "The controlled seed array must contain exactly two Google Workspace, two Microsoft 365, and one Yahoo/AOL mailbox.",
    });
  }
}

export const prepareProspectInboxPlacementSchema = z
  .object({
    campaignId: z.number().int().positive(),
    controlVariantKey: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/),
    challengerVariantKey: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/),
    mailboxes: z.array(controlledMailboxSchema).length(5),
    emailCompliance: prospectEmailComplianceSchema,
    maxCostCents: z.number().int().min(1).max(5).default(2),
    expiresInHours: z.number().int().min(1).max(168).default(72),
    confirmation: z.literal(
      PROSPECT_INBOX_PLACEMENT_PREPARE_CONFIRMATION
    ),
    attestations: z
      .object({
        controlledMailboxesOnly: z.literal(true),
        mailboxAccessVerified: z.literal(true),
        noRealProspectsIncluded: z.literal(true),
        noContactOrSpendAuthorized: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.controlVariantKey === value.challengerVariantKey) {
      ctx.addIssue({
        code: "custom",
        message: "The two inbox-test strategies must be different.",
      });
    }
    validateMailboxArray(value.mailboxes, ctx);
  });

export type PrepareProspectInboxPlacementInput = z.infer<
  typeof prepareProspectInboxPlacementSchema
>;

export const prospectInboxPlacementInspectionSchema = z
  .object({
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    providerMessageId: z.string().trim().min(2).max(200),
    inspectedAt: z.string().datetime({ offset: true }),
    folder: prospectInboxFolderSchema,
    smtpAccepted: z.boolean(),
    spf: prospectInboxAuthenticationResultSchema,
    dkim: prospectInboxAuthenticationResultSchema,
    dmarc: prospectInboxAuthenticationResultSchema,
    fromAligned: z.boolean(),
    plainTextOnly: z.boolean(),
    trackingPixelAbsent: z.boolean(),
    unexpectedLinksAbsent: z.boolean(),
    complianceFooterRendered: z.boolean(),
    notes: z.string().trim().max(500).optional(),
    confirmation: z.literal(
      PROSPECT_INBOX_PLACEMENT_INSPECTION_CONFIRMATION
    ),
    attestations: z
      .object({
        mailboxOpenedByOperator: z.literal(true),
        folderLocationObserved: z.literal(true),
        rawHeadersReviewed: z.literal(true),
      })
      .strict(),
  })
  .strict();

export type ProspectInboxPlacementInspection = z.infer<
  typeof prospectInboxPlacementInspectionSchema
>;

export const finalizeProspectInboxPlacementSchema = z
  .object({
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(
      PROSPECT_INBOX_PLACEMENT_FINALIZE_CONFIRMATION
    ),
    attestations: z
      .object({
        allFiveMailboxesReviewed: z.literal(true),
        rawHeadersReviewed: z.literal(true),
        noRealProspectOutreach: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const cancelProspectInboxPlacementSchema = z
  .object({
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(
      PROSPECT_INBOX_PLACEMENT_CANCEL_CONFIRMATION
    ),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const prospectInboxPlacementDefinitionSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_INBOX_PLACEMENT_CONTRACT_VERSION
    ),
    testId: z.string().uuid(),
    workspaceId: z.number().int().positive(),
    campaignId: z.number().int().positive(),
    controlVariantKey: z.string().trim().min(2).max(64),
    challengerVariantKey: z.string().trim().min(2).max(64),
    mailboxes: z
      .array(
        z
          .object({
            slot: z.number().int().min(1).max(5),
            label: z.string().trim().min(2).max(80),
            provider: prospectInboxProviderSchema,
            recipientHash: z.string().regex(/^[a-f0-9]{64}$/),
            assignedVariantKey: z.string().trim().min(2).max(64),
          })
          .strict()
      )
      .length(5),
    complianceHash: z.string().regex(/^[a-f0-9]{64}$/),
    maxCostCents: z.number().int().min(1).max(5),
    preparedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    contactAuthorized: z.literal(false),
    spendAuthorized: z.literal(false),
    automaticExecutionAuthorized: z.literal(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateMailboxArray(
      value.mailboxes.map((mailbox) => ({
        label: mailbox.label,
        provider: mailbox.provider,
        email: `${mailbox.recipientHash.slice(0, 16)}@seed.invalid`,
      })),
      ctx
    );
    const slots = value.mailboxes.map((mailbox) => mailbox.slot);
    if (
      new Set(slots).size !== 5 ||
      ![1, 2, 3, 4, 5].every((slot) => slots.includes(slot))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "The inbox-test definition must contain slots 1 through 5.",
      });
    }
  });

export type ProspectInboxPlacementDefinition = z.infer<
  typeof prospectInboxPlacementDefinitionSchema
>;

export type ProspectInboxPlacementEvaluationItem = {
  slot: number;
  label: string;
  provider: ProspectInboxProvider;
  approvalId: string;
  payloadHash: string;
  jobState: string;
  storedProviderMessageId: string | null;
  inspection: ProspectInboxPlacementInspection | null;
  inspectionHash: string | null;
};

export const prospectInboxPlacementReceiptSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_INBOX_PLACEMENT_CONTRACT_VERSION
    ),
    testId: z.string().uuid(),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    verdict: z.enum(["PASS", "FAIL"]),
    finalizedAt: z.string().datetime({ offset: true }),
    validUntil: z.string().datetime({ offset: true }),
    providerCounts: z
      .object({
        google_workspace: z.literal(2),
        microsoft_365: z.literal(2),
        yahoo_aol: z.literal(1),
      })
      .strict(),
    itemCount: z.literal(5),
    failureReasons: z.array(z.string().trim().min(3).max(500)).max(100),
    itemReceipts: z
      .array(
        z
          .object({
            slot: z.number().int().min(1).max(5),
            label: z.string().trim().min(2).max(80),
            provider: prospectInboxProviderSchema,
            approvalId: z.string().uuid(),
            payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
            providerMessageId: z.string().trim().min(2).max(200),
            inspectionHash: z.string().regex(/^[a-f0-9]{64}$/),
            passed: z.boolean(),
          })
          .strict()
      )
      .length(5),
    authorizesExperimentActivation: z.boolean(),
    authorizesContact: z.literal(false),
    authorizesSpend: z.literal(false),
    authorizesAutomaticSending: z.literal(false),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (
      receipt.authorizesExperimentActivation !==
      (receipt.verdict === "PASS")
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Only an all-pass inbox receipt can authorize experiment activation.",
      });
    }
    if (
      receipt.verdict === "PASS" &&
      (receipt.failureReasons.length > 0 ||
        receipt.itemReceipts.some((item) => !item.passed))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A passing receipt cannot contain a failed item.",
      });
    }
  });

export type ProspectInboxPlacementReceipt = z.infer<
  typeof prospectInboxPlacementReceiptSchema
>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

export function hashProspectInboxPlacementValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function normalizeProspectInboxPlacementEmail(
  value: string
): string {
  return z.string().trim().email().max(320).parse(value).toLowerCase();
}

export type ProspectInboxPlacementConfig = {
  configured: boolean;
  missing: string[];
  recipientHashes: string[];
};

export function readProspectInboxPlacementConfig(
  env: Record<string, string | undefined> = process.env
): ProspectInboxPlacementConfig {
  const raw = String(env.PROSPECT_INBOX_SEED_ALLOWLIST || "");
  const candidates = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const normalized: string[] = [];
  for (const candidate of candidates) {
    try {
      normalized.push(normalizeProspectInboxPlacementEmail(candidate));
    } catch {
      return {
        configured: false,
        missing: ["PROSPECT_INBOX_SEED_ALLOWLIST"],
        recipientHashes: [],
      };
    }
  }
  const unique = [...new Set(normalized)];
  if (unique.length !== 5 || candidates.length !== 5) {
    return {
      configured: false,
      missing: ["PROSPECT_INBOX_SEED_ALLOWLIST"],
      recipientHashes: [],
    };
  }
  return {
    configured: true,
    missing: [],
    recipientHashes: unique
      .map((email) => hashProspectInboxPlacementValue(email))
      .sort(),
  };
}

export function assertProspectInboxPlacementAllowlist(input: {
  config: ProspectInboxPlacementConfig;
  recipients: string[];
}): void {
  if (!input.config.configured) {
    throw new Error(
      "The exact five-address controlled inbox allowlist is not configured."
    );
  }
  const requested = [
    ...new Set(
      input.recipients.map((email) =>
        hashProspectInboxPlacementValue(
          normalizeProspectInboxPlacementEmail(email)
        )
      )
    ),
  ].sort();
  if (
    requested.length !== 5 ||
    requested.some(
      (value, index) =>
        value !== input.config.recipientHashes[index]
    )
  ) {
    throw new Error(
      "The requested seed recipients do not match the exact controlled inbox allowlist."
    );
  }
}

export function buildProspectInboxPlacementDefinition(input: {
  testId: string;
  workspaceId: number;
  preparedAt: string;
  data: PrepareProspectInboxPlacementInput;
}): ProspectInboxPlacementDefinition {
  const preparedAt = new Date(input.preparedAt);
  const expiresAt = new Date(
    preparedAt.getTime() + input.data.expiresInHours * 60 * 60_000
  );
  const mailboxes = input.data.mailboxes.map((mailbox, index) => ({
    slot: index + 1,
    label: mailbox.label,
    provider: mailbox.provider,
    recipientHash: hashProspectInboxPlacementValue(
      normalizeProspectInboxPlacementEmail(mailbox.email)
    ),
    assignedVariantKey:
      index % 2 === 0
        ? input.data.controlVariantKey
        : input.data.challengerVariantKey,
  }));
  return prospectInboxPlacementDefinitionSchema.parse({
    contractVersion: PROSPECT_INBOX_PLACEMENT_CONTRACT_VERSION,
    testId: input.testId,
    workspaceId: input.workspaceId,
    campaignId: input.data.campaignId,
    controlVariantKey: input.data.controlVariantKey,
    challengerVariantKey: input.data.challengerVariantKey,
    mailboxes,
    complianceHash: hashProspectInboxPlacementValue(
      input.data.emailCompliance
    ),
    maxCostCents: input.data.maxCostCents,
    preparedAt: preparedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    contactAuthorized: false,
    spendAuthorized: false,
    automaticExecutionAuthorized: false,
  });
}

function itemFailureReasons(
  item: ProspectInboxPlacementEvaluationItem
): string[] {
  const prefix = `${item.label} (${item.provider})`;
  if (!item.inspection) {
    return [`${prefix}: no immutable operator inspection was recorded.`];
  }
  const inspection = item.inspection;
  const failures: string[] = [];
  if (item.jobState !== "SENT") {
    failures.push(`${prefix}: the exact seed email is not in SENT state.`);
  }
  if (
    !item.storedProviderMessageId ||
    inspection.providerMessageId !== item.storedProviderMessageId
  ) {
    failures.push(
      `${prefix}: the inspected provider message ID does not match the sent job.`
    );
  }
  if (!inspection.smtpAccepted) {
    failures.push(`${prefix}: provider acceptance was not observed.`);
  }
  if (inspection.folder !== "primary") {
    failures.push(
      `${prefix}: folder placement was ${inspection.folder}, not primary/default inbox.`
    );
  }
  for (const [label, result] of [
    ["SPF", inspection.spf],
    ["DKIM", inspection.dkim],
    ["DMARC", inspection.dmarc],
  ] as const) {
    if (result !== "PASS") {
      failures.push(`${prefix}: ${label} was ${result}.`);
    }
  }
  if (!inspection.fromAligned) {
    failures.push(`${prefix}: From-domain alignment did not pass.`);
  }
  if (!inspection.plainTextOnly) {
    failures.push(`${prefix}: the received message was not plain text only.`);
  }
  if (!inspection.trackingPixelAbsent) {
    failures.push(`${prefix}: tracking-pixel absence was not confirmed.`);
  }
  if (!inspection.unexpectedLinksAbsent) {
    failures.push(`${prefix}: unexpected-link absence was not confirmed.`);
  }
  if (!inspection.complianceFooterRendered) {
    failures.push(`${prefix}: the compliance footer did not render cleanly.`);
  }
  return failures;
}

export function buildProspectInboxPlacementReceipt(input: {
  definition: ProspectInboxPlacementDefinition;
  definitionHash: string;
  finalizedAt: string;
  items: ProspectInboxPlacementEvaluationItem[];
}): ProspectInboxPlacementReceipt {
  const definition =
    prospectInboxPlacementDefinitionSchema.parse(input.definition);
  if (
    hashProspectInboxPlacementValue(definition) !== input.definitionHash
  ) {
    throw new Error(
      "The inbox-placement definition does not match its immutable hash."
    );
  }
  if (input.items.length !== 5) {
    throw new Error(
      "Exactly five controlled inbox items are required for finalization."
    );
  }
  const sortedItems = [...input.items].sort(
    (left, right) => left.slot - right.slot
  );
  const expectedSlots = definition.mailboxes.map((mailbox) => mailbox.slot);
  if (
    sortedItems.some(
      (item, index) =>
        item.slot !== expectedSlots[index] ||
        item.label !== definition.mailboxes[index].label ||
        item.provider !== definition.mailboxes[index].provider
    )
  ) {
    throw new Error(
      "The inbox-placement items do not match the immutable definition."
    );
  }
  const failureReasons = sortedItems.flatMap(itemFailureReasons);
  const finalizedAt = new Date(input.finalizedAt);
  const validUntil = new Date(
    finalizedAt.getTime() +
      PROSPECT_INBOX_PLACEMENT_PASS_VALIDITY_HOURS * 60 * 60_000
  );
  const itemReceipts = sortedItems.map((item) => {
    if (!item.inspection || !item.inspectionHash) {
      throw new Error(
        "Every controlled inbox requires an immutable inspection before finalization."
      );
    }
    return {
      slot: item.slot,
      label: item.label,
      provider: item.provider,
      approvalId: item.approvalId,
      payloadHash: item.payloadHash,
      providerMessageId: item.inspection.providerMessageId,
      inspectionHash: item.inspectionHash,
      passed: itemFailureReasons(item).length === 0,
    };
  });
  const verdict = failureReasons.length === 0 ? "PASS" : "FAIL";

  return prospectInboxPlacementReceiptSchema.parse({
    contractVersion: PROSPECT_INBOX_PLACEMENT_CONTRACT_VERSION,
    testId: definition.testId,
    definitionHash: input.definitionHash,
    verdict,
    finalizedAt: finalizedAt.toISOString(),
    validUntil: validUntil.toISOString(),
    providerCounts: {
      google_workspace: 2,
      microsoft_365: 2,
      yahoo_aol: 1,
    },
    itemCount: 5,
    failureReasons,
    itemReceipts,
    authorizesExperimentActivation: verdict === "PASS",
    authorizesContact: false,
    authorizesSpend: false,
    authorizesAutomaticSending: false,
  });
}
