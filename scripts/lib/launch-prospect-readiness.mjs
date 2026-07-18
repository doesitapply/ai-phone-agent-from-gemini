import fs from "node:fs";
import path from "node:path";

export const LAUNCH_PROSPECT_READINESS_SCHEMA = "smirk.launch-prospect-readiness.v1";
export const LAUNCH_PROSPECT_EVIDENCE_MAX_AGE_DAYS = 90;

const dayMs = 24 * 60 * 60 * 1000;
const supportedChannels = new Set(["website_form", "email", "linkedin", "phone"]);
const directWebsitePathPattern = /(?:^|\/)(?:contact(?:-us)?|request(?:-service|-estimate|-quote)?|estimate|quote|book(?:ing)?|schedule|project)(?:\/|$)/i;
const publicContactEvidencePattern = /\bpublic\b[^.;\n]{0,80}\b(?:contact|booking|estimate|quote|request|project)\b[^.;\n]{0,50}\b(?:form|page|email|path)\b/i;
const phoneDemandEvidencePattern = /\b24\s*\/\s*7\b|\bemergenc(?:y|ies)\b|\bafter[-\s]?hours\b|\bmissed[-\s]?calls?\b|\bappointments?\b|\bservice\s+(?:calls?|requests?)\b|\bphone\s+demand\b|\bcall\s+volume\b/i;

function clean(value) {
  return String(value ?? "").trim();
}

function isExactZero(value) {
  if (typeof value === "number") return Number.isInteger(value) && value === 0;
  return /^0+$/.test(clean(value));
}

function addBlocker(blockers, condition, code) {
  if (!condition) blockers.push(code);
}

function untouchedFirstTouchState(row) {
  const response = clean(row?.response).toLowerCase();
  const proof = clean(row?.proof_walkthrough_status).toLowerCase();
  const checkout = clean(row?.checkout_status).toLowerCase();
  const activation = clean(row?.activation_status).toLowerCase();
  return clean(row?.next_state).toLowerCase() === "researched"
    && isExactZero(row?.touch_count)
    && isExactZero(row?.spend_cents)
    && (response === "" || response === "no_response")
    && (proof === "" || proof === "not_requested")
    && (checkout === "" || checkout === "not_started")
    && (activation === "" || activation === "not_started")
    && !clean(row?.objection)
    && !clean(row?.last_touch_at);
}

export function parseLaunchProspectCsv(text) {
  const records = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) records.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim())) records.push(row);
  }
  const [headers = [], ...dataRows] = records;
  return dataRows.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header.trim(), clean(values[index])])),
  );
}

export function loadLaunchProspectRows(root = process.cwd()) {
  const launchDir = path.resolve(root, "docs", "launch");
  const files = fs.readdirSync(launchDir)
    .filter((file) => /^prospect-batch-.*\.csv$/.test(file))
    .sort()
    .map((file) => path.join("docs", "launch", file));
  const rows = files.flatMap((file) => {
    const batch = path.basename(file, ".csv");
    return parseLaunchProspectCsv(fs.readFileSync(path.resolve(root, file), "utf8")).map((row, index) => ({
      ...row,
      batch,
      input_file: file,
      input_index: index + 1,
    }));
  });
  return { files, rows };
}

export function launchProspectNoteValue(notes, key) {
  const pattern = new RegExp(`(?:^|;\\s*)${String(key).replace(/[^a-z0-9_]/gi, "")}=([^;]+)`, "i");
  return clean(clean(notes).match(pattern)?.[1]);
}

function publicHttpsUrl(value) {
  try {
    const parsed = new URL(clean(value));
    return parsed.protocol === "https:" && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizedHost(value) {
  try {
    return new URL(clean(value)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function directContactPath(channel, contactUrl, notes) {
  const value = clean(contactUrl);
  if (channel === "website_form") {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && Boolean(parsed.hostname) && directWebsitePathPattern.test(parsed.pathname);
    } catch {
      return false;
    }
  }
  if (channel === "email") {
    return /^(?:mailto:)?[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value);
  }
  if (channel === "linkedin") {
    return /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company)\//i.test(value);
  }
  if (channel === "phone") {
    return publicHttpsUrl(value) && /\bhuman[-\s]?approved phone\b/i.test(clean(notes));
  }
  return false;
}

function namedOwnerOrOperator(value) {
  const owner = clean(value);
  if (!owner || /^(?:public(?:_|\s)|unknown|team\b|contact\b|general\b|owner\/operator\b)/i.test(owner)) return false;
  if (/@|https?:\/\//i.test(owner)) return false;
  return /^[\p{L}][\p{L}'’.\-]*(?:\s+[\p{L}][\p{L}'’.\-]*){0,4}$/u.test(owner);
}

function verifiedDate(notes) {
  const match = clean(notes).match(/\brefreshed\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? { date: match[1], timestamp } : null;
}

export function evaluateLaunchProspectReadiness(row, options = {}) {
  const notes = clean(row?.notes);
  const channel = clean(row?.channel).toLowerCase();
  const sourceUrl = clean(row?.source_url) || launchProspectNoteValue(notes, "source_url");
  const contactUrl = clean(row?.contact_url) || launchProspectNoteValue(notes, "contact_url");
  const verification = verifiedDate(notes);
  const baseResearchState =
    clean(row?.next_state).toLowerCase() === "researched"
    && isExactZero(row?.touch_count)
    && isExactZero(row?.spend_cents);
  const referenceTime = options.referenceTime instanceof Date
    ? options.referenceTime.getTime()
    : Number.isFinite(Number(options.referenceTime))
      ? Number(options.referenceTime)
      : Date.now();
  const evidenceAgeDays = verification ? Math.floor((referenceTime - verification.timestamp) / dayMs) : null;
  const maxAgeDays = Number.isFinite(Number(options.maxAgeDays))
    ? Math.max(0, Number(options.maxAgeDays))
    : LAUNCH_PROSPECT_EVIDENCE_MAX_AGE_DAYS;
  const signals = {
    supported_channel: supportedChannels.has(channel),
    researched_zero_touch_zero_spend: baseResearchState,
    untouched_first_touch_candidate: untouchedFirstTouchState(row),
    no_send_provenance: /\bno (?:message|outreach) sent\b/i.test(notes),
    public_source_url: publicHttpsUrl(sourceUrl),
    direct_contact_path: directContactPath(channel, contactUrl, notes),
    contact_source_consistent:
      channel !== "website_form"
      || (Boolean(normalizedHost(sourceUrl)) && normalizedHost(sourceUrl) === normalizedHost(contactUrl)),
    public_contact_evidence: publicContactEvidencePattern.test(notes),
    named_owner_or_operator: namedOwnerOrOperator(row?.owner_contact),
    phone_demand_evidence: phoneDemandEvidencePattern.test(notes),
    research_verification_present: Boolean(verification),
    research_verification_fresh:
      evidenceAgeDays !== null && evidenceAgeDays >= 0 && evidenceAgeDays <= maxAgeDays,
  };
  const blockers = [];
  addBlocker(blockers, signals.supported_channel, "unsupported-channel");
  addBlocker(blockers, signals.researched_zero_touch_zero_spend, "not-researched-zero-touch-zero-spend");
  addBlocker(blockers, signals.untouched_first_touch_candidate, "first-touch-state-progressed");
  addBlocker(blockers, signals.no_send_provenance, "no-send-provenance-missing");
  addBlocker(blockers, signals.public_source_url, "public-source-url-unverified");
  addBlocker(blockers, signals.direct_contact_path, "direct-contact-path-unverified");
  addBlocker(blockers, signals.contact_source_consistent, "contact-source-host-mismatch");
  addBlocker(blockers, signals.public_contact_evidence, "public-contact-evidence-missing");
  addBlocker(
    blockers,
    signals.named_owner_or_operator || signals.phone_demand_evidence,
    "owner-or-phone-demand-evidence-missing",
  );
  addBlocker(blockers, signals.research_verification_present, "research-verification-date-missing");
  if (signals.research_verification_present) {
    addBlocker(blockers, signals.research_verification_fresh, "research-verification-not-current");
  }

  return {
    schema: LAUNCH_PROSPECT_READINESS_SCHEMA,
    execution_ready: blockers.length === 0,
    research_verified_at: verification?.date || null,
    evidence_age_days: evidenceAgeDays,
    max_evidence_age_days: maxAgeDays,
    signals,
    blockers,
  };
}

export function summarizeLaunchProspectReadiness(rows, options = {}) {
  const evaluations = rows.map((row) => ({ row, readiness: evaluateLaunchProspectReadiness(row, options) }));
  const candidates = evaluations.filter(({ readiness }) => readiness.signals.untouched_first_touch_candidate);
  const ready = evaluations.filter(({ readiness }) => readiness.execution_ready);
  const blockerCounts = new Map();
  for (const { readiness } of evaluations) {
    for (const blocker of readiness.blockers) blockerCounts.set(blocker, (blockerCounts.get(blocker) || 0) + 1);
  }
  return {
    schema: LAUNCH_PROSPECT_READINESS_SCHEMA,
    rows_reviewed: evaluations.length,
    researched_prospects: candidates.length,
    candidate_prospects: candidates.length,
    execution_ready_prospects: ready.length,
    researched_only_prospects: candidates.length - ready.length,
    progressed_or_non_candidate_prospects: evaluations.length - candidates.length,
    by_blocker: Object.fromEntries([...blockerCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    ready_by_region: Object.fromEntries(
      [...ready.reduce((counts, { row }) => {
        const region = clean(row.region) || "unknown";
        counts.set(region, (counts.get(region) || 0) + 1);
        return counts;
      }, new Map()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    ),
    evaluations,
  };
}
