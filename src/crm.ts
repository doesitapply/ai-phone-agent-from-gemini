/**
 * Native CRM Integration Layer
 *
 * Provides direct API integrations with HubSpot, Salesforce, Airtable, and Notion.
 * All integrations are HTTP-based (no SDKs) for minimal dependencies.
 *
 * Each integration exposes:
 *   - isConfigured(): boolean
 *   - upsertContact(data): create or update a contact/record
 *   - logCall(data): append a call note/activity
 *   - createDeal/createRecord (where applicable)
 *
 * Called automatically after every call (post-call intelligence) and
 * also available as live tools the AI can invoke during calls.
 */

export interface CrmContact {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  notes?: string;
  tags?: string[];
  funnelStage?: string;
  smirkLeadId?: number;
}

export interface CrmCallLog {
  callSid: string;
  duration: number;
  summary: string;
  outcome: string;
  sentiment: string;
  transcript?: string;
  agentName?: string;
  calledAt: string;
}

export interface CrmResult {
  success: boolean;
  platform: string;
  recordId?: string;
  recordUrl?: string;
  error?: string;
  action?: "created" | "updated" | "skipped";
}

// ── HubSpot ───────────────────────────────────────────────────────────────────

export function isHubSpotConfigured(): boolean {
  return !!process.env.HUBSPOT_ACCESS_TOKEN;
}

export async function hubspotUpsertContact(contact: CrmContact): Promise<CrmResult> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return { success: false, platform: "hubspot", error: "Not configured" };

  try {
    // Search for existing contact by phone
    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: contact.phone }] }],
        properties: ["id", "phone", "email", "firstname", "lastname"],
        limit: 1,
      }),
    });
    const searchData = await searchRes.json();
    const existing = searchData.results?.[0];

    const [firstname, ...rest] = (contact.name || "").split(" ");
    const lastname = rest.join(" ") || undefined;

    // Map SMIRK funnel stage → HubSpot hs_lead_status
    const stageMap: Record<string, string> = {
      captured:      "NEW",
      qualified:     "IN_PROGRESS",
      booked:        "OPEN_DEAL",
      follow_up_due: "OPEN_DEAL",
      closed:        "CONNECTED",
    };

    const properties: Record<string, string> = { phone: contact.phone };
    if (firstname) properties.firstname = firstname;
    if (lastname)  properties.lastname  = lastname;
    if (contact.email)       properties.email       = contact.email;
    if (contact.company)     properties.company     = contact.company;
    if (contact.funnelStage) properties.hs_lead_status = stageMap[contact.funnelStage] ?? "IN_PROGRESS";
    if (contact.notes || contact.smirkLeadId) {
      const noteParts = [
        contact.notes ?? "",
        contact.smirkLeadId ? `SMIRK Lead ID: ${contact.smirkLeadId}` : "",
      ].filter(Boolean);
      properties.description = noteParts.join("\n");
    }

    if (existing) {
      const patchRes = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${existing.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties }),
      });
      if (!patchRes.ok) {
        const errBody = await patchRes.json().catch(() => ({}));
        return { success: false, platform: "hubspot", error: `PATCH ${patchRes.status}: ${errBody.message ?? patchRes.statusText}` };
      }
      return { success: true, platform: "hubspot", recordId: existing.id, action: "updated" };
    } else {
      const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties }),
      });
      if (!createRes.ok) {
        const errBody = await createRes.json().catch(() => ({}));
        return { success: false, platform: "hubspot", error: `POST ${createRes.status}: ${errBody.message ?? createRes.statusText}` };
      }
      const created = await createRes.json();
      return { success: true, platform: "hubspot", recordId: created.id, action: "created" };
    }
  } catch (err: any) {
    return { success: false, platform: "hubspot", error: err.message };
  }
}

export async function hubspotLogCall(contactId: string, log: CrmCallLog): Promise<CrmResult> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return { success: false, platform: "hubspot", error: "Not configured" };

  try {
    const body = {
      properties: {
        hs_call_title: `AI Agent Call — ${log.agentName || "SMIRK"}`,
        hs_call_body: `${log.summary}\n\nOutcome: ${log.outcome}\nSentiment: ${log.sentiment}\nDuration: ${Math.floor(log.duration / 60)}m ${log.duration % 60}s`,
        hs_call_duration: log.duration * 1000, // HubSpot uses ms
        hs_call_status: "COMPLETED",
        hs_timestamp: new Date(log.calledAt).getTime(),
        hs_call_direction: "INBOUND",
      },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 194 }] }],
    };
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { success: res.ok, platform: "hubspot", recordId: data.id, action: "created" };
  } catch (err: any) {
    return { success: false, platform: "hubspot", error: err.message };
  }
}

export async function hubspotCreateDeal(contactId: string, dealName: string, amount?: number, stage?: string): Promise<CrmResult> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return { success: false, platform: "hubspot", error: "Not configured" };

  try {
    const body = {
      properties: {
        dealname: dealName,
        dealstage: stage || "appointmentscheduled",
        amount: amount?.toString(),
        pipeline: "default",
      },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }],
    };
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { success: res.ok, platform: "hubspot", recordId: data.id, recordUrl: `https://app.hubspot.com/contacts/${data.id}`, action: "created" };
  } catch (err: any) {
    return { success: false, platform: "hubspot", error: err.message };
  }
}

// ── Salesforce ────────────────────────────────────────────────────────────────

export function isSalesforceConfigured(): boolean {
  return !!(process.env.SALESFORCE_INSTANCE_URL && process.env.SALESFORCE_ACCESS_TOKEN);
}

// In-memory token cache for Salesforce (refreshed on 401)
let sfTokenCache: { token: string; expiresAt: number } | null = null;

async function sfRefreshToken(): Promise<string> {
  // Prefer client_credentials flow (Connected App) if configured
  const clientId = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL!;

  if (clientId && clientSecret) {
    const res = await fetch(`${instanceUrl}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    const data = await res.json();
    if (data.access_token) {
      sfTokenCache = { token: data.access_token, expiresAt: Date.now() + 3600_000 };
      return data.access_token;
    }
    throw new Error(`Salesforce token refresh failed: ${data.error_description || data.error}`);
  }

  // Fall back to username-password flow if refresh token is provided
  const refreshToken = process.env.SALESFORCE_REFRESH_TOKEN;
  if (refreshToken) {
    const res = await fetch(`${instanceUrl}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId || "",
        client_secret: clientSecret || "",
        refresh_token: refreshToken,
      }).toString(),
    });
    const data = await res.json();
    if (data.access_token) {
      sfTokenCache = { token: data.access_token, expiresAt: Date.now() + 3600_000 };
      return data.access_token;
    }
    throw new Error(`Salesforce token refresh failed: ${data.error_description || data.error}`);
  }

  // Last resort: use the static token from env
  return process.env.SALESFORCE_ACCESS_TOKEN!;
}

async function sfGetToken(): Promise<string> {
  // Use cached token if still valid (5 min buffer)
  if (sfTokenCache && sfTokenCache.expiresAt - Date.now() > 300_000) {
    return sfTokenCache.token;
  }
  return sfRefreshToken();
}

async function sfRequest(path: string, method: string, body?: any, retried = false): Promise<any> {
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL!;
  const token = await sfGetToken();
  const res = await fetch(`${instanceUrl}/services/data/v59.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Auto-refresh on 401 (expired token) — retry once
  if (res.status === 401 && !retried) {
    sfTokenCache = null; // invalidate cache
    return sfRequest(path, method, body, true);
  }
  if (res.status === 204) return {};
  const data = await res.json();
  if (Array.isArray(data) && data[0]?.errorCode) {
    throw new Error(`Salesforce API error: ${data[0].message} (${data[0].errorCode})`);
  }
  return data;
}

export async function salesforceUpsertContact(contact: CrmContact): Promise<CrmResult> {
  if (!isSalesforceConfigured()) return { success: false, platform: "salesforce", error: "Not configured" };

  try {
    // Search by phone
    const query = `SELECT Id, Phone FROM Contact WHERE Phone = '${contact.phone.replace(/'/g, "\\'")}' LIMIT 1`;
    const searchData = await sfRequest(`/query?q=${encodeURIComponent(query)}`, "GET");
    const existing = searchData.records?.[0];

    const [firstname, ...rest] = (contact.name || "").split(" ");
    const payload: Record<string, string> = { Phone: contact.phone };
    if (firstname) payload.FirstName = firstname;
    if (rest.length) payload.LastName = rest.join(" ");
    if (contact.email) payload.Email = contact.email;
    if (contact.company) payload.AccountId = contact.company; // simplified
    if (contact.notes) payload.Description = contact.notes;

    if (existing) {
      await sfRequest(`/sobjects/Contact/${existing.Id}`, "PATCH", payload);
      return { success: true, platform: "salesforce", recordId: existing.Id, action: "updated" };
    } else {
      if (!payload.LastName) payload.LastName = "Unknown";
      const created = await sfRequest("/sobjects/Contact", "POST", payload);
      return { success: true, platform: "salesforce", recordId: created.id, action: "created" };
    }
  } catch (err: any) {
    return { success: false, platform: "salesforce", error: err.message };
  }
}

export async function salesforceLogCall(contactId: string, log: CrmCallLog): Promise<CrmResult> {
  if (!isSalesforceConfigured()) return { success: false, platform: "salesforce", error: "Not configured" };

  try {
    const payload = {
      Subject: `AI Agent Call — ${log.agentName || "SMIRK"}`,
      Description: `${log.summary}\n\nOutcome: ${log.outcome}\nSentiment: ${log.sentiment}`,
      ActivityDate: log.calledAt.slice(0, 10),
      DurationInMinutes: Math.ceil(log.duration / 60),
      CallType: "Inbound",
      Status: "Completed",
      WhoId: contactId,
    };
    const created = await sfRequest("/sobjects/Task", "POST", payload);
    return { success: true, platform: "salesforce", recordId: created.id, action: "created" };
  } catch (err: any) {
    return { success: false, platform: "salesforce", error: err.message };
  }
}

// ── Airtable ──────────────────────────────────────────────────────────────────

export function isAirtableConfigured(): boolean {
  return !!(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID);
}

export async function airtableUpsertContact(contact: CrmContact): Promise<CrmResult> {
  const token = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_CONTACTS_TABLE || "Contacts";
  if (!token || !baseId) return { success: false, platform: "airtable", error: "Not configured" };

  try {
    // Search for existing record
    const searchRes = await fetch(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}?filterByFormula=${encodeURIComponent(`{Phone}='${contact.phone}'`)}&maxRecords=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();
    const existing = searchData.records?.[0];

    const fields: Record<string, any> = { Phone: contact.phone };
    if (contact.name) fields.Name = contact.name;
    if (contact.email) fields.Email = contact.email;
    if (contact.company) fields.Company = contact.company;
    if (contact.notes) fields.Notes = contact.notes;
    if (contact.tags?.length) fields.Tags = contact.tags;

    if (existing) {
      const res = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}/${existing.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const data = await res.json();
      return { success: res.ok, platform: "airtable", recordId: data.id, action: "updated" };
    } else {
      const res = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const data = await res.json();
      return { success: res.ok, platform: "airtable", recordId: data.id, action: "created" };
    }
  } catch (err: any) {
    return { success: false, platform: "airtable", error: err.message };
  }
}

export async function airtableLogCall(contact: CrmContact, log: CrmCallLog): Promise<CrmResult> {
  const token = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_CALLS_TABLE || "Calls";
  if (!token || !baseId) return { success: false, platform: "airtable", error: "Not configured" };

  try {
    const fields: Record<string, any> = {
      "Call SID": log.callSid,
      "Phone": contact.phone,
      "Name": contact.name || "Unknown",
      "Summary": log.summary,
      "Outcome": log.outcome,
      "Sentiment": log.sentiment,
      "Duration (s)": log.duration,
      "Agent": log.agentName || "SMIRK",
      "Called At": log.calledAt,
    };
    const res = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    const data = await res.json();
    return { success: res.ok, platform: "airtable", recordId: data.id, action: "created" };
  } catch (err: any) {
    return { success: false, platform: "airtable", error: err.message };
  }
}

// ── Notion ────────────────────────────────────────────────────────────────────

export function isNotionConfigured(): boolean {
  return !!(process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID);
}

export async function notionUpsertContact(contact: CrmContact): Promise<CrmResult> {
  const token = process.env.NOTION_API_KEY;
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!token || !dbId) return { success: false, platform: "notion", error: "Not configured" };

  try {
    // Query for existing page by phone
    const searchRes = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
      body: JSON.stringify({ filter: { property: "Phone", rich_text: { equals: contact.phone } }, page_size: 1 }),
    });
    const searchData = await searchRes.json();
    const existing = searchData.results?.[0];

    const properties: Record<string, any> = {
      Phone: { rich_text: [{ text: { content: contact.phone } }] },
    };
    if (contact.name) properties.Name = { title: [{ text: { content: contact.name } }] };
    if (contact.email) properties.Email = { email: contact.email };
    if (contact.company) properties.Company = { rich_text: [{ text: { content: contact.company } }] };

    if (existing) {
      await fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({ properties }),
      });
      return { success: true, platform: "notion", recordId: existing.id, recordUrl: existing.url, action: "updated" };
    } else {
      const res = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({ parent: { database_id: dbId }, properties }),
      });
      const data = await res.json();
      return { success: res.ok, platform: "notion", recordId: data.id, recordUrl: data.url, action: "created" };
    }
  } catch (err: any) {
    return { success: false, platform: "notion", error: err.message };
  }
}

// ── Sync all configured CRMs ──────────────────────────────────────────────────

export async function syncAllCrms(contact: CrmContact, log: CrmCallLog): Promise<CrmResult[]> {
  const results: CrmResult[] = [];

  if (isHubSpotConfigured()) {
    const contactResult = await hubspotUpsertContact(contact);
    results.push(contactResult);
    if (contactResult.success && contactResult.recordId) {
      const callResult = await hubspotLogCall(contactResult.recordId, log);
      results.push(callResult);
    }
  }

  if (isSalesforceConfigured()) {
    const contactResult = await salesforceUpsertContact(contact);
    results.push(contactResult);
    if (contactResult.success && contactResult.recordId) {
      const callResult = await salesforceLogCall(contactResult.recordId, log);
      results.push(callResult);
    }
  }

  if (isAirtableConfigured()) {
    const contactResult = await airtableUpsertContact(contact);
    results.push(contactResult);
    const callResult = await airtableLogCall(contact, log);
    results.push(callResult);
  }

  if (isNotionConfigured()) {
    const contactResult = await notionUpsertContact(contact);
    results.push(contactResult);
  }

  return results;
}

export function getConfiguredCrms(): string[] {
  const crms: string[] = [];
  if (isHubSpotConfigured()) crms.push("hubspot");
  if (isSalesforceConfigured()) crms.push("salesforce");
  if (isAirtableConfigured()) crms.push("airtable");
  if (isNotionConfigured()) crms.push("notion");
  return crms;
}
