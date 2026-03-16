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

    const properties: Record<string, string> = { phone: contact.phone };
    if (firstname) properties.firstname = firstname;
    if (lastname) properties.lastname = lastname;
    if (contact.email) properties.email = contact.email;
    if (contact.company) properties.company = contact.company;
    if (contact.notes) properties.hs_lead_status = "IN_PROGRESS";

    if (existing) {
      // Update
      await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${existing.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties }),
      });
      return { success: true, platform: "hubspot", recordId: existing.id, action: "updated" };
    } else {
      // Create
      const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties }),
      });
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

async function sfRequest(path: string, method: string, body?: any): Promise<any> {
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL!;
  const token = process.env.SALESFORCE_ACCESS_TOKEN!;
  const res = await fetch(`${instanceUrl}/services/data/v59.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  return res.json();
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
