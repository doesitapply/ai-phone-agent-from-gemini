/**
 * Lead Hunter — Autonomous Cold Outreach Engine
 *
 * Capabilities:
 *   1. Apollo.io people/company search → enriched lead list
 *   2. Google Maps Places API → local business lead scraping
 *   3. AI-driven pitch personalization per lead
 *   4. Campaign sequencing: call → voicemail → SMS → email
 *   5. Lead scoring and qualification tracking
 */

import { sql } from "./db.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LeadSearchParams {
  jobTitles?: string[];        // e.g. ["CEO", "Owner", "VP Sales"]
  industries?: string[];       // e.g. ["Real Estate", "Insurance"]
  locations?: string[];        // e.g. ["Austin, TX", "Dallas, TX"]
  companySize?: string;        // e.g. "1-10", "11-50", "51-200"
  keywords?: string[];         // free-text keywords
  limit?: number;              // max leads to return (default 25)
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

// ── Apollo.io Lead Search ─────────────────────────────────────────────────────
// Hard cap: never fetch more than 500 leads per search to protect Apollo credits
const APOLLO_MAX_LEADS = 500;
const APOLLO_PAGE_SIZE = 25;

export async function searchLeadsApollo(params: LeadSearchParams): Promise<Lead[]> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY not configured");

  const requestedLimit = Math.min(params.limit || 25, APOLLO_MAX_LEADS);
  const allLeads: Lead[] = [];
  let page = 1;
  let totalPages = 1;

  const baseBody: Record<string, unknown> = {
    api_key: apiKey,
    per_page: Math.min(APOLLO_PAGE_SIZE, requestedLimit),
  };
  if (params.jobTitles?.length)   baseBody.person_titles = params.jobTitles;
  if (params.industries?.length)  baseBody.organization_industry_tag_ids = params.industries;
  if (params.locations?.length)   baseBody.person_locations = params.locations;
  if (params.keywords?.length)    baseBody.q_keywords = params.keywords.join(" ");
  if (params.companySize)         baseBody.organization_num_employees_ranges = [params.companySize];

  // Paginate until we have enough leads or run out of pages
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
    // Read total pages from first response
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
    allLeads.push(...mapped);
    page++;
    // Rate limit: 1 req/sec for Apollo free/basic tier
    if (allLeads.length < requestedLimit && page <= totalPages) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return allLeads.slice(0, requestedLimit);
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
  let score = 50;
  if (p.phone_numbers?.length) score += 20;
  if (p.email) score += 10;
  if (p.linkedin_url) score += 5;
  if (p.seniority === "c_suite" || p.seniority === "owner") score += 15;
  else if (p.seniority === "vp" || p.seniority === "director") score += 10;
  if (p.organization?.estimated_num_employees) {
    const emp = p.organization.estimated_num_employees;
    if (emp >= 10 && emp <= 200) score += 10; // sweet spot
  }
  return Math.min(100, score);
}

// ── Google Maps Places Lead Scraping ─────────────────────────────────────────

export async function searchLeadsGoogleMaps(
  query: string,
  location: string,
  radiusMiles: number = 25,
  limit: number = 20
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

  // Step 2: Nearby search
  const radiusMeters = radiusMiles * 1609;
  const placesResp = await fetch(
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${coords.lat},${coords.lng}&radius=${radiusMeters}&keyword=${encodeURIComponent(query)}&key=${apiKey}`
  );
  const placesData = await placesResp.json() as { results?: GooglePlaceResult[] };
  const places = (placesData.results || []).slice(0, limit);

  // Step 3: Get details for each place (phone, website)
  const leads: Lead[] = [];
  for (const place of places) {
    try {
      const detailResp = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,website,formatted_address&key=${apiKey}`
      );
      const detailData = await detailResp.json() as { result?: GooglePlaceDetail };
      const detail = detailData.result;

      leads.push({
        name: place.name,
        phone: detail?.formatted_phone_number,
        company: place.name,
        location: detail?.formatted_address || place.vicinity,
        website: detail?.website,
        score: place.rating ? Math.round(place.rating * 15) : 50,
        source: "google_maps",
        rawData: { ...place, detail } as unknown as Record<string, unknown>,
      });
    } catch {
      // Skip places that fail detail lookup
    }
  }
  return leads;
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
}

// ── AI Pitch Personalization ──────────────────────────────────────────────────

export async function generatePersonalizedPitch(
  lead: Lead,
  campaignContext: string,
  agentName: string
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return campaignContext; // fallback to raw template

  const prompt = `You are ${agentName}, an AI sales agent. Generate a natural, conversational opening pitch for a cold call.

Lead info:
- Name: ${lead.name}
- Company: ${lead.company || "their company"}
- Title: ${lead.title || "unknown"}
- Industry: ${lead.industry || "unknown"}
- Location: ${lead.location || "unknown"}

Campaign context: ${campaignContext}

Write ONLY the opening 2-3 sentences the agent will say when the person picks up. Be natural, not salesy. Under 50 words. No placeholders.`;

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

// ── Database Operations (PostgreSQL via postgres.js) ─────────────────────────

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
    ORDER BY updated_at DESC NULLS LAST, created_at DESC
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
