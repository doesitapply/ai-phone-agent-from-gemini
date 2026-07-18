import { normalizeStrictMailbox } from "./email-safety.js";
import { normalizePublicHttpsUrl } from "./public-url-safety.js";

type SetupWorkspaceFields = {
  name?: unknown;
  owner_email?: unknown;
  business_name?: unknown;
  business_phone?: unknown;
  business_website?: unknown;
  business_address?: unknown;
  service_area?: unknown;
  business_hours?: unknown;
  escalation_preference?: unknown;
  proof_call_target?: unknown;
  inbound_greeting?: unknown;
  outbound_greeting?: unknown;
  owner_phone?: unknown;
  notification_email?: unknown;
};

export type BuyerSetupReadiness = {
  businessProfile: boolean;
  callbackPhone: boolean;
  serviceArea: boolean;
  operatingHours: boolean;
  greeting: boolean;
  escalationPreference: boolean;
  proofCallTarget: boolean;
  callRouting: boolean;
  ownerNotifications: boolean;
};

export type BuyerSetupBlocker = {
  key: string;
  label: string;
  nextAction: string;
};

export type BuyerSetupPatchIssue = {
  field: string;
  message: string;
};

const UNSAFE_TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MEANINGFUL_CHARACTER_RE = /[\p{L}\p{N}]/u;
const REDACTED_OR_PLACEHOLDER_RE = /^(?:__configured__|placeholder|undefined|null)$/i;
const EXACT_E164_RE = /^\+[1-9]\d{7,14}$/;

const cleanText = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const validMeaningfulText = (value: unknown, minLength: number, maxLength: number): boolean => {
  const normalized = cleanText(value);
  return normalized.length >= minLength
    && normalized.length <= maxLength
    && !UNSAFE_TEXT_CONTROL_RE.test(normalized)
    && !REDACTED_OR_PLACEHOLDER_RE.test(normalized)
    && MEANINGFUL_CHARACTER_RE.test(normalized);
};

export const isValidBuyerSetupBusinessName = (value: unknown): boolean => (
  validMeaningfulText(value, 2, 160)
);

export const isValidBuyerSetupEmail = (value: unknown): boolean => (
  Boolean(normalizeStrictMailbox(value))
);

export const isValidBuyerSetupPhone = (value: unknown): boolean => (
  EXACT_E164_RE.test(cleanText(value))
);

const normalizeBuyerSetupPhone = (value: unknown): string | null => {
  const raw = cleanText(value);
  if (!raw || /[^+\d\s().-]/.test(raw) || (raw.match(/\+/g) || []).length > 1 || (raw.includes("+") && !raw.startsWith("+"))) {
    return null;
  }
  const digits = raw.replace(/\D/g, "");
  const candidate = raw.startsWith("+")
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith("1")
        ? `+${digits}`
        : "";
  return EXACT_E164_RE.test(candidate) ? candidate : null;
};

const normalizeBuyerSetupWebsite = (value: unknown): string | null => {
  const raw = cleanText(value);
  if (!raw) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const safeUrl = normalizePublicHttpsUrl(candidate);
  if (!safeUrl) return null;
  const hostname = new URL(safeUrl).hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname.includes(".") || /(?:^|\.)(?:example|invalid|test)$/.test(hostname)) return null;
  return safeUrl;
};

export const isValidBuyerSetupWebsite = (value: unknown): boolean => (
  normalizeBuyerSetupWebsite(value) !== null
);

export const isValidBuyerSetupServiceArea = (value: unknown): boolean => (
  validMeaningfulText(value, 2, 500)
);

export const isValidBuyerSetupHours = (value: unknown): boolean => (
  validMeaningfulText(value, 3, 500)
);

export const isValidBuyerSetupGreeting = (value: unknown): boolean => (
  validMeaningfulText(value, 6, 2_000)
);

export const isValidBuyerSetupEscalation = (value: unknown): boolean => (
  validMeaningfulText(value, 8, 1_000)
);

const allProvidedValuesAreValid = (
  values: unknown[],
  validator: (value: unknown) => boolean,
): boolean => {
  const provided = values.filter((value) => cleanText(value));
  return provided.length > 0 && provided.every(validator);
};

export function getBuyerSetupReadiness(
  workspace: SetupWorkspaceFields,
  workspaceTwilioNumber?: unknown,
): BuyerSetupReadiness {
  const businessName = cleanText(workspace.business_name) || cleanText(workspace.name);
  const contactEmails = [workspace.owner_email, workspace.notification_email];
  const callbackPhones = [workspace.owner_phone, workspace.business_phone];
  const serviceArea = cleanText(workspace.service_area) || cleanText(workspace.business_address);
  const contactEmailReady = allProvidedValuesAreValid(contactEmails, isValidBuyerSetupEmail);
  const callbackPhoneReady = allProvidedValuesAreValid(callbackPhones, isValidBuyerSetupPhone);
  const outboundGreeting = cleanText(workspace.outbound_greeting);

  return {
    businessProfile: isValidBuyerSetupBusinessName(businessName)
      && contactEmailReady
      && isValidBuyerSetupWebsite(workspace.business_website),
    callbackPhone: callbackPhoneReady,
    serviceArea: isValidBuyerSetupServiceArea(serviceArea),
    operatingHours: isValidBuyerSetupHours(workspace.business_hours),
    greeting: isValidBuyerSetupGreeting(workspace.inbound_greeting)
      && (!outboundGreeting || isValidBuyerSetupGreeting(outboundGreeting)),
    escalationPreference: isValidBuyerSetupEscalation(workspace.escalation_preference),
    proofCallTarget: isValidBuyerSetupPhone(workspace.proof_call_target),
    callRouting: isValidBuyerSetupPhone(workspaceTwilioNumber),
    ownerNotifications: contactEmailReady,
  };
}

const BUYER_SETUP_BLOCKERS: Array<{
  readinessKey: keyof BuyerSetupReadiness;
  blocker: BuyerSetupBlocker;
}> = [
  {
    readinessKey: "businessProfile",
    blocker: {
      key: "business_profile",
      label: "Business profile",
      nextAction: "Save a real business name, valid owner email, and an HTTPS business website if one is provided.",
    },
  },
  {
    readinessKey: "callbackPhone",
    blocker: {
      key: "callback_phone",
      label: "Callback phone",
      nextAction: "Save owner and business callback numbers in international E.164 format, such as +17754204485.",
    },
  },
  {
    readinessKey: "serviceArea",
    blocker: {
      key: "service_area",
      label: "Service area",
      nextAction: "Add a real city, region, address, or service area.",
    },
  },
  {
    readinessKey: "operatingHours",
    blocker: {
      key: "operating_hours",
      label: "Operating hours",
      nextAction: "Add meaningful operating hours so the agent can set caller expectations.",
    },
  },
  {
    readinessKey: "greeting",
    blocker: {
      key: "greeting",
      label: "Inbound greeting",
      nextAction: "Save a meaningful, owner-approved inbound greeting and a valid outbound greeting if one is provided.",
    },
  },
  {
    readinessKey: "escalationPreference",
    blocker: {
      key: "escalation_preference",
      label: "Escalation preference",
      nextAction: "Describe how urgent calls should reach a human.",
    },
  },
  {
    readinessKey: "proofCallTarget",
    blocker: {
      key: "proof_call_target",
      label: "Proof-call target",
      nextAction: "Save the owner-approved proof-call number in international E.164 format.",
    },
  },
  {
    readinessKey: "callRouting",
    blocker: {
      key: "call_routing",
      label: "Call routing",
      nextAction: "Provision or connect a valid E.164 Twilio phone number for this workspace.",
    },
  },
  {
    readinessKey: "ownerNotifications",
    blocker: {
      key: "owner_notifications",
      label: "Owner notifications",
      nextAction: "Save valid owner and notification email addresses.",
    },
  },
];

export function getBuyerSetupBlockers(
  workspace: SetupWorkspaceFields,
  workspaceTwilioNumber?: unknown,
): BuyerSetupBlocker[] {
  const readiness = getBuyerSetupReadiness(workspace, workspaceTwilioNumber);
  return BUYER_SETUP_BLOCKERS
    .filter(({ readinessKey }) => readiness[readinessKey] !== true)
    .map(({ blocker }) => blocker);
}

const BUYER_PATCH_MAX_LENGTHS: Record<string, number> = {
  name: 160,
  timezone: 100,
  mode: 40,
  business_name: 160,
  business_tagline: 300,
  business_phone: 16,
  business_website: 2_048,
  business_address: 500,
  service_area: 500,
  business_hours: 500,
  escalation_preference: 1_000,
  proof_call_target: 16,
  agent_name: 80,
  agent_persona: 8_000,
  inbound_greeting: 2_000,
  outbound_greeting: 2_000,
  owner_phone: 16,
  notification_email: 254,
};

export function validateBuyerSetupPatch(patch: Record<string, unknown>): {
  normalizedPatch: Record<string, unknown>;
  issues: BuyerSetupPatchIssue[];
} {
  const normalizedPatch: Record<string, unknown> = {};
  const issues: BuyerSetupPatchIssue[] = [];

  for (const [field, value] of Object.entries(patch)) {
    if (value === null) {
      normalizedPatch[field] = null;
      continue;
    }
    if (typeof value !== "string") {
      issues.push({ field, message: "must be a text value" });
      continue;
    }
    const normalized = value.trim();
    if (UNSAFE_TEXT_CONTROL_RE.test(normalized) || normalized.length > (BUYER_PATCH_MAX_LENGTHS[field] || 2_000)) {
      issues.push({ field, message: "contains unsupported characters or is too long" });
      continue;
    }
    normalizedPatch[field] = normalized;
  }

  const addIssue = (field: string, message: string) => {
    if (!issues.some((issue) => issue.field === field)) issues.push({ field, message });
  };
  const suppliedText = (field: string): string | null => (
    Object.prototype.hasOwnProperty.call(normalizedPatch, field) && typeof normalizedPatch[field] === "string"
      ? String(normalizedPatch[field])
      : null
  );

  for (const field of ["name", "business_name"]) {
    const value = suppliedText(field);
    if (value !== null && !isValidBuyerSetupBusinessName(value)) {
      addIssue(field, "must be a meaningful business name between 2 and 160 characters");
    }
  }
  for (const field of ["business_phone", "owner_phone", "proof_call_target"]) {
    const value = suppliedText(field);
    if (value) {
      const normalizedPhone = normalizeBuyerSetupPhone(value);
      if (!normalizedPhone) addIssue(field, "must be a valid phone number, such as +17754204485");
      else normalizedPatch[field] = normalizedPhone;
    }
  }

  const notificationEmail = suppliedText("notification_email");
  if (notificationEmail !== null) {
    const normalizedEmail = normalizeStrictMailbox(notificationEmail);
    if (!normalizedEmail) addIssue("notification_email", "must be a valid non-placeholder email address");
    else normalizedPatch.notification_email = normalizedEmail.toLowerCase();
  }

  const businessWebsite = suppliedText("business_website");
  if (businessWebsite) {
    const normalizedWebsite = normalizeBuyerSetupWebsite(businessWebsite);
    if (!normalizedWebsite) addIssue("business_website", "must be a public HTTPS URL without credentials or a local IP address");
    else normalizedPatch.business_website = normalizedWebsite;
  }

  for (const field of ["inbound_greeting", "outbound_greeting"]) {
    const value = suppliedText(field);
    if (value && !isValidBuyerSetupGreeting(value)) {
      addIssue(field, "must be a meaningful greeting between 6 and 2000 characters");
    }
  }
  const serviceArea = suppliedText("service_area");
  if (serviceArea && !isValidBuyerSetupServiceArea(serviceArea)) {
    addIssue("service_area", "must be a meaningful city, region, address, or service area");
  }
  const businessHours = suppliedText("business_hours");
  if (businessHours && !isValidBuyerSetupHours(businessHours)) {
    addIssue("business_hours", "must contain meaningful operating hours");
  }
  const escalationPreference = suppliedText("escalation_preference");
  if (escalationPreference && !isValidBuyerSetupEscalation(escalationPreference)) {
    addIssue("escalation_preference", "must meaningfully describe how urgent calls reach a human");
  }

  const mode = suppliedText("mode");
  if (mode && !["general", "missed_call_recovery"].includes(mode)) {
    addIssue("mode", "must be general or missed_call_recovery");
  }
  const timezone = suppliedText("timezone");
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
      addIssue("timezone", "must be a valid IANA timezone");
    }
  }

  return { normalizedPatch, issues };
}
