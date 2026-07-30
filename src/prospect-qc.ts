import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  PrepareProspectOutreachInput,
  ProspectOutreachChannel,
} from "./prospect-outreach.js";
import type { ProspectMessageContext } from "./prospect-message-variants.js";

export const PROSPECT_QC_CONTRACT_VERSION = "smirk.prospect-qc.v1" as const;
export const PROSPECT_QC_RULE_VERSION =
  "smirk.prospect-qc-rules.2026-07-30" as const;

export const PROSPECT_QC_MODEL_SYSTEM_PROMPT = `You are a strict advisory auditor for truthful B2B outreach.
Evaluate only the supplied prospect evidence and exact draft.
Flag unresolved placeholders, unsupported factual claims, deceptive framing, spam-heavy language, industry mismatch, or an aggressive call to action.
Do not authorize contact, sending, dialing, or policy changes.
Return only JSON matching the supplied schema.`;

export const prospectQcModelOutputSchema = z
  .object({
    pass: z.boolean(),
    confidence_score: z.number().min(0).max(1),
    failure_reasons: z.array(z.string().trim().min(1).max(500)).max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.pass && value.failure_reasons.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "A passing model review cannot include failure reasons.",
      });
    }
    if (!value.pass && value.failure_reasons.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "A failed model review must include at least one reason.",
      });
    }
  });

export type ProspectQcModelOutput = z.infer<
  typeof prospectQcModelOutputSchema
>;

const prospectQcRuleResultSchema = z
  .object({
    code: z.string().trim().min(3).max(100),
    passed: z.boolean(),
    detail: z.string().trim().min(3).max(500),
  })
  .strict();

const prospectQcModelReviewSchema = z
  .object({
    status: z.enum(["NOT_RUN", "PASSED", "FLAGGED", "ERROR"]),
    authority: z.literal("advisory-only"),
    provider: z.string().trim().min(1).max(80).nullable(),
    model: z.string().trim().min(1).max(160).nullable(),
    promptHash: z.string().regex(/^[a-f0-9]{64}$/),
    confidenceScore: z.number().min(0).max(1).nullable(),
    failureReasons: z.array(z.string().trim().min(1).max(500)).max(20),
    latencyMs: z.number().int().min(0).max(120_000).nullable(),
    estimatedCostCents: z.number().min(0).max(100).nullable(),
  })
  .strict();

export type ProspectQcModelReview = z.infer<
  typeof prospectQcModelReviewSchema
>;

export const prospectQcReceiptSchema = z
  .object({
    contractVersion: z.literal(PROSPECT_QC_CONTRACT_VERSION),
    ruleVersion: z.literal(PROSPECT_QC_RULE_VERSION),
    receiptId: z.string().regex(/^qcr_[a-f0-9]{24}$/),
    evaluatedAt: z.string().datetime({ offset: true }),
    channel: z.enum(["email", "call"]),
    variantKey: z.string().trim().min(2).max(64),
    draftHash: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    deterministicPassed: z.boolean(),
    verdict: z.enum([
      "ELIGIBLE_FOR_HUMAN_APPROVAL",
      "REVISION_REQUIRED",
    ]),
    reviewPriority: z.enum(["standard", "elevated"]),
    ruleResults: z.array(prospectQcRuleResultSchema).min(1).max(20),
    failureReasons: z.array(z.string().trim().min(1).max(500)).max(20),
    modelReview: prospectQcModelReviewSchema,
    humanApprovalRequired: z.literal(true),
    contactAuthorized: z.literal(false),
    executionAuthorized: z.literal(false),
    automatedSendingAuthorized: z.literal(false),
    automatedDialingAuthorized: z.literal(false),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const failedRules = receipt.ruleResults.filter((rule) => !rule.passed);
    if (receipt.deterministicPassed !== (failedRules.length === 0)) {
      ctx.addIssue({
        code: "custom",
        message: "The deterministic verdict does not match the rule results.",
      });
    }
    if (
      receipt.verdict === "ELIGIBLE_FOR_HUMAN_APPROVAL" &&
      !receipt.deterministicPassed
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A failed deterministic audit cannot be approval eligible.",
      });
    }
    if (
      receipt.verdict === "REVISION_REQUIRED" &&
      receipt.deterministicPassed
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A passing deterministic audit cannot require revision.",
      });
    }
    if (receipt.failureReasons.length !== failedRules.length) {
      ctx.addIssue({
        code: "custom",
        message: "Every failed deterministic rule must have one reason.",
      });
    }
  });

export type ProspectQcReceipt = z.infer<typeof prospectQcReceiptSchema>;

type RuleResult = z.infer<typeof prospectQcRuleResultSchema>;

const UNSUPPORTED_OUTCOME_PATTERNS = [
  /\byou(?:'re| are) losing (?:money|jobs?|customers?|revenue)\b/i,
  /\blost (?:emergency |service |potential )?(?:jobs?|customers?|leads?|money|revenue|income|profit)\b/i,
  /\bguaranteed (?:revenue|leads?|jobs?|results?)\b/i,
  /\bcritical (?:revenue )?leaks?\b/i,
  /\bcosting you\b/i,
  /\bthe \$[\d,.]+ (?:phone )?call you (?:just )?missed\b/i,
] as const;

const SPAM_TRIGGER_PATTERNS = [
  /\b100%\s+free\b/i,
  /\bact now\b/i,
  /\blimited[- ]time offer\b/i,
  /\bno risk\b/i,
  /\binstant cash\b/i,
  /\bdouble your\b/i,
  /\bmake money fast\b/i,
] as const;

const INDUSTRY_TERMS: Record<string, readonly string[]> = {
  plumbing: ["plumber", "plumbers", "plumbing"],
  hvac: ["hvac", "heating", "air conditioning"],
  electrical: ["electrician", "electricians", "electrical"],
  roofing: ["roofer", "roofers", "roofing"],
  handyman: ["handyman", "handymen"],
  remodeling: ["remodeler", "remodelers", "remodeling"],
};

const MICRO_TOUCH_VARIANTS = new Set([
  "micro-after-hours-v1",
  "micro-urgent-workflow-v1",
  "micro-weekend-work-v1",
]);

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function hashProspectQcDraft(input: {
  channel: ProspectOutreachChannel;
  subject?: string;
  content: string;
}): string {
  return sha256({
    channel: input.channel,
    subject: input.subject || null,
    content: input.content,
  });
}

function draftText(draft: PrepareProspectOutreachInput): {
  channel: ProspectOutreachChannel;
  subject?: string;
  content: string;
  variantKey: string;
} {
  if (draft.channel === "email") {
    return {
      channel: "email",
      subject: draft.subject.trim(),
      content: draft.body.trim(),
      variantKey: String(draft.variantKey || "operator-v1"),
    };
  }
  return {
    channel: "call",
    content: draft.callBrief.trim(),
    variantKey: String(draft.variantKey || "operator-v1"),
  };
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function countLinks(value: string): number {
  return (value.match(/\bhttps?:\/\/[^\s<>()]+/gi) || []).length;
}

function unresolvedPlaceholders(
  channel: ProspectOutreachChannel,
  value: string
): string[] {
  const matches = [
    ...(value.match(/\{\{[^{}]+\}\}/g) || []),
    ...(value.match(/\$\{[^{}]+\}/g) || []),
    ...(value.match(/\[(?:company|first[_ ]?name|city|industry|prospect)\]/gi) ||
      []),
  ];
  if (channel === "email") {
    matches.push(
      ...(value.match(/\[(?:operator|sender)[_ ]?name\]/gi) || [])
    );
  }
  return [...new Set(matches)];
}

export function containsUnsupportedBusinessOutcomeClaim(
  value: string
): boolean {
  return UNSUPPORTED_OUTCOME_PATTERNS.some((pattern) => pattern.test(value));
}

function excessiveCaps(value: string): boolean {
  const words = value.match(/\b[A-Z][A-Z0-9]{2,}\b/g) || [];
  const permitted = new Set(["SMIRK", "HVAC"]);
  return words.filter((word) => !permitted.has(word)).length >= 2;
}

function industryAligned(
  industry: string,
  subjectAndContent: string
): boolean {
  const target = industry.toLowerCase();
  const matchingKey = Object.keys(INDUSTRY_TERMS).find(
    (key) =>
      target.includes(key) ||
      INDUSTRY_TERMS[key].some((term) => target.includes(term))
  );
  if (!matchingKey) return true;

  for (const [industryKey, terms] of Object.entries(INDUSTRY_TERMS)) {
    if (industryKey === matchingKey) continue;
    if (terms.some((term) => new RegExp(`\\b${term}\\b`, "i").test(subjectAndContent))) {
      return false;
    }
  }
  return true;
}

function sourceGrounded(
  content: string,
  context: ProspectMessageContext
): boolean {
  const claimsObservation =
    /\b(?:i noticed|i was reviewing|on your (?:public )?(?:site|website)|your (?:public )?(?:site|website) (?:shows|says|offers))\b/i.test(
      content
    );
  if (!claimsObservation) return true;
  return Boolean(
    context.evidenceObservation &&
      content
        .toLowerCase()
        .includes(context.evidenceObservation.toLowerCase())
  );
}

function defaultModelReview(): ProspectQcModelReview {
  return {
    status: "NOT_RUN",
    authority: "advisory-only",
    provider: null,
    model: null,
    promptHash: sha256(PROSPECT_QC_MODEL_SYSTEM_PROMPT),
    confidenceScore: null,
    failureReasons: [],
    latencyMs: null,
    estimatedCostCents: null,
  };
}

export function buildProspectQcModelReview(input: {
  rawOutput: unknown;
  provider: string;
  model: string;
  latencyMs: number;
  estimatedCostCents: number;
}): ProspectQcModelReview {
  const parsed = prospectQcModelOutputSchema.safeParse(input.rawOutput);
  if (!parsed.success) {
    return prospectQcModelReviewSchema.parse({
      ...defaultModelReview(),
      status: "ERROR",
      provider: input.provider,
      model: input.model,
      latencyMs: input.latencyMs,
      estimatedCostCents: input.estimatedCostCents,
      failureReasons: ["The advisory model returned invalid structured output."],
    });
  }
  return prospectQcModelReviewSchema.parse({
    status: parsed.data.pass ? "PASSED" : "FLAGGED",
    authority: "advisory-only",
    provider: input.provider,
    model: input.model,
    promptHash: sha256(PROSPECT_QC_MODEL_SYSTEM_PROMPT),
    confidenceScore: parsed.data.confidence_score,
    failureReasons: parsed.data.failure_reasons,
    latencyMs: input.latencyMs,
    estimatedCostCents: input.estimatedCostCents,
  });
}

export function buildProspectQcReceipt(input: {
  draft: PrepareProspectOutreachInput;
  context: ProspectMessageContext;
  evidenceHash: string;
  evaluatedAt: string;
  modelReview?: ProspectQcModelReview;
}): ProspectQcReceipt {
  const draft = draftText(input.draft);
  const combined = [draft.subject || "", draft.content].join("\n");
  const placeholderMatches = unresolvedPlaceholders(draft.channel, combined);
  const links = countLinks(combined);
  const microTouch = MICRO_TOUCH_VARIANTS.has(draft.variantKey);
  const emailCompliancePresent =
    input.draft.channel !== "email" ||
    Boolean(
      input.draft.emailCompliance.senderIdentity.trim() &&
        input.draft.emailCompliance.advertisementDisclosure.trim() &&
        input.draft.emailCompliance.physicalPostalAddress.trim() &&
        input.draft.emailCompliance.optOutInstructions.trim()
    );
  const rules: RuleResult[] = [
    {
      code: "PLACEHOLDERS_RESOLVED",
      passed: placeholderMatches.length === 0,
      detail:
        placeholderMatches.length === 0
          ? "No unresolved recipient-facing placeholders were found."
          : `Unresolved placeholders: ${placeholderMatches.join(", ")}.`,
    },
    {
      code: "OUTCOME_CLAIMS_SUPPORTED",
      passed: !containsUnsupportedBusinessOutcomeClaim(combined),
      detail: containsUnsupportedBusinessOutcomeClaim(combined)
        ? "The draft contains a prohibited or unsupported business-outcome claim."
        : "No prohibited business-outcome claim was found.",
    },
    {
      code: "SOURCE_CLAIMS_GROUNDED",
      passed: sourceGrounded(draft.content, input.context),
      detail: sourceGrounded(draft.content, input.context)
        ? "Any public-source observation is bound to reviewed evidence."
        : "The draft implies a public-site observation that is not present in the reviewed evidence.",
    },
    {
      code: "INDUSTRY_ALIGNED",
      passed: industryAligned(input.context.industry, combined),
      detail: industryAligned(input.context.industry, combined)
        ? "The copy does not conflict with the prospect industry."
        : "The copy names a different trade than the prospect record.",
    },
    {
      code: "SPAM_LANGUAGE_BOUNDED",
      passed:
        !SPAM_TRIGGER_PATTERNS.some((pattern) => pattern.test(combined)) &&
        (combined.match(/!/g) || []).length <= 1 &&
        !excessiveCaps(combined),
      detail:
        SPAM_TRIGGER_PATTERNS.some((pattern) => pattern.test(combined)) ||
        (combined.match(/!/g) || []).length > 1 ||
        excessiveCaps(combined)
          ? "The draft contains a blocked spam phrase, excessive punctuation, or excessive all-caps wording."
          : "Spam-trigger, punctuation, and all-caps checks passed.",
    },
    {
      code: "LINK_COUNT_BOUNDED",
      passed: links <= (microTouch ? 0 : 1),
      detail:
        links <= (microTouch ? 0 : 1)
          ? `The draft contains ${links} link${links === 1 ? "" : "s"}.`
          : microTouch
            ? "A touch-one micro-hook cannot include a link."
            : "The draft contains more than one link.",
    },
    {
      code: "MICRO_TOUCH_TRANSPARENT",
      passed:
        !microTouch ||
        (/\bSMIRK\b/i.test(draft.content) &&
          countWords(draft.content) <= 30),
      detail:
        !microTouch
          ? "The registered strategy is not subject to the touch-one micro-hook profile."
          : /\bSMIRK\b/i.test(draft.content) &&
              countWords(draft.content) <= 30
            ? `The micro-hook is transparent and ${countWords(draft.content)} words.`
            : "A micro-hook must identify SMIRK and contain no more than 30 body words.",
    },
    {
      code: "EMAIL_COMPLIANCE_PRESENT",
      passed: emailCompliancePresent,
      detail:
        input.draft.channel !== "email"
          ? "Email-specific footer controls do not apply to a manual call brief."
          : emailCompliancePresent
            ? "Sender identity, commercial disclosure, postal address, and opt-out text are present."
            : "Sender identity, commercial disclosure, postal address, and opt-out text are all required.",
    },
    {
      code: "EXECUTION_REMAINS_HUMAN_GATED",
      passed: true,
      detail:
        draft.channel === "email"
          ? "QC does not approve or send email; one-recipient human approval and a separate send confirmation remain required."
          : "QC does not approve or dial calls; DNC, calling-window, and manual-dial attestations remain required.",
    },
  ];
  const failedRules = rules.filter((rule) => !rule.passed);
  const modelReview = prospectQcModelReviewSchema.parse(
    input.modelReview || defaultModelReview()
  );
  const deterministicPassed = failedRules.length === 0;
  const draftHash = hashProspectQcDraft({
    channel: draft.channel,
    subject: draft.subject,
    content: draft.content,
  });

  return prospectQcReceiptSchema.parse({
    contractVersion: PROSPECT_QC_CONTRACT_VERSION,
    ruleVersion: PROSPECT_QC_RULE_VERSION,
    receiptId: `qcr_${sha256({
      ruleVersion: PROSPECT_QC_RULE_VERSION,
      draftHash,
      evidenceHash: input.evidenceHash,
      evaluatedAt: new Date(input.evaluatedAt).toISOString(),
    }).slice(0, 24)}`,
    evaluatedAt: new Date(input.evaluatedAt).toISOString(),
    channel: draft.channel,
    variantKey: draft.variantKey,
    draftHash,
    evidenceHash: input.evidenceHash,
    deterministicPassed,
    verdict: deterministicPassed
      ? "ELIGIBLE_FOR_HUMAN_APPROVAL"
      : "REVISION_REQUIRED",
    reviewPriority:
      modelReview.status === "FLAGGED" || modelReview.status === "ERROR"
        ? "elevated"
        : "standard",
    ruleResults: rules,
    failureReasons: failedRules.map(
      (rule) => `${rule.code}: ${rule.detail}`
    ),
    modelReview,
    humanApprovalRequired: true,
    contactAuthorized: false,
    executionAuthorized: false,
    automatedSendingAuthorized: false,
    automatedDialingAuthorized: false,
  });
}

export function assertProspectQcApprovalEligible(
  receipt: ProspectQcReceipt | undefined
): void {
  if (!receipt) {
    throw new Error(
      "A legacy draft without a QC receipt cannot be approved or executed."
    );
  }
  const parsed = prospectQcReceiptSchema.parse(receipt);
  if (
    !parsed.deterministicPassed ||
    parsed.verdict !== "ELIGIBLE_FOR_HUMAN_APPROVAL" ||
    parsed.contactAuthorized !== false ||
    parsed.executionAuthorized !== false
  ) {
    throw new Error(
      parsed.failureReasons.length > 0
        ? `The draft failed deterministic QC: ${parsed.failureReasons.join(" | ")}`
        : "The draft failed deterministic QC and cannot enter the approval ledger."
    );
  }
}
