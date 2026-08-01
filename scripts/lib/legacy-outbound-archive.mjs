import { createHash } from "node:crypto";

const REQUIRED_HEADERS = [
  "sent_at",
  "company",
  "vertical",
  "region",
  "email",
  "touch_number",
  "subject",
  "message_variant",
  "resend_id",
  "status",
  "response",
  "notes",
  "batch",
  "contact_url",
];

const ALLOWED_STATUSES = new Set(["sent", "bounced", "failed"]);
const POSITIVE_RESPONSES = new Set([
  "interested",
  "positive_followup",
  "question_or_objection",
]);

export function parseLegacyOutboundCsv(text) {
  const records = [];
  let record = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      record.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      record.push(cell);
      if (record.some(value => value.length > 0)) records.push(record);
      record = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("unterminated-quoted-field");
  if (cell.length > 0 || record.length > 0) {
    record.push(cell);
    if (record.some(value => value.length > 0)) records.push(record);
  }

  const [headers = [], ...values] = records;
  return {
    headers: headers.map(header => header.trim()),
    rows: values.map((row, index) => ({
      rowNumber: index + 2,
      width: row.length,
      value: Object.fromEntries(
        headers.map((header, column) => [header.trim(), String(row[column] || "").trim()]),
      ),
    })),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function countBy(values) {
  return Object.fromEntries(
    [...values.reduce((counts, value) => {
      counts.set(value, (counts.get(value) || 0) + 1);
      return counts;
    }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function auditLegacyOutboundArchive(input) {
  const parsed = parseLegacyOutboundCsv(input.ledgerText);
  const blockers = [];
  if (
    parsed.headers.length !== REQUIRED_HEADERS.length ||
    REQUIRED_HEADERS.some((header, index) => parsed.headers[index] !== header)
  ) {
    blockers.push("LEGACY_LEDGER_HEADERS_INVALID");
  }

  const providerIds = new Set();
  const recipientTouches = new Set();
  const recipients = new Set();
  for (const item of parsed.rows) {
    const row = item.value;
    const email = row.email.toLowerCase();
    const touch = Number.parseInt(row.touch_number, 10);
    if (item.width !== parsed.headers.length) {
      blockers.push(`LEGACY_LEDGER_ROW_WIDTH_INVALID:${item.rowNumber}`);
    }
    if (!row.company || !/^\S+@\S+\.\S+$/.test(email)) {
      blockers.push(`LEGACY_LEDGER_IDENTITY_INVALID:${item.rowNumber}`);
    }
    if (!Number.isInteger(touch) || touch < 1 || touch > 3) {
      blockers.push(`LEGACY_LEDGER_TOUCH_INVALID:${item.rowNumber}`);
    }
    if (!Number.isFinite(Date.parse(row.sent_at))) {
      blockers.push(`LEGACY_LEDGER_TIMESTAMP_INVALID:${item.rowNumber}`);
    }
    if (!ALLOWED_STATUSES.has(row.status)) {
      blockers.push(`LEGACY_LEDGER_STATUS_INVALID:${item.rowNumber}`);
    }
    if (!row.resend_id) {
      blockers.push(`LEGACY_LEDGER_PROVIDER_ID_MISSING:${item.rowNumber}`);
    } else if (providerIds.has(row.resend_id)) {
      blockers.push(`LEGACY_LEDGER_PROVIDER_ID_DUPLICATE:${item.rowNumber}`);
    } else {
      providerIds.add(row.resend_id);
    }
    const recipientTouch = `${email}:${touch}`;
    if (recipientTouches.has(recipientTouch)) {
      blockers.push(`LEGACY_LEDGER_RECIPIENT_TOUCH_DUPLICATE:${item.rowNumber}`);
    } else {
      recipientTouches.add(recipientTouch);
    }
    if (email) recipients.add(email);
  }

  const suppressionEntries = input.suppressionText
    .split(/\r?\n/)
    .map(line => line.trim().toLowerCase())
    .filter(line => line && !line.startsWith("#"));
  if (new Set(suppressionEntries).size !== suppressionEntries.length) {
    blockers.push("LEGACY_SUPPRESSION_DUPLICATE");
  }

  const rows = parsed.rows.map(item => item.value);
  const measuredResponses = rows.filter(row =>
    row.response && row.response !== "no_response"
  );
  const accepted = rows.filter(row => row.status === "sent");
  const bounced = rows.filter(row => row.status === "bounced");
  const failed = rows.filter(row => row.status === "failed");

  return {
    contractVersion: "smirk.legacy-outbound-archive-audit.v1",
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
    source: {
      ledgerSha256: sha256(input.ledgerText),
      suppressionSha256: sha256(input.suppressionText),
    },
    counts: {
      providerAttempts: rows.length,
      providerAcceptedNotDeliveryProven: accepted.length,
      bounced: bounced.length,
      failed: failed.length,
      uniqueRecipients: recipients.size,
      touches: countBy(rows.map(row => `touch_${row.touch_number || "invalid"}`)),
      variants: countBy(rows.map(row => row.message_variant || "unknown")),
      measuredResponses: measuredResponses.length,
      positiveResponses: measuredResponses.filter(row =>
        POSITIVE_RESPONSES.has(row.response)
      ).length,
      suppressions: suppressionEntries.length,
    },
    interpretation: {
      providerAcceptanceIsDeliveryProof: false,
      zeroLoggedRepliesIsInboxPlacementProof: false,
      canonicalSmirkReconciliation: "NOT_RECONCILED",
      eligibleForFrozenExperiment: false,
      eligibleForCausalPolicyPromotion: false,
      historicalObservationalEvidenceOnly: true,
    },
    controls: {
      readOnly: true,
      contactAuthorized: false,
      executionAuthorized: false,
      providerRequestAuthorized: false,
      spendAuthorized: false,
      policyMutationAuthorized: false,
    },
    externalAction: "none",
  };
}
