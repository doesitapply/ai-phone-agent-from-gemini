import { createHash } from "node:crypto";
import {
  PROSPECT_ACQUISITION_CONFIGURATION_PHASES,
  buildProspectAcquisitionConnectionReadiness,
  type ProspectAcquisitionConfigurationPhaseId,
  type ProspectAcquisitionConnectionReadiness,
} from "./prospect-acquisition-connection-readiness.js";

export const PROSPECT_ACQUISITION_CONFIGURATION_PLAN_CONTRACT =
  "smirk.prospect-acquisition-configuration-plan.v1" as const;

type ConfigurationVariableKind =
  | "fixed-value"
  | "operator-value"
  | "generated-secret"
  | "provider-secret"
  | "activation-switch";

type ConfigurationVariableDefinition = {
  name: string;
  group:
    | "velvet-authority"
    | "no-contact-discovery"
    | "pre-approval-qc"
    | "prospect-email"
    | "closed-loop-learning";
  kind: ConfigurationVariableKind;
  sensitive: boolean;
  fixedValue?: string;
  expected: string;
};

type ConfigurationVariableState = ConfigurationVariableDefinition & {
  state:
    | "missing"
    | "present-redacted"
    | "matches-fixed-value"
    | "drifted-from-fixed-value"
    | "safely-disabled"
    | "enabled-requires-separate-approval"
    | "invalid-switch-value";
  currentValueDisclosed: false;
};

export const PROSPECT_ACQUISITION_ACTIVATION_SWITCHES = [
  "VELVET_DISCOVERY_ENABLED",
  "VELVET_LEAD_SOURCE_ENABLED",
  "PROSPECT_REVENUE_LOOP_PREPARER_ENABLED",
  "PROSPECT_QC_MODEL_REVIEW_ENABLED",
  "PROSPECT_EMAIL_EXECUTION_ENABLED",
  "PROSPECT_EMAIL_WEBHOOK_ENABLED",
  "PROSPECT_EMAIL_RECEIVING_ENABLED",
  "VELVET_OUTCOME_DISPATCH_ENABLED",
] as const;

const ACTIVATION_SWITCHES = new Set<string>(
  PROSPECT_ACQUISITION_ACTIVATION_SWITCHES
);

const VARIABLES: ConfigurationVariableDefinition[] = [
  {
    name: "VELVET_LEAD_SOURCE_BASE_URL",
    group: "velvet-authority",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "https://velvetalchemy.manus.space",
    expected: "Exact reviewed Velvet production origin.",
  },
  {
    name: "VELVET_BASE_URL",
    group: "velvet-authority",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "https://velvetalchemy.manus.space",
    expected: "Same exact reviewed Velvet production origin.",
  },
  {
    name: "VELVET_LEAD_SOURCE_API_KEY",
    group: "velvet-authority",
    kind: "provider-secret",
    sensitive: true,
    expected: "Dedicated Velvet smirk:research key, at least 32 characters.",
  },
  {
    name: "VELVET_OUTCOME_API_KEY",
    group: "velvet-authority",
    kind: "provider-secret",
    sensitive: true,
    expected: "Separate Velvet outcome:write key, at least 32 characters.",
  },
  {
    name: "VELVET_OUTCOME_SIGNING_SECRET",
    group: "velvet-authority",
    kind: "generated-secret",
    sensitive: true,
    expected: "Separate random HMAC secret shared with Velvet, at least 32 characters.",
  },
  {
    name: "VELVET_LEAD_SOURCE_WORKSPACE_ID",
    group: "velvet-authority",
    kind: "operator-value",
    sensitive: false,
    expected: "Exact positive SMIRK workspace ID.",
  },
  {
    name: "VELVET_OUTCOME_WORKSPACE_ID",
    group: "velvet-authority",
    kind: "operator-value",
    sensitive: false,
    expected: "Same exact positive SMIRK workspace ID.",
  },
  {
    name: "VELVET_DISCOVERY_ENABLED",
    group: "no-contact-discovery",
    kind: "activation-switch",
    sensitive: false,
    fixedValue: "false",
    expected: "Keep false until one bounded no-contact discovery is explicitly approved.",
  },
  {
    name: "VELVET_LEAD_SOURCE_ENABLED",
    group: "no-contact-discovery",
    kind: "activation-switch",
    sensitive: false,
    fixedValue: "false",
    expected: "Keep false until one reviewed inventory pull is explicitly approved.",
  },
  {
    name: "PROSPECT_REVENUE_LOOP_PREPARER_ENABLED",
    group: "no-contact-discovery",
    kind: "activation-switch",
    sensitive: false,
    fixedValue: "false",
    expected: "Keep false until one synthetic PREPARED-item proof is explicitly approved.",
  },
  {
    name: "PROSPECT_REVENUE_LOOP_PREPARER_API_KEY",
    group: "no-contact-discovery",
    kind: "generated-secret",
    sensitive: true,
    expected: "Dedicated review-item-only key, at least 32 characters and distinct from privileged keys.",
  },
  {
    name: "PROSPECT_REVENUE_LOOP_PREPARER_WORKSPACE_ID",
    group: "no-contact-discovery",
    kind: "operator-value",
    sensitive: false,
    expected: "Exact positive SMIRK workspace ID.",
  },
  {
    name: "PROSPECT_REVENUE_LOOP_DISCOVERY_LIMIT",
    group: "no-contact-discovery",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "1",
    expected: "One lead for the first bounded production proof.",
  },
  {
    name: "PROSPECT_REVENUE_LOOP_DISCOVERY_CATEGORY",
    group: "no-contact-discovery",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "plumbing",
    expected: "First home-services proof vertical.",
  },
  {
    name: "PROSPECT_REVENUE_LOOP_DISCOVERY_CITY",
    group: "no-contact-discovery",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "Reno",
    expected: "First bounded local proof market.",
  },
  {
    name: "PROSPECT_REVENUE_LOOP_DISCOVERY_STATE",
    group: "no-contact-discovery",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "NV",
    expected: "First bounded local proof state.",
  },
  {
    name: "PROSPECT_QC_MODEL_REVIEW_ENABLED",
    group: "pre-approval-qc",
    kind: "activation-switch",
    sensitive: false,
    fixedValue: "false",
    expected: "Keep false until one capped fake-target model review is explicitly approved.",
  },
  {
    name: "PROSPECT_QC_MODEL_REVIEW_REQUIRED_FOR_APPROVAL",
    group: "pre-approval-qc",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "true",
    expected: "Fail closed when the advisory receipt is absent; human approval remains mandatory.",
  },
  {
    name: "PROSPECT_QC_MODEL_REVIEW_MODE",
    group: "pre-approval-qc",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "single-draft-advisory-v1",
    expected: "Single-draft advisory review only.",
  },
  {
    name: "PROSPECT_QC_OPENROUTER_API_KEY",
    group: "pre-approval-qc",
    kind: "provider-secret",
    sensitive: true,
    expected: "Dedicated funded OpenRouter key, distinct from the general model key.",
  },
  {
    name: "PROSPECT_QC_OPENROUTER_MODEL",
    group: "pre-approval-qc",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "google/gemini-2.5-flash",
    expected: "Allowlisted structured-output model.",
  },
  {
    name: "PROSPECT_QC_MODEL_WORKSPACE_ID",
    group: "pre-approval-qc",
    kind: "operator-value",
    sensitive: false,
    expected: "Exact positive SMIRK workspace ID.",
  },
  {
    name: "PROSPECT_QC_MODEL_DAILY_REVIEW_CAP",
    group: "pre-approval-qc",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "1",
    expected: "One provider review per day for the first proof.",
  },
  {
    name: "PROSPECT_QC_MODEL_DAILY_SPEND_CAP_CENTS",
    group: "pre-approval-qc",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "1",
    expected: "One-cent daily reservation ceiling for the first proof.",
  },
  {
    name: "PROSPECT_QC_MODEL_RESERVED_COST_CENTS",
    group: "pre-approval-qc",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "1",
    expected: "Reserve the full one-cent first-proof allowance before requesting the model.",
  },
  {
    name: "PROSPECT_QC_MODEL_TIMEOUT_MS",
    group: "pre-approval-qc",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "5000",
    expected: "Bounded provider timeout with no automatic uncertainty retry.",
  },
  {
    name: "PROSPECT_EMAIL_EXECUTION_ENABLED",
    group: "prospect-email",
    kind: "activation-switch",
    sensitive: false,
    fixedValue: "false",
    expected: "Keep false until one exact controlled seed or prospect send is separately approved.",
  },
  {
    name: "PROSPECT_EMAIL_EXECUTION_MODE",
    group: "prospect-email",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "single-recipient-reviewed-v1",
    expected: "One recipient, reviewed draft, and separate execution confirmation only.",
  },
  {
    name: "PROSPECT_EMAIL_RESEND_API_KEY",
    group: "prospect-email",
    kind: "provider-secret",
    sensitive: true,
    expected: "Dedicated Resend send key, distinct from owner-alert and receiving keys.",
  },
  {
    name: "PROSPECT_EMAIL_FROM",
    group: "prospect-email",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "SMIRK <outreach@smirkcalls.com>",
    expected: "Verified SMIRK sender identity.",
  },
  {
    name: "PROSPECT_EMAIL_REPLY_TO",
    group: "prospect-email",
    kind: "operator-value",
    sensitive: false,
    expected: "Dedicated monitored mailbox on smirkcalls.com or an approved subdomain.",
  },
  {
    name: "PROSPECT_EMAIL_WORKSPACE_ID",
    group: "prospect-email",
    kind: "operator-value",
    sensitive: false,
    expected: "Exact positive SMIRK workspace ID.",
  },
  {
    name: "PROSPECT_EMAIL_DAILY_RECIPIENT_CAP",
    group: "prospect-email",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "1",
    expected: "One recipient per day for the first production proof.",
  },
  {
    name: "PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS",
    group: "prospect-email",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "2",
    expected: "Two-cent daily reservation ceiling for the first production proof.",
  },
  {
    name: "PROSPECT_EMAIL_UNIT_COST_CENTS",
    group: "prospect-email",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "1",
    expected: "Conservative one-cent reservation per email.",
  },
  {
    name: "PROSPECT_EMAIL_WEBHOOK_ENABLED",
    group: "prospect-email",
    kind: "activation-switch",
    sensitive: false,
    fixedValue: "false",
    expected: "Keep false until the exact signed provider-event proof is approved.",
  },
  {
    name: "PROSPECT_EMAIL_RESEND_WEBHOOK_SECRET",
    group: "prospect-email",
    kind: "provider-secret",
    sensitive: true,
    expected: "Dedicated Resend signing secret for delivery, bounce, complaint, and reply events.",
  },
  {
    name: "PROSPECT_INBOX_SEED_ALLOWLIST",
    group: "prospect-email",
    kind: "operator-value",
    sensitive: true,
    expected: "Exactly two controlled Google, two Microsoft, and one Yahoo/AOL addresses.",
  },
  {
    name: "PROSPECT_EMAIL_RECEIVING_ENABLED",
    group: "closed-loop-learning",
    kind: "activation-switch",
    sensitive: false,
    fixedValue: "false",
    expected: "Keep false until one provider-backed plain-text reply retrieval is approved.",
  },
  {
    name: "PROSPECT_EMAIL_RECEIVING_MODE",
    group: "closed-loop-learning",
    kind: "fixed-value",
    sensitive: false,
    fixedValue: "operator-reviewed-content-v1",
    expected: "Operator-reviewed plain-text content retrieval only.",
  },
  {
    name: "PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY",
    group: "closed-loop-learning",
    kind: "provider-secret",
    sensitive: true,
    expected: "Dedicated Resend receiving key, distinct from all send and privileged keys.",
  },
  {
    name: "PROSPECT_EMAIL_RECEIVING_WORKSPACE_ID",
    group: "closed-loop-learning",
    kind: "operator-value",
    sensitive: false,
    expected: "Exact positive SMIRK workspace ID.",
  },
  {
    name: "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY",
    group: "closed-loop-learning",
    kind: "generated-secret",
    sensitive: true,
    expected: "Dedicated read-only observer key, at least 32 characters and distinct from operator keys.",
  },
  {
    name: "PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID",
    group: "closed-loop-learning",
    kind: "operator-value",
    sensitive: false,
    expected: "Exact positive SMIRK workspace ID.",
  },
  {
    name: "VELVET_OUTCOME_DISPATCH_ENABLED",
    group: "closed-loop-learning",
    kind: "activation-switch",
    sensitive: false,
    fixedValue: "false",
    expected: "Keep false until one signed outcome callback is explicitly approved.",
  },
];

const REQUIRED_GROUPS: Record<
  ProspectAcquisitionConfigurationPhaseId,
  ConfigurationVariableDefinition["group"][]
> = {
  "velvet-authority": ["velvet-authority"],
  "no-contact-discovery": [
    "velvet-authority",
    "no-contact-discovery",
  ],
  "pre-approval-qc": ["velvet-authority", "pre-approval-qc"],
  "controlled-inbox-placement": [
    "velvet-authority",
    "pre-approval-qc",
    "prospect-email",
  ],
  "single-recipient-email": [
    "velvet-authority",
    "pre-approval-qc",
    "prospect-email",
  ],
  "closed-loop-learning": [
    "velvet-authority",
    "no-contact-discovery",
    "pre-approval-qc",
    "prospect-email",
    "closed-loop-learning",
  ],
};

const EXTERNAL_PREREQUISITES: Record<
  ProspectAcquisitionConfigurationPhaseId,
  string[]
> = {
  "velvet-authority": [
    "Velvet holds distinct smirk:research and outcome:write credentials under one privileged owner.",
    "Velvet and SMIRK share the same workspace binding and separate HMAC signing secret.",
  ],
  "no-contact-discovery": [
    "Velvet Maps research and any Hunter enrichment have reviewed per-request costs and remain disabled until a bounded proof is approved.",
    "The Velvet discovery worker is one-job-at-a-time and has a reviewed maximum cost.",
  ],
  "pre-approval-qc": [
    "The dedicated OpenRouter key is funded only for the reviewed cap.",
    "The production schema contains the QC review and outreach binding fields after an approved backup and migration.",
  ],
  "controlled-inbox-placement": [
    "Resend has verified the sending identity and SPF, DKIM, and DMARC records.",
    "Exactly five operator-controlled seed inboxes exist: two Google, two Microsoft, and one Yahoo/AOL.",
    "The signed Resend webhook is configured for the reviewed delivery event set.",
  ],
  "single-recipient-email": [
    "A fresh immutable five-inbox PASS receipt matches the exact experiment and remains unexpired.",
    "The selected recipient has a durable reviewed source receipt and is not suppressed or opted out.",
  ],
  "closed-loop-learning": [
    "Resend receiving routes the monitored reply mailbox and exposes only bounded plain-text retrieval.",
    "Signed provider events and Velvet outcome callbacks pass replay and tamper rejection.",
    "Positive interaction pauses the loop, and learned candidates still require human policy release.",
  ],
};

function currentState(
  definition: ConfigurationVariableDefinition,
  env: Record<string, string | undefined>
): ConfigurationVariableState {
  const value = String(env[definition.name] || "").trim();
  let state: ConfigurationVariableState["state"];
  if (definition.kind === "activation-switch") {
    state =
      value === "true"
        ? "enabled-requires-separate-approval"
        : value === "" || value === "false"
          ? "safely-disabled"
          : "invalid-switch-value";
  } else if (definition.fixedValue !== undefined) {
    state =
      value === ""
        ? "missing"
        : value === definition.fixedValue
          ? "matches-fixed-value"
          : "drifted-from-fixed-value";
  } else {
    state = value ? "present-redacted" : "missing";
  }
  return {
    ...definition,
    state,
    currentValueDisclosed: false,
  };
}

function structuralDigest(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

export function buildProspectAcquisitionConfigurationPlan(input: {
  phase: ProspectAcquisitionConfigurationPhaseId;
  env: Record<string, string | undefined>;
  source: ProspectAcquisitionConnectionReadiness["source"];
}) {
  const readiness = buildProspectAcquisitionConnectionReadiness({
    env: input.env,
    source: input.source,
  });
  const runtimePhase = readiness.configurationPhases[input.phase];
  const groups = new Set(REQUIRED_GROUPS[input.phase]);
  const variables = VARIABLES.filter((definition) =>
    groups.has(definition.group)
  ).map((definition) => currentState(definition, input.env));
  const activationSwitches = variables.filter(
    (variable) => variable.kind === "activation-switch"
  );
  const enabledSwitches = activationSwitches
    .filter(
      (variable) =>
        variable.state === "enabled-requires-separate-approval"
    )
    .map((variable) => variable.name)
    .sort();
  const invalidSwitches = activationSwitches
    .filter((variable) => variable.state === "invalid-switch-value")
    .map((variable) => variable.name);
  const variableBlockers = variables
    .filter(
      (variable) =>
        variable.kind !== "activation-switch" &&
        (variable.state === "missing" ||
          variable.state === "drifted-from-fixed-value")
    )
    .map((variable) => variable.name);
  const phaseConfigurationBlockers = runtimePhase.blockers.filter(
    (blocker) => !ACTIVATION_SWITCHES.has(blocker)
  );
  const stagedConfigurationBlockers = [
    ...new Set([
      ...variableBlockers,
      ...invalidSwitches,
      ...phaseConfigurationBlockers,
    ]),
  ].sort();
  const stagedConfigurationReady =
    stagedConfigurationBlockers.length === 0;
  const allExecutionSwitchesDisabled = enabledSwitches.length === 0;
  const redactedPlanDigest = structuralDigest({
    contractVersion:
      PROSPECT_ACQUISITION_CONFIGURATION_PLAN_CONTRACT,
    phase: input.phase,
    variables: variables.map((variable) => ({
      name: variable.name,
      kind: variable.kind,
      state: variable.state,
    })),
    stagedConfigurationBlockers,
    enabledSwitches,
  });

  return {
    contractVersion:
      PROSPECT_ACQUISITION_CONFIGURATION_PLAN_CONTRACT,
    phase: input.phase,
    source: input.source,
    stagedConfigurationReady,
    safeStagingState:
      stagedConfigurationReady && allExecutionSwitchesDisabled,
    runtimePhaseConfigurationReady:
      runtimePhase.configurationReady,
    stagedConfigurationBlockers,
    requiredVariables: variables,
    activation: {
      authorized: false as const,
      explicitApprovalRequired:
        runtimePhase.explicitApprovalRequired,
      externalActionScope: runtimePhase.externalActionScope,
      allExecutionSwitchesDisabled,
      enabledSwitches,
      switchNames: activationSwitches
        .map((variable) => variable.name)
        .sort(),
      proofsStillRequired: runtimePhase.proofsStillRequired,
    },
    externalPrerequisites: EXTERNAL_PREREQUISITES[input.phase],
    redactedPlanDigest,
    digestLimitations: [
      "The digest binds this redacted plan shape and presence state, not secret bytes.",
      "Any future mutation receipt must privately bind exact values without printing them.",
    ],
    guardrails: {
      coldSmsAllowed: false as const,
      bulkEmailAllowed: false as const,
      automatedProspectDialingAllowed: false as const,
      qcMayAuthorizeContact: false as const,
      providerMutationPerformed: false as const,
      deployPerformed: false as const,
      contactAuthorized: false as const,
      spendAuthorized: false as const,
      currentEnvironmentValuesDisclosed: false as const,
    },
    nextCheckCommand: `npm run -s check:prospect-acquisition-connections -- --configuration-phase=${input.phase}`,
    externalAction: "none" as const,
  };
}

export function isProspectAcquisitionConfigurationPhase(
  value: string
): value is ProspectAcquisitionConfigurationPhaseId {
  return PROSPECT_ACQUISITION_CONFIGURATION_PHASES.includes(
    value as ProspectAcquisitionConfigurationPhaseId
  );
}
