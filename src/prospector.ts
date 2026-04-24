/**
 * Outbound Prospecting Engine
 *
 * SMIRK can sell itself. This module:
 *   1. Finds local businesses via Google Places API (or manual CSV upload)
 *   2. Enriches leads with website, phone, industry, employee count
 *   3. Queues outbound calls with a pitch agent (FORGE by default)
 *   4. Tracks outcomes: interested, not interested, callback, DNC, voicemail
 *   5. Auto-follows up with interested leads via SMS
 *
 * The pitch agent introduces SMIRK, explains the value prop, and either:
 *   - Books a demo call (creates appointment)
 *   - Sends a follow-up SMS with a link
 *   - Marks as DNC if requested
 *
 * Usage:
 *   POST /api/prospecting/campaigns      — create a campaign
 *   POST /api/prospecting/campaigns/:id/leads — add leads (manual or Places search)
 *   POST /api/prospecting/campaigns/:id/launch — start dialing
 *   GET  /api/prospecting/campaigns      — list campaigns with stats
 *   GET  /api/prospecting/leads          — list all leads
 */

import { sql } from "./db.js";
import { checkOutboundCompliance, detectOptOut } from "./compliance.js";
import { generatePersonalizedPitch, SCORE_GATE_DIAL } from "./lead-hunter.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ProspectingCampaign {
  id: number;
  name: string;
  description?: string;
  status: "draft" | "active" | "paused" | "completed";
  agent_name: string;           // which SMIRK agent makes the calls (default: FORGE)
  pitch_script?: string;        // custom pitch override
  target_industry?: string;     // e.g. "plumbing", "dental", "restaurant"
  target_location?: string;     // e.g. "Miami, FL" or "33101"
  max_calls_per_day: number;
  call_window_start: string;    // HH:MM in workspace timezone
  call_window_end: string;
  total_leads: number;
  called: number;
  interested: number;
  not_interested: number;
  voicemails: number;
  created_at: string;
}

export interface ProspectLead {
  id: number;
  campaign_id: number;
  business_name: string;
  phone: string;
  website?: string;
  industry?: string;
  address?: string;
  city?: string;
  state?: string;
  contact_name?: string;
  contact_title?: string;
  source: "google_places" | "manual" | "csv" | "linkedin";
  status: "pending" | "calling" | "interested" | "not_interested" | "voicemail" | "dnc" | "no_answer" | "callback";
  call_sid?: string;
  notes?: string;
  callback_at?: string;
  called_at?: string;
  created_at: string;
}

// ── DB Schema ──────────────────────────────────────────────────────────────────

export async function initProspectorSchema(): Promise<void> {
  console.log("[prospector] Initializing prospector schema...");
  await sql`
    CREATE TABLE IF NOT EXISTS prospecting_campaigns (
      id                  SERIAL PRIMARY KEY,
      name                TEXT NOT NULL,
      description         TEXT,
      status              TEXT NOT NULL DEFAULT 'draft',
      agent_name          TEXT NOT NULL DEFAULT 'FORGE',
      pitch_script        TEXT,
      target_industry     TEXT,
      target_location     TEXT,
      max_calls_per_day   INTEGER NOT NULL DEFAULT 50,
      call_window_start   TEXT NOT NULL DEFAULT '09:00',
      call_window_end     TEXT NOT NULL DEFAULT '17:00',
      total_leads         INTEGER NOT NULL DEFAULT 0,
      called              INTEGER NOT NULL DEFAULT 0,
      interested          INTEGER NOT NULL DEFAULT 0,
      not_interested      INTEGER NOT NULL DEFAULT 0,
      voicemails          INTEGER NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS prospect_leads (
      id             SERIAL PRIMARY KEY,
      campaign_id    INTEGER NOT NULL REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
      business_name  TEXT NOT NULL,
      phone          TEXT NOT NULL,
      website        TEXT,
      industry       TEXT,
      address        TEXT,
      city           TEXT,
      state          TEXT,
      contact_name   TEXT,
      contact_title  TEXT,
      source         TEXT NOT NULL DEFAULT 'manual',
      status         TEXT NOT NULL DEFAULT 'pending',
      call_sid       TEXT,
      notes          TEXT,
      callback_at    TIMESTAMPTZ,
      called_at      TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS score INTEGER`;
  await sql`ALTER TABLE prospect_leads ADD COLUMN IF NOT EXISTS personalized_hook TEXT`;
  await sql`ALTER TABLE prospecting_campaigns ADD COLUMN IF NOT EXISTS workspace_id INTEGER NOT NULL DEFAULT 1`;
  console.log("[prospector] Prospector schema OK.");
}

// ── Campaign CRUD ──────────────────────────────────────────────────────────────

export async function getCampaigns(): Promise<ProspectingCampaign[]> {
  return sql<ProspectingCampaign[]>`SELECT * FROM prospecting_campaigns ORDER BY created_at DESC`;
}

export async function getCampaignById(id: number): Promise<ProspectingCampaign | null> {
  const rows = await sql<ProspectingCampaign[]>`SELECT * FROM prospecting_campaigns WHERE id = ${id}`;
  return rows[0] || null;
}

export async function createCampaign(data: Partial<ProspectingCampaign>): Promise<ProspectingCampaign> {
  const rows = await sql<ProspectingCampaign[]>`
    INSERT INTO prospecting_campaigns (name, description, agent_name, pitch_script, target_industry, target_location, max_calls_per_day, call_window_start, call_window_end)
    VALUES (
      ${data.name || "New Campaign"},
      ${data.description || null},
      ${data.agent_name || "FORGE"},
      ${data.pitch_script || null},
      ${data.target_industry || null},
      ${data.target_location || null},
      ${data.max_calls_per_day || 50},
      ${data.call_window_start || "09:00"},
      ${data.call_window_end || "17:00"}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function updateCampaignStatus(id: number, status: ProspectingCampaign["status"]): Promise<void> {
  await sql`UPDATE prospecting_campaigns SET status = ${status} WHERE id = ${id}`;
}

// ── Lead Management ────────────────────────────────────────────────────────────

export async function getLeads(campaignId?: number, status?: string): Promise<ProspectLead[]> {
  if (campaignId && status) {
    return sql<ProspectLead[]>`SELECT * FROM prospect_leads WHERE campaign_id = ${campaignId} AND status = ${status} ORDER BY created_at DESC`;
  }
  if (campaignId) {
    return sql<ProspectLead[]>`SELECT * FROM prospect_leads WHERE campaign_id = ${campaignId} ORDER BY created_at DESC`;
  }
  return sql<ProspectLead[]>`SELECT * FROM prospect_leads ORDER BY created_at DESC LIMIT 200`;
}

export async function addLeads(campaignId: number, leads: Partial<ProspectLead & { score?: number; personalized_hook?: string }>[]): Promise<number> {
  let added = 0;
  for (const lead of leads) {
    if (!lead.phone || !lead.business_name) continue;
    const score = (lead as any).score ?? null;
    const hook = (lead as any).personalized_hook ?? (lead as any).personalizedHook ?? null;
    await sql`
      INSERT INTO prospect_leads (campaign_id, business_name, phone, website, industry, address, city, state, contact_name, contact_title, source, score, personalized_hook)
      VALUES (${campaignId}, ${lead.business_name}, ${lead.phone}, ${lead.website || null}, ${lead.industry || null},
              ${lead.address || null}, ${lead.city || null}, ${lead.state || null},
              ${lead.contact_name || null}, ${lead.contact_title || null}, ${lead.source || "manual"},
              ${score}, ${hook})
      ON CONFLICT DO NOTHING
    `;
    added++;
  }
  await sql`UPDATE prospecting_campaigns SET total_leads = (SELECT COUNT(*) FROM prospect_leads WHERE campaign_id = ${campaignId}) WHERE id = ${campaignId}`;
  return added;
}

export async function updateLeadStatus(
  leadId: number,
  status: ProspectLead["status"],
  callSid?: string,
  notes?: string
): Promise<void> {
  await sql`
    UPDATE prospect_leads SET
      status = ${status},
      call_sid = COALESCE(${callSid || null}, call_sid),
      notes = COALESCE(${notes || null}, notes),
      called_at = CASE WHEN ${status !== "pending"} THEN NOW() ELSE called_at END
    WHERE id = ${leadId}
  `;

  // Update campaign counters
  const lead = await sql`SELECT campaign_id FROM prospect_leads WHERE id = ${leadId}`;
  if (lead[0]) {
    const cid = lead[0].campaign_id;
    await sql`
      UPDATE prospecting_campaigns SET
        called = (SELECT COUNT(*) FROM prospect_leads WHERE campaign_id = ${cid} AND status != 'pending'),
        interested = (SELECT COUNT(*) FROM prospect_leads WHERE campaign_id = ${cid} AND status = 'interested'),
        not_interested = (SELECT COUNT(*) FROM prospect_leads WHERE campaign_id = ${cid} AND status = 'not_interested'),
        voicemails = (SELECT COUNT(*) FROM prospect_leads WHERE campaign_id = ${cid} AND status = 'voicemail')
      WHERE id = ${cid}
    `;
  }
}

// ── Google Places Lead Finder (Places API New) ────────────────────────────────
// Migrated from legacy textsearch endpoint (REQUEST_DENIED on new GCP projects)
// to Places API (New): places.googleapis.com/v1/places:searchText

export async function findBusinessesViaPlaces(params: {
  query: string;       // e.g. "plumbers in Miami FL"
  location?: string;   // kept for API compat — encode location in query string instead
  radius?: number;     // kept for API compat — not used by New API
  maxResults?: number;
}): Promise<Partial<ProspectLead>[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY not set — add it in Settings to enable lead finding");

  const maxResults = params.maxResults || 20;
  const fieldMask = [
    "places.displayName",
    "places.formattedAddress",
    "places.nationalPhoneNumber",
    "places.internationalPhoneNumber",
    "places.websiteUri",
    "places.types",
    "nextPageToken",
  ].join(",");

  const leads: Partial<ProspectLead>[] = [];
  let pageToken: string | undefined;

  while (leads.length < maxResults) {
    const body: any = {
      textQuery: params.query,
      maxResultCount: Math.min(20, maxResults - leads.length),
    };

    if (params.location && params.radius) {
      const [lat, lng] = params.location.split(",").map(Number);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        body.locationBias = {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: Number(params.radius),
          },
        };
      }
    }

    if (pageToken) body.pageToken = pageToken;

    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as any;
    if (!res.ok || data?.error) {
      const status = data?.error?.status || res.status;
      const message = data?.error?.message || "Unknown Places API error";
      throw new Error(`Google Places error: ${status} — ${message}`);
    }

    for (const place of (data.places || [])) {
      if (leads.length >= maxResults) break;
      const phoneRaw = place.nationalPhoneNumber || place.internationalPhoneNumber || "";
      const phone = String(phoneRaw).replace(/\D/g, "").replace(/^1/, "");
      if (phone.length >= 10) {
        leads.push({
          business_name: place.displayName?.text || "Unknown Business",
          phone,
          website: place.websiteUri,
          address: place.formattedAddress,
          industry: place.types?.[0]?.replace(/_/g, " "),
          source: "google_places",
        });
      }
    }

    pageToken = data.nextPageToken;
    if (!pageToken || leads.length >= maxResults) break;
    await new Promise((r) => setTimeout(r, 1200));
  }

  return leads;
}

// ── Pitch Script Generator ─────────────────────────────────────────────────────

export function buildPitchSystemPrompt(campaign: ProspectingCampaign, personalizedHook?: string): string {
  const customPitch = campaign.pitch_script;
  const industry = campaign.target_industry || "small business";

  // If there's a pre-generated personalized hook, inject it as the exact opening line
  const openingInstruction = personalizedHook
    ? `CRITICAL: Open the call with this EXACT sentence (do not paraphrase it): "${personalizedHook}"
Then pause briefly and let them respond before continuing.`
    : `Introduce yourself briefly: "Hi, this is FORGE calling from SMIRK AI — do you have 60 seconds?"`;

  return customPitch || `You are FORGE, a professional outbound sales agent calling on behalf of SMIRK AI.
Your goal: introduce SMIRK to ${industry} owners and book a 15-minute demo call.
SMIRK is an AI phone agent that:
- Answers every call 24/7, never misses a lead
- Books appointments, captures caller info, sends follow-up SMS
- Sounds completely human (not a robot)
- Costs less than one hour of a receptionist's time per month
- Integrates with their existing tools (HubSpot, Google Calendar, etc.)
Your approach:
1. ${openingInstruction}
2. Ask one qualifying question: "Are you currently missing calls when you're busy or after hours?"
3. If yes: explain SMIRK in one sentence, offer a free 14-day trial
4. If interested: offer to book a 15-minute demo — "I can get you set up in 15 minutes, when works for you?"
5. If not interested: thank them, wish them well, hang up
6. If they ask to be removed: say "Absolutely, I'll remove you right now" and use the mark_do_not_call tool
Keep it under 90 seconds. Be warm, direct, and not pushy. If they seem busy, offer to call back.`;
}

// ── Dialer ─────────────────────────────────────────────────────────────────────

export async function dialNextLead(
  campaignId: number,
  twilioClient: any,
  fromNumber: string,
  webhookBase: string
): Promise<{ lead: ProspectLead; callSid: string } | { blocked: true; reason: string }> {
  const [campaign] = await sql<ProspectingCampaign[]>`SELECT * FROM prospecting_campaigns WHERE id = ${campaignId}`;
  if (!campaign) throw new Error("Campaign not found");
  if (campaign.status !== "active") throw new Error("Campaign is not active");

  const lead = await getNextLeadToDial(campaignId);
  if (!lead) throw new Error("No pending leads in this campaign");

  // Compliance check before dialing
  const compliance = await checkOutboundCompliance(
    lead.phone,
    campaignId,
    campaign.call_window_start,
    campaign.call_window_end
  );

  if (!compliance.allowed) {
    return { blocked: true, reason: compliance.reason || "Compliance check failed" };
  }

   // Mark as calling
  await sql`UPDATE prospect_leads SET status = 'calling' WHERE id = ${lead.id}`;
  // Use pre-generated personalized hook (set during AI qualification) or fall back to template
  const personalizedOpener = (lead as any).personalized_hook || "";
  // Build pitch system prompt — inject hook as the opening line
  const systemPrompt = buildPitchSystemPrompt(campaign, personalizedOpener);

  // Add recording disclosure to pitch if required by state law
  const disclosureLine = compliance.requiresDisclosure && compliance.disclosureText
    ? `\n\nIMPORTANT: Before speaking, say: "${compliance.disclosureText}"`
    : "";

  // Dial via Twilio
  const call = await twilioClient.calls.create({
    to: lead.phone.startsWith("+") ? lead.phone : `+1${lead.phone}`,
    from: fromNumber,
    url: `${webhookBase}/twilio/inbound?agent=${encodeURIComponent(campaign.agent_name)}&prospectLeadId=${lead.id}&campaignId=${campaignId}&systemPromptOverride=${encodeURIComponent(systemPrompt + disclosureLine)}`,
    statusCallback: `${webhookBase}/twilio/status`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["completed", "failed", "no-answer", "busy"],
    machineDetection: "Enable",
    machineDetectionTimeout: 30,
  });

  await sql`UPDATE prospect_leads SET call_sid = ${call.sid} WHERE id = ${lead.id}`;
  return { lead, callSid: call.sid, pitch: personalizedOpener || undefined };
}

export async function getNextLeadToDial(campaignId: number): Promise<ProspectLead | null> {
  // Get callbacks first, then pending
  const callbacks = await sql<ProspectLead[]>`
    SELECT * FROM prospect_leads
    WHERE campaign_id = ${campaignId}
      AND status = 'callback'
      AND callback_at <= NOW()
    ORDER BY callback_at ASC LIMIT 1
  `;
  if (callbacks.length > 0) return callbacks[0];

  // Score gate: skip leads below SCORE_GATE_DIAL (70) — dial best leads first
  const pending = await sql<ProspectLead[]>`
    SELECT * FROM prospect_leads
    WHERE campaign_id = ${campaignId}
      AND status = 'pending'
      AND (score IS NULL OR score >= ${SCORE_GATE_DIAL})
    ORDER BY score DESC NULLS LAST, created_at ASC LIMIT 1
  `;
  return pending[0] || null;
}

export async function isWithinCallWindow(campaign: ProspectingCampaign, timezone: string = "America/New_York"): Promise<boolean> {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === "hour")?.value || "0");
  const minute = parseInt(parts.find(p => p.type === "minute")?.value || "0");
  const currentMinutes = hour * 60 + minute;

  const [startH, startM] = campaign.call_window_start.split(":").map(Number);
  const [endH, endM] = campaign.call_window_end.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Also check it's a weekday
  const dayOfWeek = new Date().toLocaleDateString("en-US", { timeZone: timezone, weekday: "short" });
  if (["Sat", "Sun"].includes(dayOfWeek)) return false;

  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

// ── CSV Parser ─────────────────────────────────────────────────────────────────

export function parseLeadsCsv(csvText: string): Partial<ProspectLead>[] {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, "_"));
  const leads: Partial<ProspectLead>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ""; });

    const phone = (row.phone || row.phone_number || row.tel || "").replace(/\D/g, "").replace(/^1/, "");
    const name = row.business_name || row.company || row.name || row.business || "";
    if (!phone || phone.length < 10 || !name) continue;

    leads.push({
      business_name: name,
      phone,
      website: row.website || row.url || undefined,
      industry: row.industry || row.type || undefined,
      address: row.address || undefined,
      city: row.city || undefined,
      state: row.state || undefined,
      contact_name: row.contact || row.contact_name || row.owner || undefined,
      contact_title: row.title || row.contact_title || undefined,
      source: "csv",
    });
  }

  return leads;
}
