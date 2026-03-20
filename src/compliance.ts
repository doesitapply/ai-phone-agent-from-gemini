/**
 * Compliance Module — TCPA / telemarketing compliance rails
 *
 * Responsibilities:
 * 1. DNC (Do Not Call) registry — hard suppression across ALL outbound, all campaigns
 * 2. Consent flags — track whether a number has given express written consent
 * 3. Call recording disclosure — auto-play disclosure where required by state law
 * 4. Timezone-aware call windows — enforce 8am-9pm local time per TCPA
 * 5. Audit trail — immutable log of every outbound dial attempt and its compliance check
 * 6. Opt-out persistence — any "remove me" / "stop calling" triggers DNC across all campaigns
 */

import { sql } from "./db.js";

// ── Schema init ───────────────────────────────────────────────────────────────
export async function initComplianceSchema() {
  // DNC list — hard suppression, never dialed outbound
  await sql`
    CREATE TABLE IF NOT EXISTS dnc_list (
      id           SERIAL PRIMARY KEY,
      phone        TEXT NOT NULL UNIQUE,
      reason       TEXT,                          -- 'caller_request' | 'tcpa_complaint' | 'manual' | 'auto_detected'
      source       TEXT DEFAULT 'manual',
      added_by     TEXT,                          -- workspace_id or 'system'
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Consent records — express written consent tracking
  await sql`
    CREATE TABLE IF NOT EXISTS consent_records (
      id              SERIAL PRIMARY KEY,
      phone           TEXT NOT NULL,
      consent_type    TEXT NOT NULL DEFAULT 'none',  -- 'express_written' | 'verbal' | 'none'
      consent_date    TIMESTAMPTZ,
      consent_source  TEXT,                           -- 'web_form' | 'sms_optin' | 'verbal_call' | 'manual'
      revoked         BOOLEAN DEFAULT FALSE,
      revoked_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(phone)
    )
  `;

  // Compliance audit log — immutable record of every outbound dial decision
  await sql`
    CREATE TABLE IF NOT EXISTS compliance_audit (
      id              SERIAL PRIMARY KEY,
      phone           TEXT NOT NULL,
      campaign_id     INTEGER,
      action          TEXT NOT NULL,               -- 'dialed' | 'blocked_dnc' | 'blocked_hours' | 'blocked_consent' | 'opt_out_detected'
      reason          TEXT,
      call_sid        TEXT,
      checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Add migration: add consent_flag to prospect_leads if not exists
  await sql`
    ALTER TABLE prospect_leads
    ADD COLUMN IF NOT EXISTS consent_flag TEXT DEFAULT 'unknown'  -- 'express_written' | 'verbal' | 'unknown' | 'none'
  `;

  // Add migration: add recording_disclosure_played to calls if not exists
  await sql`
    ALTER TABLE calls
    ADD COLUMN IF NOT EXISTS recording_disclosure_played BOOLEAN DEFAULT FALSE
  `;
}

// ── State recording laws ──────────────────────────────────────────────────────
// States that require ALL-PARTY consent for call recording
const ALL_PARTY_CONSENT_STATES = new Set([
  "CA", "CT", "FL", "IL", "MD", "MA", "MI", "MN", "MT", "NV",
  "NH", "OR", "PA", "WA",
]);

// Area code → state mapping (major area codes)
const AREA_CODE_STATE: Record<string, string> = {
  "205": "AL", "251": "AL", "256": "AL", "334": "AL",
  "907": "AK",
  "480": "AZ", "520": "AZ", "602": "AZ", "623": "AZ", "928": "AZ",
  "479": "AR", "501": "AR", "870": "AR",
  "209": "CA", "213": "CA", "310": "CA", "323": "CA", "408": "CA",
  "415": "CA", "424": "CA", "442": "CA", "510": "CA", "530": "CA",
  "559": "CA", "562": "CA", "619": "CA", "626": "CA", "628": "CA",
  "650": "CA", "657": "CA", "661": "CA", "669": "CA", "707": "CA",
  "714": "CA", "747": "CA", "760": "CA", "805": "CA", "818": "CA",
  "831": "CA", "858": "CA", "909": "CA", "916": "CA", "925": "CA",
  "949": "CA", "951": "CA",
  "303": "CO", "719": "CO", "720": "CO", "970": "CO",
  "203": "CT", "475": "CT", "860": "CT",
  "302": "DE",
  "202": "DC",
  "239": "FL", "305": "FL", "321": "FL", "352": "FL", "386": "FL",
  "407": "FL", "561": "FL", "727": "FL", "754": "FL", "772": "FL",
  "786": "FL", "813": "FL", "850": "FL", "863": "FL", "904": "FL",
  "941": "FL", "954": "FL",
  "229": "GA", "404": "GA", "470": "GA", "478": "GA", "678": "GA",
  "706": "GA", "762": "GA", "770": "GA", "912": "GA",
  "808": "HI",
  "208": "ID",
  "217": "IL", "224": "IL", "309": "IL", "312": "IL", "331": "IL",
  "618": "IL", "630": "IL", "708": "IL", "773": "IL", "815": "IL",
  "847": "IL", "872": "IL",
  "219": "IN", "260": "IN", "317": "IN", "463": "IN", "574": "IN",
  "765": "IN", "812": "IN", "930": "IN",
  "319": "IA", "515": "IA", "563": "IA", "641": "IA", "712": "IA",
  "316": "KS", "620": "KS", "785": "KS", "913": "KS",
  "270": "KY", "364": "KY", "502": "KY", "606": "KY", "859": "KY",
  "225": "LA", "318": "LA", "337": "LA", "504": "LA", "985": "LA",
  "207": "ME",
  "240": "MD", "301": "MD", "410": "MD", "443": "MD", "667": "MD",
  "339": "MA", "351": "MA", "413": "MA", "508": "MA", "617": "MA",
  "774": "MA", "781": "MA", "857": "MA", "978": "MA",
  "231": "MI", "248": "MI", "269": "MI", "313": "MI", "517": "MI",
  "586": "MI", "616": "MI", "734": "MI", "810": "MI", "906": "MI",
  "947": "MI", "989": "MI",
  "218": "MN", "320": "MN", "507": "MN", "612": "MN", "651": "MN",
  "763": "MN", "952": "MN",
  "228": "MS", "601": "MS", "662": "MS", "769": "MS",
  "314": "MO", "417": "MO", "573": "MO", "636": "MO", "660": "MO",
  "816": "MO",
  "406": "MT",
  "308": "NE", "402": "NE", "531": "NE",
  "702": "NV", "725": "NV", "775": "NV",
  "603": "NH",
  "201": "NJ", "551": "NJ", "609": "NJ", "732": "NJ", "848": "NJ",
  "856": "NJ", "862": "NJ", "908": "NJ", "973": "NJ",
  "505": "NM", "575": "NM",
  "212": "NY", "315": "NY", "332": "NY", "347": "NY", "516": "NY",
  "518": "NY", "585": "NY", "607": "NY", "631": "NY", "646": "NY",
  "680": "NY", "716": "NY", "718": "NY", "845": "NY", "914": "NY",
  "917": "NY", "929": "NY", "934": "NY",
  "252": "NC", "336": "NC", "704": "NC", "743": "NC", "828": "NC",
  "910": "NC", "919": "NC", "980": "NC", "984": "NC",
  "701": "ND",
  "216": "OH", "220": "OH", "234": "OH", "330": "OH", "380": "OH",
  "419": "OH", "440": "OH", "513": "OH", "567": "OH", "614": "OH",
  "740": "OH", "937": "OH",
  "405": "OK", "539": "OK", "580": "OK", "918": "OK",
  "458": "OR", "503": "OR", "541": "OR", "971": "OR",
  "215": "PA", "223": "PA", "267": "PA", "272": "PA", "412": "PA",
  "445": "PA", "484": "PA", "570": "PA", "610": "PA", "717": "PA",
  "724": "PA", "814": "PA", "878": "PA",
  "401": "RI",
  "803": "SC", "839": "SC", "843": "SC", "854": "SC", "864": "SC",
  "605": "SD",
  "423": "TN", "615": "TN", "629": "TN", "731": "TN", "865": "TN",
  "901": "TN", "931": "TN",
  "210": "TX", "214": "TX", "254": "TX", "281": "TX", "325": "TX",
  "346": "TX", "361": "TX", "409": "TX", "430": "TX", "432": "TX",
  "469": "TX", "512": "TX", "682": "TX", "713": "TX", "726": "TX",
  "737": "TX", "806": "TX", "817": "TX", "830": "TX", "832": "TX",
  "903": "TX", "915": "TX", "936": "TX", "940": "TX", "956": "TX",
  "972": "TX", "979": "TX",
  "385": "UT", "435": "UT", "801": "UT",
  "802": "VT",
  "276": "VA", "434": "VA", "540": "VA", "571": "VA", "703": "VA",
  "757": "VA", "804": "VA",
  "206": "WA", "253": "WA", "360": "WA", "425": "WA", "509": "WA",
  "564": "WA",
  "304": "WV", "681": "WV",
  "262": "WI", "414": "WI", "534": "WI", "608": "WI", "715": "WI",
  "920": "WI",
  "307": "WY",
};

// Timezone by state (IANA)
const STATE_TIMEZONE: Record<string, string> = {
  "AL": "America/Chicago", "AK": "America/Anchorage", "AZ": "America/Phoenix",
  "AR": "America/Chicago", "CA": "America/Los_Angeles", "CO": "America/Denver",
  "CT": "America/New_York", "DE": "America/New_York", "DC": "America/New_York",
  "FL": "America/New_York", "GA": "America/New_York", "HI": "Pacific/Honolulu",
  "ID": "America/Boise", "IL": "America/Chicago", "IN": "America/Indiana/Indianapolis",
  "IA": "America/Chicago", "KS": "America/Chicago", "KY": "America/New_York",
  "LA": "America/Chicago", "ME": "America/New_York", "MD": "America/New_York",
  "MA": "America/New_York", "MI": "America/Detroit", "MN": "America/Chicago",
  "MS": "America/Chicago", "MO": "America/Chicago", "MT": "America/Denver",
  "NE": "America/Chicago", "NV": "America/Los_Angeles", "NH": "America/New_York",
  "NJ": "America/New_York", "NM": "America/Denver", "NY": "America/New_York",
  "NC": "America/New_York", "ND": "America/Chicago", "OH": "America/New_York",
  "OK": "America/Chicago", "OR": "America/Los_Angeles", "PA": "America/New_York",
  "RI": "America/New_York", "SC": "America/New_York", "SD": "America/Chicago",
  "TN": "America/Chicago", "TX": "America/Chicago", "UT": "America/Denver",
  "VT": "America/New_York", "VA": "America/New_York", "WA": "America/Los_Angeles",
  "WV": "America/New_York", "WI": "America/Chicago", "WY": "America/Denver",
};

// ── Core compliance check ─────────────────────────────────────────────────────
export interface ComplianceCheckResult {
  allowed: boolean;
  reason?: string;
  requiresDisclosure: boolean;
  disclosureText?: string;
  state?: string;
  timezone?: string;
  nextValidWindow?: Date;  // when blocked_by_quiet_hours: earliest UTC time to retry
  blockedReason?: "quiet_hours" | "weekend" | "unknown_timezone" | "dnc" | "consent";
}

/**
 * Compute the next valid local window open time as a UTC Date.
 * Window: Mon–Fri 10:00–17:00 local.
 */
export function nextValidWindowUTC(tz: string, windowStartHour = 10): Date {
  const now = new Date();
  // Try today first, then advance day by day until we hit a weekday
  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const candidate = new Date(now.getTime() + daysAhead * 86_400_000);
    // Set to windowStartHour:00 local
    const localMidnight = new Date(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      }).format(candidate).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2") + "T00:00:00"
    );
    // Build a date string in local time at windowStartHour
    const localStr = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(candidate);
    const [m, d, y] = localStr.split("/");
    // Create a UTC Date that corresponds to windowStartHour:00 in tz on that day
    const windowOpen = new Date(
      `${y}-${m}-${d}T${String(windowStartHour).padStart(2, "0")}:00:00`
    );
    // Adjust for timezone offset
    const tzOffsetMs = windowOpen.getTime() -
      new Date(new Intl.DateTimeFormat("en-US", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      }).format(windowOpen).replace(
        /(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/,
        "$3-$1-$2T$4:$5:$6"
      )).getTime();
    const windowOpenUTC = new Date(windowOpen.getTime() + tzOffsetMs);
    const dayName = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(windowOpenUTC);
    if (!["Sat", "Sun"].includes(dayName) && windowOpenUTC > now) {
      return windowOpenUTC;
    }
  }
  // Fallback: 7 days from now
  return new Date(now.getTime() + 7 * 86_400_000);
}

export async function checkOutboundCompliance(
  phone: string,
  campaignId?: number,
  callWindowStart = "10:00",  // safe default: 10am local
  callWindowEnd   = "17:00"   // safe default: 5pm local
): Promise<ComplianceCheckResult> {
  const normalized = normalizePhone(phone);

  // 1. Hard DNC check — never dial if on DNC list
  const [dncRow] = await sql`SELECT id FROM dnc_list WHERE phone = ${normalized}`;
  if (dncRow) {
    await logComplianceAudit(normalized, campaignId, "blocked_dnc", "Phone is on DNC list");
    return { allowed: false, reason: "Phone is on the Do Not Call list", requiresDisclosure: false, blockedReason: "dnc" };
  }

  // 2. Timezone resolution — area code → state → IANA tz
  const areaCode = normalized.replace(/\D/g, "").slice(1, 4);
  const state = AREA_CODE_STATE[areaCode];

  // HARD RULE: if timezone is unknown, skip — do NOT default to Eastern
  if (!state || !STATE_TIMEZONE[state]) {
    await logComplianceAudit(normalized, campaignId, "blocked_by_quiet_hours",
      `Unknown timezone for area code ${areaCode} — skipping until resolved`);
    return {
      allowed: false,
      reason: `Cannot determine local timezone for area code ${areaCode}. Call skipped until timezone is resolved.`,
      requiresDisclosure: false,
      blockedReason: "unknown_timezone",
    };
  }

  const tz = STATE_TIMEZONE[state];
  const now = new Date();
  const localHour = parseInt(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now)
  );
  const localMinuteStr = new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone: tz }).format(now);
  const localMinutes = localHour * 60 + parseInt(localMinuteStr);
  const localDay = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(now);
  const isWeekend = localDay === "Sat" || localDay === "Sun";

  // 3. Weekend block — no cold outreach on weekends
  if (isWeekend) {
    const nextWindow = nextValidWindowUTC(tz, 10);
    await logComplianceAudit(normalized, campaignId, "blocked_by_quiet_hours",
      `Weekend — ${localDay} in ${tz}. Next window: ${nextWindow.toISOString()}`);
    return {
      allowed: false,
      reason: `Outbound calls are restricted to weekdays (currently ${localDay} in ${tz})`,
      requiresDisclosure: false,
      timezone: tz,
      state,
      nextValidWindow: nextWindow,
      blockedReason: "weekend",
    };
  }

  // 4. Campaign-specific window (hard gate: 10am–5pm local by default)
  const [startH, startM] = callWindowStart.split(":").map(Number);
  const [endH, endM] = callWindowEnd.split(":").map(Number);
  const windowStart = startH * 60 + (startM || 0);
  const windowEnd   = endH   * 60 + (endM   || 0);

  if (localMinutes < windowStart || localMinutes >= windowEnd) {
    const nextWindow = nextValidWindowUTC(tz, startH);
    await logComplianceAudit(normalized, campaignId, "blocked_by_quiet_hours",
      `Outside window ${callWindowStart}–${callWindowEnd} local (${tz}). Local time: ${localHour}:${localMinuteStr.padStart(2,"0")}. Next: ${nextWindow.toISOString()}`);
    return {
      allowed: false,
      reason: `Outside calling window (${callWindowStart}–${callWindowEnd} local time in ${tz})`,
      requiresDisclosure: false,
      timezone: tz,
      state,
      nextValidWindow: nextWindow,
      blockedReason: "quiet_hours",
    };
  }

  // 3. Determine if recording disclosure is required
  const requiresDisclosure = state ? ALL_PARTY_CONSENT_STATES.has(state) : false;
  const disclosureText = requiresDisclosure
    ? "This call may be recorded for quality and training purposes."
    : undefined;

  await logComplianceAudit(normalized, campaignId, "dialed", `Passed all checks. State: ${state || "unknown"}`);

  return { allowed: true, requiresDisclosure, disclosureText, state };
}

// ── DNC management ────────────────────────────────────────────────────────────
export async function addToDNC(phone: string, reason = "manual", source = "manual", addedBy = "operator") {
  const normalized = normalizePhone(phone);
  await sql`
    INSERT INTO dnc_list (phone, reason, source, added_by)
    VALUES (${normalized}, ${reason}, ${source}, ${addedBy})
    ON CONFLICT (phone) DO NOTHING
  `;
  await logComplianceAudit(normalized, undefined, "opt_out_detected", `Added to DNC: ${reason}`);
}

export async function isOnDNC(phone: string): Promise<boolean> {
  const normalized = normalizePhone(phone);
  const [row] = await sql`SELECT id FROM dnc_list WHERE phone = ${normalized}`;
  return !!row;
}

export async function getDNCList(): Promise<{ phone: string; reason: string; created_at: string }[]> {
  return await sql`SELECT phone, reason, source, added_by, created_at FROM dnc_list ORDER BY created_at DESC`;
}

export async function removeFromDNC(phone: string) {
  const normalized = normalizePhone(phone);
  await sql`DELETE FROM dnc_list WHERE phone = ${normalized}`;
}

// ── Opt-out detection (called from post-call intelligence) ────────────────────
const OPT_OUT_PHRASES = [
  "do not call", "don't call", "stop calling", "remove me", "take me off",
  "unsubscribe", "opt out", "opt-out", "not interested", "never call again",
  "put me on your do not call", "add me to your do not call",
];

export async function detectOptOut(transcript: string, phone: string): Promise<boolean> {
  const lower = transcript.toLowerCase();
  const triggered = OPT_OUT_PHRASES.some((phrase) => lower.includes(phrase));
  if (triggered) {
    await addToDNC(phone, "caller_request", "auto_detected", "system");
    console.log(`[COMPLIANCE] Auto-DNC triggered for ${phone} based on transcript`);
  }
  return triggered;
}

// ── Consent management ────────────────────────────────────────────────────────
export async function recordConsent(
  phone: string,
  consentType: "express_written" | "verbal" | "none",
  source: string
) {
  const normalized = normalizePhone(phone);
  await sql`
    INSERT INTO consent_records (phone, consent_type, consent_date, consent_source)
    VALUES (${normalized}, ${consentType}, NOW(), ${source})
    ON CONFLICT (phone) DO UPDATE
    SET consent_type = ${consentType}, consent_date = NOW(), consent_source = ${source}, revoked = FALSE
  `;
}

export async function getConsentStatus(phone: string) {
  const normalized = normalizePhone(phone);
  const [row] = await sql`SELECT * FROM consent_records WHERE phone = ${normalized}`;
  return row || null;
}

// ── Audit log ─────────────────────────────────────────────────────────────────
async function logComplianceAudit(
  phone: string,
  campaignId: number | undefined,
  action: string,
  reason: string,
  callSid?: string
) {
  try {
    await sql`
      INSERT INTO compliance_audit (phone, campaign_id, action, reason, call_sid)
      VALUES (${phone}, ${campaignId ?? null}, ${action}, ${reason}, ${callSid ?? null})
    `;
  } catch { /* non-blocking */ }
}

export async function getComplianceAudit(limit = 100) {
  return await sql`
    SELECT * FROM compliance_audit ORDER BY checked_at DESC LIMIT ${limit}
  `;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return phone; // return as-is if can't normalize
}

export function getRecordingDisclosure(phone: string): string | null {
  const areaCode = phone.replace(/\D/g, "").slice(1, 4);
  const state = AREA_CODE_STATE[areaCode];
  if (state && ALL_PARTY_CONSENT_STATES.has(state)) {
    return "This call may be recorded for quality and training purposes.";
  }
  return null;
}
