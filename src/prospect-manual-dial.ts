export const PROSPECT_MANUAL_DIAL_HANDOFF_VERSION =
  "smirk.prospect-manual-dial-handoff.v1" as const;

export type ProspectManualDialReceipt = {
  recipient: string;
  recipientTimezone: string;
  checkedAt: string;
  validUntil: string;
  dncChecks: Array<{
    scope: "federal" | "state" | "internal";
    status: "clear";
    source: string;
    reference: string;
  }>;
  callingWindow: {
    start: "09:00";
    end: "17:00";
  };
  manualDialOnly: true;
  contactAuthorizedByReceipt: false;
  automatedDialingAuthorized: false;
};

export type ProspectManualDialAvailability = {
  contractVersion: typeof PROSPECT_MANUAL_DIAL_HANDOFF_VERSION;
  eligible: boolean;
  code:
    | "ELIGIBLE"
    | "INVALID_RECIPIENT"
    | "INVALID_RECEIPT"
    | "RECEIPT_NOT_YET_VALID"
    | "RECEIPT_EXPIRED"
    | "OUTSIDE_CALLING_WINDOW";
  detail: string;
  localTime: string | null;
  href: string | null;
  contactAuthorized: false;
  automatedDialingAuthorized: false;
};

const E164 = /^\+[1-9]\d{7,14}$/;
const REQUIRED_DNC_SCOPES = ["federal", "state", "internal"] as const;
const MAX_RECEIPT_AGE_MS = 24 * 60 * 60 * 1_000;

function blocked(
  code: Exclude<ProspectManualDialAvailability["code"], "ELIGIBLE">,
  detail: string,
  localTime: string | null = null
): ProspectManualDialAvailability {
  return {
    contractVersion: PROSPECT_MANUAL_DIAL_HANDOFF_VERSION,
    eligible: false,
    code,
    detail,
    localTime,
    href: null,
    contactAuthorized: false,
    automatedDialingAuthorized: false,
  };
}

function validReceipt(
  receipt: ProspectManualDialReceipt,
  recipient: string
): boolean {
  if (
    receipt.recipient !== recipient ||
    receipt.callingWindow?.start !== "09:00" ||
    receipt.callingWindow?.end !== "17:00" ||
    receipt.manualDialOnly !== true ||
    receipt.contactAuthorizedByReceipt !== false ||
    receipt.automatedDialingAuthorized !== false ||
    !Array.isArray(receipt.dncChecks) ||
    receipt.dncChecks.length !== REQUIRED_DNC_SCOPES.length
  ) {
    return false;
  }
  const scopes = new Set<string>();
  for (const check of receipt.dncChecks) {
    if (
      !REQUIRED_DNC_SCOPES.includes(check.scope) ||
      scopes.has(check.scope) ||
      check.status !== "clear" ||
      String(check.source || "").trim().length < 2 ||
      String(check.reference || "").trim().length < 6
    ) {
      return false;
    }
    scopes.add(check.scope);
  }
  return REQUIRED_DNC_SCOPES.every(scope => scopes.has(scope));
}

function recipientLocalTime(
  now: Date,
  timezone: string
): { label: string; minuteOfDay: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find(part => part.type === type)?.value || "";
    const hour = Number(value("hour"));
    const minute = Number(value("minute"));
    if (
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return null;
    }
    return {
      label: `${value("year")}-${value("month")}-${value("day")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      minuteOfDay: hour * 60 + minute,
    };
  } catch {
    return null;
  }
}

export function getProspectManualDialAvailability(input: {
  recipient: string;
  receipt: ProspectManualDialReceipt | null | undefined;
  now?: Date;
}): ProspectManualDialAvailability {
  const recipient = String(input.recipient || "").trim();
  if (!E164.test(recipient)) {
    return blocked(
      "INVALID_RECIPIENT",
      "The approved recipient is not a valid E.164 phone number."
    );
  }
  if (!input.receipt || !validReceipt(input.receipt, recipient)) {
    return blocked(
      "INVALID_RECEIPT",
      "The approved three-scope manual-call receipt is unavailable or invalid."
    );
  }

  const now = input.now || new Date();
  if (!Number.isFinite(now.getTime())) {
    return blocked("INVALID_RECEIPT", "The current clock is invalid.");
  }
  const checkedAt = new Date(input.receipt.checkedAt);
  const validUntil = new Date(input.receipt.validUntil);
  if (
    !Number.isFinite(checkedAt.getTime()) ||
    !Number.isFinite(validUntil.getTime()) ||
    validUntil.getTime() <= checkedAt.getTime() ||
    validUntil.getTime() - checkedAt.getTime() > MAX_RECEIPT_AGE_MS
  ) {
    return blocked(
      "INVALID_RECEIPT",
      "The manual-call receipt validity interval is invalid."
    );
  }
  if (now.getTime() < checkedAt.getTime()) {
    return blocked(
      "RECEIPT_NOT_YET_VALID",
      "The reviewed call receipt is not valid yet."
    );
  }
  if (now.getTime() > validUntil.getTime()) {
    return blocked(
      "RECEIPT_EXPIRED",
      "The reviewed DNC and calling-window receipt has expired."
    );
  }

  const local = recipientLocalTime(now, input.receipt.recipientTimezone);
  if (!local) {
    return blocked(
      "INVALID_RECEIPT",
      "The recipient timezone in the call receipt is invalid."
    );
  }
  if (local.minuteOfDay < 9 * 60 || local.minuteOfDay >= 17 * 60) {
    return blocked(
      "OUTSIDE_CALLING_WINDOW",
      "The recipient is outside the reviewed 09:00-17:00 local calling window.",
      local.label
    );
  }

  return {
    contractVersion: PROSPECT_MANUAL_DIAL_HANDOFF_VERSION,
    eligible: true,
    code: "ELIGIBLE",
    detail:
      "The approved recipient is inside the reviewed manual-call window.",
    localTime: local.label,
    href: `tel:${recipient}`,
    contactAuthorized: false,
    automatedDialingAuthorized: false,
  };
}
