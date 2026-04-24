/**
 * Lead Hunter — Autonomous Cold Outreach Engine
 *
 * Capabilities:
 *   1. Apollo.io people/company search → ICP-locked, enriched lead list
 *   2. Google Maps Places API → local business lead scraping with real scoring
 *   3. AI qualification layer → post-scrape LLM ICP fit scoring
 *   4. Campaign sequencing: call → email follow-up
 *   5. Lead scoring and qualification tracking
 *
 * ICP Definition (SMIRK target customer):
 *   - Owner, GM, or C-suite of a home services business
 *   - 1–50 employees (solo ops to small teams)
 *   - Verticals: HVAC, plumbing, electrical, roofing, landscaping, pest control,
 *     cleaning, painting, handyman, pool service, garage door, locksmith
 *   - Has a phone number (they take calls)
 *   - Not a franchise HQ or national chain
 *
 * Score gate: leads below 65 are not saved. Leads below 70 are not dialed.
 */

import { sql } from "./db.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LeadSearchParams {
  jobTitles?: string[];        // e.g. ["Owner", "General Manager"] — defaults to ICP titles if omitted
  industries?: string[];       // e.g. ["HVAC", "Plumbing"] — defaults to home services if omitted
  locations?: string[];        // e.g. ["Austin, TX", "Dallas, TX"]
  companySize?: string;        // e.g. "1-10", "11-50" — defaults to "1-50" if omitted
  keywords?: string[];         // free-text keywords
  limit?: number;              // max leads to return (default 25)
  minScore?: number;           // minimum score to include (default 65)
  skipAiQualification?: boolean; // skip AI qualification pass (faster, lower quality)
}

export interface Lead {
  id?: number;
  name: string;
  phone?: string;
  email?: string;
  company?: string;
  title?: string;
  industry?: string;
  location?: string;
  linkedinUrl?: string;
  website?: string;
  score?: number;              // 0-100 lead quality score
  icpFit?: string;             // AI qualification summary
  source: "apollo" | "google_maps" | "manual" | "csv";
  rawData?: Record<string, unknown>;
}

export interface Campaign {
  id?: number;
  name: string;
  agentId?: number;
  callReason: string;
  pitchTemplate: string;       // AI-personalized pitch template
  targetLeads: number[];       // lead IDs
  status: "draft" | "active" | "paused" | "completed";
  callsScheduled?: number;
  callsCompleted?: number;
  conversionsCount?: number;
  workspaceId?: number;
}

// ── ICP Constants ─────────────────────────────────────────────────────────────

// Titles that indicate decision-making authority at a small home services business
const ICP_JOB_TITLES = [
  "Owner", "Co-Owner", "Business Owner", "General Manager",
  "Operations Manager", "CEO", "President", "Founder",
  "Managing Director", "Principal",
];

// Apollo industry tag IDs for home services verticals
// These are Apollo's canonical industry strings (not IDs)
const ICP_INDUSTRIES = [
  "consumer services",
  "facilities services",
  "construction",
  "building materials",
  "environmental services",
  "real estate",
];

// Home services keywords that indicate a SMIRK-fit business
const HOME_SERVICES_KEYWORDS = [
  "hvac", "plumbing", "electrical", "roofing", "landscaping",
  "pest control", "cleaning", "painting", "handyman", "pool",
  "garage door", "locksmith", "heating", "cooling", "air conditioning",
  "lawn care", "tree service", "gutters", "windows", "flooring",
  "remodeling", "restoration", "waterproofing", "insulation",
];

// Minimum score thresholds
export const SCORE_GATE_SAVE = 65;   // don't save leads below this
export const SCORE_GATE_DIAL = 70;   // don't dial leads below this

// ── Apollo.io Lead Search ─────────────────────────────────────────────────────
// Hard cap: never fetch more than 200 leads per search to protect Apollo credits
const APOLLO_MAX_LEADS = 200;
const APOLLO_PAGE_SIZE = 25;

export async function searchLeadsApollo(params: LeadSearchParams): Promise<Lead[]> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY not configured");

  const requestedLimit = Math.min(params.limit || 25, APOLLO_MAX_LEADS);
  const minScore = params.minScore ?? SCORE_GATE_SAVE;
  const allLeads: Lead[] = [];
  let page = 1;
  let totalPages = 1;

  // ICP-locked query: default to SMIRK ICP if caller doesn't specify
  const baseBody: Record<string, unknown> = {
    api_key: apiKey,
    per_page: Math.min(APOLLO_PAGE_SIZE, requestedLimit * 2), // fetch 2x to account for filtering
    // Always require phone number — no phone = can't call = worthless
    contact_phone_numbers_exists: true,
  };

  // Job titles: use ICP defaults if not specified
  const titles = params.jobTitles?.length ? params.jobTitles : ICP_JOB_TITLES;
  baseBody.person_titles = titles;

  // Seniority: always lock to owner/c_suite/vp — no junior staff
  baseBody.person_seniorities = ["owner", "c_suite", "vp"];

  // Industries: use ICP defaults if not specified
  if (params.industries?.length) {
    baseBody.organization_industry_tag_ids = params.industries;
  } else {
    baseBody.organization_industry_tag_ids = ICP_INDUSTRIES;
  }

  // Location
  if (params.locations?.length) {
    baseBody.person_locations = params.locations;
  }

  // Company size: default to 1-50 employees (home services sweet spot)
  const sizeRange = params.companySize || "1,50";
  baseBody.organization_num_employees_ranges = [sizeRange];

  // Keywords
  if (params.keywords?.length) {
    baseBody.q_keywords = params.keywords.join(" ");
  }

  // Paginate until we have enough qualified leads
  while (allLeads.length < requestedLimit && page <= totalPages) {
    const body = { ...baseBody, page };
    const response = await fetch("https://api.apollo.io/v1/mixed_people/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Apollo API error ${response.status}: ${err}`);
    }
    const data = await response.json() as {
      people?: ApolloPersonResult[];
      pagination?: { total_pages?: number; total_entries?: number };
    };
    const people = data.people || [];
    if (people.length === 0) break;

    if (page === 1 && data.pagination?.total_pages) {
      totalPages = data.pagination.total_pages;
    }

    const mapped = people.map((p): Lead => ({
      name: `${p.first_name || ""} ${p.last_name || ""}`.trim(),
      phone: p.phone_numbers?.[0]?.sanitized_number,
      email: p.email,
      company: p.organization?.name,
      title: p.title,
      industry: p.organization?.industry,
      location: p.city ? `${p.city}, ${p.state}` : p.country,
      linkedinUrl: p.linkedin_url,
      website: p.organization?.website_url,
      score: scoreLeadApollo(p),
      source: "apollo",
      rawData: p as unknown as Record<string, unknown>,
    }));

    // Apply score gate immediately — don't accumulate slop
    const qualified = mapped.filter(l => (l.score ?? 0) >= minScore);
    allLeads.push(...qualified);
    page++;

    if (allLeads.length < requestedLimit && page <= totalPages) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  const results = allLeads.slice(0, requestedLimit);

  // AI qualification pass (unless skipped)
  if (!params.skipAiQualification && results.length > 0) {
    return await aiQualifyLeads(results, minScore);
  }

  return results;
}

interface ApolloPersonResult {
  first_name?: string;
  last_name?: string;
  email?: string;
  title?: string;
  city?: string;
  state?: string;
  country?: string;
  linkedin_url?: string;
  phone_numbers?: { sanitized_number?: string }[];
  organization?: {
    name?: string;
    industry?: string;
    website_url?: string;
    estimated_num_employees?: number;
  };
  seniority?: string;
  departments?: string[];
}

function scoreLeadApollo(p: ApolloPersonResult): number {
  let score = 30; // start lower — earn your way up

  // Phone is mandatory — hard requirement
  if (!p.phone_numbers?.length) return 0; // no phone = instant disqualify
  score += 25; // has phone: biggest signal

  // Email adds follow-up capability
  if (p.email) score += 10;

  // LinkedIn = real person, verifiable
  if (p.linkedin_url) score += 5;

  // Seniority: owner/c_suite is the ICP — anything else is a penalty
  if (p.seniority === "owner") score += 20;
  else if (p.seniority === "c_suite") score += 15;
  else if (p.seniority === "vp") score += 8;
  else if (p.seniority === "director") score += 5;
  else score -= 10; // junior/unknown = wrong person

  // Company size: 1-20 is ideal (owner answers phone), 21-50 is good, 50+ is too big
  if (p.organization?.estimated_num_employees) {
    const emp = p.organization.estimated_num_employees;
    if (emp >= 1 && emp <= 20) score += 15;        // ideal: small owner-operated
    else if (emp >= 21 && emp <= 50) score += 8;   // good: small team
    else if (emp >= 51 && emp <= 100) score += 2;  // marginal
    else score -= 5;                               // too big for SMIRK
  }

  // Industry keyword match: does the company name/industry suggest home services?
  const industryStr = (p.organization?.industry || "").toLowerCase();
  const nameStr = (p.organization?.name || "").toLowerCase();
  const isHomeServices = HOME_SERVICES_KEYWORDS.some(kw =>
    industryStr.includes(kw) || nameStr.includes(kw)
  );
  if (isHomeServices) score += 10;

  return Math.max(0, Math.min(100, score));
}

// ── Google Maps Places Lead Scraping ─────────────────────────────────────────

export async function searchLeadsGoogleMaps(
  query: string,
  location: string,
  radiusMiles: number = 25,
  limit: number = 20,
  minScore: number = SCORE_GATE_SAVE
): Promise<Lead[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY not configured");

  // Step 1: Geocode the location
  const geoResp = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`
  );
  const geoData = await geoResp.json() as { results?: { geometry: { location: { lat: number; lng: number } } }[] };
  const coords = geoData.results?.[0]?.geometry?.location;
  if (!coords) throw new Error(`Could not geocode location: ${location}`);

  // Step 2: Nearby search — fetch 2x limit to account for filtering
  const radiusMeters = Math.min(radiusMiles * 1609, 50000); // Google max 50km
  const placesResp = await fetch(
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${coords.lat},${coords.lng}&radius=${radiusMeters}&keyword=${encodeURIComponent(query)}&key=${apiKey}`
  );
  const placesData = await placesResp.json() as { results?: GooglePlaceResult[] };
  const places = (placesData.results || []).slice(0, limit * 2);

  // Step 3: Get details for each place and score them
  const leads: Lead[] = [];
  for (const place of places) {
    if (leads.length >= limit) break;
    try {
      const detailResp = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,website,formatted_address,user_ratings_total,rating,business_status,opening_hours&key=${apiKey}`
      );
      const detailData = await detailResp.json() as { result?: GooglePlaceDetail };
      const detail = detailData.result;

      // Skip permanently closed businesses
      if (detail?.business_status === "CLOSED_PERMANENTLY") continue;

      // Skip businesses with no phone — they don't take calls
      if (!detail?.formatted_phone_number) continue;

      const score = scoreLeadGoogleMaps(place, detail);

      // Apply score gate before saving
      if (score < minScore) continue;

      leads.push({
        name: place.name,
        phone: detail.formatted_phone_number,
        company: place.name,
        location: detail.formatted_address || place.vicinity,
        website: detail.website,
        score,
        source: "google_maps",
        rawData: { ...place, detail } as unknown as Record<string, unknown>,
      });
    } catch {
      // Skip places that fail detail lookup
    }
  }

  // Sort by score descending — best leads first
  leads.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return leads;
}

function scoreLeadGoogleMaps(place: GooglePlaceResult, detail: GooglePlaceDetail): number {
  let score = 20; // start low — earn your way up

  // Has phone: mandatory for SMIRK (already filtered above, but add points)
  if (detail.formatted_phone_number) score += 20;

  // Has website: indicates a real operating business
  if (detail.website) score += 10;

  // Rating quality: 3.8+ is a real business, below that is a red flag
  if (place.rating) {
    if (place.rating >= 4.5) score += 15;
    else if (place.rating >= 4.0) score += 10;
    else if (place.rating >= 3.8) score += 5;
    else score -= 10; // below 3.8 = bad reputation or fake listing
  }

  // Review count: volume indicates an active, real business
  // A business with 5 reviews could be brand new or barely operating
  const reviewCount = detail.user_ratings_total ?? 0;
  if (reviewCount >= 100) score += 20;       // established business
  else if (reviewCount >= 50) score += 15;   // decent volume
  else if (reviewCount >= 20) score += 10;   // some history
  else if (reviewCount >= 5) score += 5;     // minimal
  else score -= 10;                          // no reviews = unverified or new

  // Business is currently open (has hours set = operating business)
  if (detail.opening_hours?.open_now !== undefined) score += 5;

  // Industry keyword match in business name
  const nameLower = (place.name || "").toLowerCase();
  const isHomeServices = HOME_SERVICES_KEYWORDS.some(kw => nameLower.includes(kw));
  if (isHomeServices) score += 10;

  // Penalty: chains and franchises (too big, won't convert)
  const chainKeywords = ["inc", "llc", "corp", "group", "holdings", "national", "american", "united"];
  const isLikelyChain = chainKeywords.some(kw => nameLower.includes(` ${kw}`) || nameLower.endsWith(kw));
  if (isLikelyChain) score -= 5;

  return Math.max(0, Math.min(100, score));
}

interface GooglePlaceResult {
  place_id: string;
  name: string;
  vicinity?: string;
  rating?: number;
}

interface GooglePlaceDetail {
  formatted_phone_number?: string;
  website?: string;
  formatted_address?: string;
  user_ratings_total?: number;
  rating?: number;
  business_status?: string;
  opening_hours?: { open_now?: boolean };
}

// ── AI Qualification Layer ────────────────────────────────────────────────────
// Post-scrape LLM pass: scores each lead 0-100 on ICP fit
// Runs in batches of 10 to minimize API calls

export async function aiQualifyLeads(leads: Lead[], minScore: number = SCORE_GATE_SAVE): Promise<Lead[]> {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return leads; // skip if no LLM key — don't block

  const qualified: Lead[] = [];

  // Process in batches of 10
  for (let i = 0; i < leads.length; i += 10) {
    const batch = leads.slice(i, i + 10);
    try {
      const leadList = batch.map((l, idx) =>
        `${idx + 1}. Name: ${l.name} | Company: ${l.company || "unknown"} | Title: ${l.title || "unknown"} | Industry: ${l.industry || "unknown"} | Location: ${l.location || "unknown"} | Has phone: ${l.phone ? "yes" : "no"} | Has email: ${l.email ? "yes" : "no"}`
      ).join("\n");

      const prompt = `You are a lead qualification expert for SMIRK, an AI phone agent for home service businesses (HVAC, plumbing, electrical, roofing, landscaping, pest control, cleaning, painting, handyman, pool service, etc.).

SMIRK's ideal customer: owner or GM of a small home services business (1-50 employees) who takes phone calls and would benefit from an AI receptionist that answers 24/7, books appointments, and never misses a call.

Rate each lead's ICP fit from 0-100. Be strict. Penalize:
- National chains or franchises (score 0-20)
- Non-home-services businesses (score 0-30)
- Corporate/enterprise companies (score 0-25)
- No phone number (score 0)
- Unclear if they take phone calls (score 30-50)

Reward:
- Clear home services business name (score +20)
- Owner/founder title (score +20)
- Small local business signals (score +15)
- Has both phone and email (score +10)

Leads to evaluate:
${leadList}

Respond with ONLY a JSON array of objects, one per lead, in order:
[{"index": 1, "score": 85, "reason": "HVAC owner, local business, has phone"}, ...]`;

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-flash-1.5",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 500,
          temperature: 0.1, // low temp for consistent scoring
        }),
      });

      if (!response.ok) {
        // LLM failed — keep leads with their existing scores
        qualified.push(...batch);
        continue;
      }

      const data = await response.json() as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content?.trim() || "";

      // Parse JSON response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        qualified.push(...batch);
        continue;
      }

      const scores = JSON.parse(jsonMatch[0]) as { index: number; score: number; reason: string }[];

      for (const lead of batch) {
        const idx = batch.indexOf(lead);
        const aiScore = scores.find(s => s.index === idx + 1);
        if (!aiScore) {
          if ((lead.score ?? 0) >= minScore) qualified.push(lead);
          continue;
        }

        // Blend: 60% AI score + 40% rule-based score for robustness
        const blendedScore = Math.round((aiScore.score * 0.6) + ((lead.score ?? 50) * 0.4));
        const updatedLead: Lead = {
          ...lead,
          score: blendedScore,
          icpFit: aiScore.reason,
        };

        if (blendedScore >= minScore) {
          qualified.push(updatedLead);
        }
      }
    } catch {
      // Batch failed — keep leads with existing scores
      qualified.push(...batch.filter(l => (l.score ?? 0) >= minScore));
    }

    // Rate limit between batches
    if (i + 10 < leads.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Sort by score descending
  return qualified.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

// ── AI Pitch Personalization ──────────────────────────────────────────────────

export async function generatePersonalizedPitch(
  lead: Lead,
  campaignContext: string,
  agentName: string
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return campaignContext;

  const prompt = `You are ${agentName}, an AI sales agent for SMIRK — an AI phone receptionist for home service businesses.

Generate a natural, conversational opening pitch for a cold call to this lead.

Lead info:
- Name: ${lead.name}
- Company: ${lead.company || "their company"}
- Title: ${lead.title || "business owner"}
- Industry: ${lead.industry || "home services"}
- Location: ${lead.location || "unknown"}
- ICP fit notes: ${lead.icpFit || "home services business"}

Campaign context: ${campaignContext}

Write ONLY the opening 2-3 sentences the agent will say when the person picks up.
Rules:
- Use their first name if available
- Reference their specific business type (HVAC, plumbing, etc.) if known
- Lead with the pain (missing calls = losing jobs), not the product
- Be direct and human, not salesy
- Under 50 words
- No placeholders like [NAME] or [COMPANY]`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-flash-1.5",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.7,
    }),
  });

  if (!response.ok) return campaignContext;
  const data = await response.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() || campaignContext;
}

// ── Database Operations ───────────────────────────────────────────────────────

export async function saveLead(lead: Lead, workspaceId: number = 1): Promise<number> {
  const rows = await sql`
    INSERT INTO leads (name, phone, email, company, title, industry, location, linkedin_url, website, score, source, workspace_id)
    VALUES (
      ${lead.name}, ${lead.phone ?? null}, ${lead.email ?? null},
      ${lead.company ?? null}, ${lead.title ?? null}, ${lead.industry ?? null},
      ${lead.location ?? null}, ${lead.linkedinUrl ?? null}, ${lead.website ?? null},
      ${lead.score ?? 50}, ${lead.source}, ${workspaceId}
    )
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

export async function getLeads(workspaceId: number = 1, limit: number = 100): Promise<Lead[]> {
  const rows = await sql`
    SELECT id, name, phone, email, company, title, industry, location,
           linkedin_url AS "linkedinUrl", website, score, source, status, notes,
           created_at AS "createdAt", last_contacted AS "lastContacted",
           funnel_stage, qualified_at, booked_at, follow_up_due_at,
           call_sid, service_type, appointment_time, appointment_tz,
           hubspot_id, hubspot_synced_at,
           calendar_event_id, calendar_event_url, calendar_synced_at,
           sms_sent_at, integration_status, last_error, updated_at
    FROM leads
    WHERE workspace_id = ${workspaceId}
    ORDER BY score DESC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  `;
  return rows as unknown as Lead[];
}

export async function saveCampaign(campaign: Campaign, workspaceId: number = 1): Promise<number> {
  const rows = await sql`
    INSERT INTO campaigns (name, agent_id, call_reason, pitch_template, status, workspace_id)
    VALUES (
      ${campaign.name}, ${campaign.agentId ?? null}, ${campaign.callReason},
      ${campaign.pitchTemplate}, ${campaign.status}, ${workspaceId}
    )
    RETURNING id
  `;
  return (rows[0] as { id: number }).id;
}

export async function getCampaigns(workspaceId: number = 1): Promise<Campaign[]> {
  const rows = await sql`
    SELECT id, name, agent_id AS "agentId", call_reason AS "callReason",
           pitch_template AS "pitchTemplate", status,
           calls_scheduled AS "callsScheduled", calls_completed AS "callsCompleted",
           conversions AS "conversionsCount", workspace_id AS "workspaceId",
           created_at AS "createdAt"
    FROM campaigns
    WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC
  `;
  return rows as unknown as Campaign[];
}
