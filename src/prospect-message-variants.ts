export const PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION =
  "smirk.prospect-message-variants.v1" as const;

export type ProspectMessageVariantChannel = "email" | "call";

export type ProspectMessageVariantKey =
  | "owner-language-v1"
  | "owner-language-v2"
  | "micro-after-hours-v1"
  | "micro-urgent-workflow-v1"
  | "micro-weekend-work-v1"
  | "manual-owner-call-v1"
  | "manual-owner-call-v2";

export type ProspectMessageContext = {
  businessName: string;
  industry: string;
  evidenceObservation: string | null;
};

export type RenderedProspectMessageVariant = {
  key: ProspectMessageVariantKey;
  channel: ProspectMessageVariantChannel;
  label: string;
  hypothesis: string;
  subject?: string;
  content: string;
  registryVersion: typeof PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION;
};

type ProspectMessageVariantDefinition = {
  key: ProspectMessageVariantKey;
  channel: ProspectMessageVariantChannel;
  label: string;
  hypothesis: string;
  render: (
    context: ProspectMessageContext
  ) => Pick<RenderedProspectMessageVariant, "subject" | "content">;
};

function cleanText(
  value: unknown,
  fallback: string,
  maximumLength: number
): string {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
  return normalized || fallback;
}

function isSafeEvidenceObservation(value: string): boolean {
  return ![
    /\byou(?:'re| are) losing\b/i,
    /\blost (?:jobs?|customers?|leads?|money|revenue|income|profit)\b/i,
    /\bcritical (?:revenue )?leaks?\b/i,
    /\bcosting you\b/i,
    /\bguaranteed revenue\b/i,
  ].some((pattern) => pattern.test(value));
}

export function buildProspectMessageContext(input: {
  businessName: unknown;
  industry: unknown;
  researchEvidence?: unknown;
}): ProspectMessageContext {
  const evidenceItems = Array.isArray(input.researchEvidence)
    ? input.researchEvidence
    : [];
  const evidence = evidenceItems.find((item) => {
    if (!item || typeof item !== "object") return false;
    const kind = String((item as Record<string, unknown>).kind || "");
    const basis = String((item as Record<string, unknown>).basis || "");
    return (
      basis === "observed" &&
      ["contact_path", "visual_usability"].includes(kind)
    );
  }) as Record<string, unknown> | undefined;
  const observation = evidence
    ? cleanText(
        evidence.observation,
        "",
        280
      ).replace(/^Screenshot review inference:\s*/i, "")
    : "";

  return {
    businessName: cleanText(input.businessName, "the business", 160),
    industry: cleanText(input.industry, "home-service", 80),
    evidenceObservation:
      observation && isSafeEvidenceObservation(observation)
        ? observation
        : null,
  };
}

const variantDefinitions: readonly ProspectMessageVariantDefinition[] = [
  {
    key: "owner-language-v1",
    channel: "email",
    label: "Proof-first backup",
    hypothesis:
      "Concrete captured fields and a low-pressure proof-call offer earn replies.",
    render: (context) => ({
      subject: `Capturing urgent ${context.industry} calls`,
      content: `Hi ${context.businessName} team,

${
  context.evidenceObservation
    ? `I was reviewing your public site and noticed: ${context.evidenceObservation}`
    : `I'm testing SMIRK with ${context.industry} businesses that want a simple backup path for urgent callers who reach them while the office is busy, after-hours, or crews are already on jobs.`
}

The narrow use case is not a chatbot. It captures the caller's issue, urgency, service area, and callback window, then gives the owner a callback-ready summary with dashboard proof.

Would one review-only proof call be useful, or should I leave this off your plate?`,
    }),
  },
  {
    key: "owner-language-v2",
    channel: "email",
    label: "Owner workflow question",
    hypothesis:
      "Leading with the after-hours workflow makes the backup-path value easier to recognize.",
    render: (context) => ({
      subject: `A backup for urgent ${context.industry} calls`,
      content: `Hi ${context.businessName} team,

${
  context.evidenceObservation
    ? `I noticed this on your public site: ${context.evidenceObservation}`
    : `I'm testing a simple missed-call backup for independent ${context.industry} businesses.`
}

SMIRK gives urgent callers a backup path when the office is busy, after-hours, or crews are already on jobs. It records the issue, urgency, service area, and callback window, then sends a callback-ready summary with dashboard proof.

Would it be useful to review one proof call, or should I close the loop here?`,
    }),
  },
  {
    key: "micro-after-hours-v1",
    channel: "email",
    label: "Micro: after-hours coverage",
    hypothesis:
      "A transparent, plain-text after-hours question earns more replies than a product explanation.",
    render: () => ({
      subject: "after-hours call coverage",
      content:
        "Hi - Cameron with SMIRK. When after-hours calls come in, does someone answer, or do they reach voicemail?",
    }),
  },
  {
    key: "micro-urgent-workflow-v1",
    channel: "email",
    label: "Micro: urgent-call workflow",
    hypothesis:
      "A short operational question about urgent calls makes the owner workflow easy to answer.",
    render: (context) => ({
      subject: `urgent ${context.industry} calls`,
      content: `Hi - Cameron with SMIRK. How does your team handle urgent after-hours ${context.industry} calls when everyone is already on a job?`,
    }),
  },
  {
    key: "micro-weekend-work-v1",
    channel: "email",
    label: "Micro: weekend work",
    hypothesis:
      "A transparent binary question about weekend work lowers reply effort without pretending to be a customer.",
    render: (context) => ({
      subject: `weekend ${context.industry} work`,
      content: `Hi - Cameron with SMIRK. Are you currently taking emergency weekend ${context.industry} work, or only weekday calls?`,
    }),
  },
  {
    key: "manual-owner-call-v1",
    channel: "call",
    label: "Proof-call opener",
    hypothesis:
      "A concise product explanation followed by one proof-call offer earns permission to continue.",
    render: (context) => ({
      content: `Manual-dial-only call brief for ${context.businessName}.

Public observation: ${context.evidenceObservation || "No claim beyond the reviewed public business profile."}

Opening: Hi, this is [operator name] with SMIRK. We built a backup path for urgent ${context.industry} callers who reach a business while the office is busy, after-hours, or crews are already on jobs.

Explain: SMIRK captures the issue, urgency, service area, and callback window, then gives the owner a callback-ready summary with dashboard proof.

Ask: Would you be open to reviewing one proof call?

Boundary: Do not make unsupported business-outcome claims. Do not pressure the recipient. If they decline, thank them, record not interested, and end the call. The operator must dial manually.`,
    }),
  },
  {
    key: "manual-owner-call-v2",
    channel: "call",
    label: "Workflow discovery opener",
    hypothesis:
      "Starting with the owner's current overflow workflow creates a more relevant conversation.",
    render: (context) => ({
      content: `Manual-dial-only workflow brief for ${context.businessName}.

Public observation: ${context.evidenceObservation || "No claim beyond the reviewed public business profile."}

Opening: Hi, this is [operator name] with SMIRK. I have one quick question about how your team handles urgent ${context.industry} callers when the office is busy or crews are already on jobs.

Discovery question: What happens today when nobody can answer immediately?

If relevant: SMIRK can act as a backup path, capture the caller's issue, urgency, service area, and callback window, and send a callback-ready summary with dashboard proof.

Ask: Would one review-only proof call be useful?

Boundary: Do not make unsupported business-outcome claims about the current workflow. Do not pressure the recipient. If they decline, thank them, record not interested, and end the call. The operator must dial manually.`,
    }),
  },
] as const;

export function getProspectMessageVariantDefinitions(
  channel?: ProspectMessageVariantChannel
): Array<
  Omit<ProspectMessageVariantDefinition, "render"> & {
    registryVersion: typeof PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION;
  }
> {
  return variantDefinitions
    .filter((definition) => !channel || definition.channel === channel)
    .map(({ render: _render, ...definition }) => ({
      ...definition,
      registryVersion: PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
    }));
}

export function getProspectMessageVariantDefinition(
  key: string
): ReturnType<typeof getProspectMessageVariantDefinitions>[number] | null {
  return (
    getProspectMessageVariantDefinitions().find(
      (definition) => definition.key === key
    ) || null
  );
}

export function getDefaultProspectMessageVariantKey(
  channel: ProspectMessageVariantChannel
): ProspectMessageVariantKey {
  return channel === "email"
    ? "owner-language-v1"
    : "manual-owner-call-v1";
}

export function renderProspectMessageVariant(
  key: string,
  context: ProspectMessageContext
): RenderedProspectMessageVariant | null {
  const definition = variantDefinitions.find((candidate) => candidate.key === key);
  if (!definition) return null;
  return {
    key: definition.key,
    channel: definition.channel,
    label: definition.label,
    hypothesis: definition.hypothesis,
    ...definition.render(context),
    registryVersion: PROSPECT_MESSAGE_VARIANT_REGISTRY_VERSION,
  };
}

function normalizedDraftText(value: string | undefined): string {
  return String(value || "").trim();
}

export function findMatchingProspectMessageVariant(input: {
  channel: ProspectMessageVariantChannel;
  subject?: string;
  content: string;
  context: ProspectMessageContext;
}): RenderedProspectMessageVariant | null {
  for (const definition of variantDefinitions) {
    if (definition.channel !== input.channel) continue;
    const rendered = renderProspectMessageVariant(
      definition.key,
      input.context
    );
    if (
      rendered &&
      normalizedDraftText(rendered.subject) ===
        normalizedDraftText(input.subject) &&
      normalizedDraftText(rendered.content) ===
        normalizedDraftText(input.content)
    ) {
      return rendered;
    }
  }
  return null;
}
