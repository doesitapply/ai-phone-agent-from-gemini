/**
 * Caller Identity Module
 *
 * Resolves phone numbers to persistent contact records.
 * Loads prior call context so returning callers are recognized.
 * Builds rich outbound context so the agent knows exactly why it called,
 * what happened on prior calls, and what the mission is.
 * All functions are async — uses postgres.js directly.
 */
import { sql } from "./db.js";

export type Contact = {
  id: number;
  phone_number: string;
  name: string | null;
  email: string | null;
  business_name: string | null;
  business_type: string | null;
  website: string | null;
  notes: string | null;
  tags: string[] | null;
  first_seen: string;
  last_seen: string;
  last_summary: string | null;
  last_outcome: string | null;
  open_tasks_count: number;
  do_not_call: boolean;
  created_at: string;
};

export type PriorCall = {
  call_sid: string;
  direction: string;
  status: string;
  duration: number | null;
  summary: string | null;
  outcome: string | null;
  started_at: string | null;
  agent_name: string | null;
};

/**
 * Normalize a phone number to E.164 format for consistent storage and lookup.
 */
export const normalizePhone = (raw: string): string => {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
};

/**
 * Look up a contact by phone number. Creates a new record if none exists.
 */
export const resolveContact = async (
  rawPhone: string
): Promise<{ contact: Contact; isNew: boolean }> => {
  const phone = normalizePhone(rawPhone);

  const existing = await sql<Contact[]>`
    SELECT * FROM contacts WHERE phone_number = ${phone}
  `;

  if (existing.length > 0) {
    await sql`UPDATE contacts SET last_seen = NOW() WHERE id = ${existing[0].id}`;
    return { contact: existing[0], isNew: false };
  }

  const created = await sql<Contact[]>`
    INSERT INTO contacts (phone_number, first_seen, last_seen)
    VALUES (${phone}, NOW(), NOW())
    RETURNING *
  `;

  return { contact: created[0], isNew: true };
};

/**
 * Fetch the N most recent prior calls for a contact (excluding the current one).
 */
export const getPriorCalls = async (
  contactId: number,
  excludeCallSid?: string,
  limit = 5
): Promise<PriorCall[]> => {
  if (excludeCallSid) {
    return await sql<PriorCall[]>`
      SELECT call_sid, direction, status, duration, summary, outcome, started_at, agent_name
      FROM calls
      WHERE contact_id = ${contactId}
        AND call_sid != ${excludeCallSid}
        AND status IN ('completed', 'failed', 'no-answer', 'busy', 'canceled')
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
  }
  return await sql<PriorCall[]>`
    SELECT call_sid, direction, status, duration, summary, outcome, started_at, agent_name
    FROM calls
    WHERE contact_id = ${contactId}
      AND status IN ('completed', 'failed', 'no-answer', 'busy', 'canceled')
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
};

/**
 * Build the prior-context block for INBOUND calls.
 * Includes contact info, last call summary, and open tasks.
 */
export const buildCallerContext = (contact: Contact, isNew: boolean): string => {
  if (isNew || (!contact.last_summary && !contact.name)) {
    return "";
  }

  const lines: string[] = [];
  lines.push("=== RETURNING CALLER CONTEXT ===");

  if (contact.name) lines.push(`Caller name: ${contact.name}`);
  if (contact.business_name) lines.push(`Business: ${contact.business_name}`);
  if (contact.business_type) lines.push(`Business type: ${contact.business_type}`);
  if (contact.last_summary) lines.push(`Last call summary: ${contact.last_summary}`);
  if (contact.last_outcome) lines.push(`Last call outcome: ${contact.last_outcome}`);
  if (contact.open_tasks_count > 0) {
    lines.push(`Open tasks: ${contact.open_tasks_count} unresolved item(s) from previous calls`);
  }
  if (contact.notes) lines.push(`Notes: ${contact.notes}`);

  lines.push(
    "Use this context to greet the caller by name if known, and reference their prior situation naturally. Do not read this context aloud verbatim."
  );
  lines.push("=== END CONTEXT ===");

  return lines.join("\n");
};

/**
 * Build the full outbound call context block.
 * This is injected into the system prompt when SMIRK is making an outbound call.
 * It tells the agent exactly why it's calling, what happened before, and what the mission is.
 */
export const buildOutboundContext = async (
  contact: Contact,
  callSid: string,
  callReason?: string,
  callNotes?: string
): Promise<string> => {
  const lines: string[] = [];

  lines.push("=== OUTBOUND CALL MISSION ===");
  lines.push("IMPORTANT: YOU are calling THEM. You initiated this call. Do not wait for them to explain themselves.");
  lines.push("Open with a confident, direct introduction and immediately state why you are calling.");
  lines.push("");

  // Who we're calling
  if (contact.name) lines.push(`Contact name: ${contact.name}`);
  if (contact.business_name) lines.push(`Business: ${contact.business_name}`);
  if (contact.business_type) lines.push(`Business type: ${contact.business_type}`);
  if (contact.email) lines.push(`Email: ${contact.email}`);
  if (contact.notes) lines.push(`Contact notes: ${contact.notes}`);

  // Why we're calling
  if (callReason) {
    lines.push("");
    lines.push(`REASON FOR THIS CALL: ${callReason}`);
  }
  if (callNotes) {
    lines.push(`OPERATOR NOTES: ${callNotes}`);
  }

  // Prior call history
  const priorCalls = await getPriorCalls(contact.id, callSid, 5);
  const callCount = priorCalls.length;

  if (callCount === 0) {
    lines.push("");
    lines.push("CALL HISTORY: This is the FIRST time we have called this contact.");
    lines.push("Introduce yourself and the service. Do not assume they know who we are.");
  } else {
    lines.push("");
    lines.push(`CALL HISTORY: This is follow-up call #${callCount + 1} to this contact.`);

    priorCalls.forEach((call, i) => {
      const when = call.started_at
        ? new Date(call.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "Unknown date";
      const dir = call.direction === "outbound" ? "We called them" : "They called us";
      const dur = call.duration ? `${Math.round(call.duration / 60)}m ${call.duration % 60}s` : "no answer";
      lines.push(`  Call ${i + 1} (${when}): ${dir}, ${call.status}, duration: ${dur}`);
      if (call.summary) lines.push(`    Summary: ${call.summary}`);
      if (call.outcome) lines.push(`    Outcome: ${call.outcome}`);
    });

    // Specific guidance based on last outcome
    const lastCall = priorCalls[0];
    if (lastCall) {
      lines.push("");
      if (lastCall.status === "no-answer" || lastCall.status === "busy") {
        lines.push("CONTEXT: They did not answer last time. Keep this call brief and get to the point fast.");
      } else if (lastCall.outcome === "callback_needed") {
        lines.push("CONTEXT: They asked for a callback. Reference that you are following up as requested.");
      } else if (lastCall.outcome === "appointment_booked") {
        lines.push("CONTEXT: An appointment was previously booked. Confirm it is still on and ask if they have any questions.");
      } else if (lastCall.outcome === "not_interested") {
        lines.push("CONTEXT: They were not interested last time. Be respectful. Ask if anything has changed.");
      } else if (lastCall.outcome === "incomplete" || lastCall.outcome === "escalated") {
        lines.push("CONTEXT: The last call was unresolved. Pick up where you left off.");
      }
    }
  }

  lines.push("");
  lines.push("OUTBOUND GREETING TEMPLATE:");
  if (contact.name) {
    lines.push(`Start with: "Hey ${contact.name.split(" ")[0]}, this is SMIRK calling from [company]. ${callReason ? `I'm calling about ${callReason}.` : "Do you have a quick minute?"}`);
  } else {
    lines.push(`Start with: "Hey, this is SMIRK calling from [company]. ${callReason ? `I'm reaching out about ${callReason}.` : "Is now a good time to talk?"}`);
  }
  lines.push("Do NOT say 'How can I help you?' — YOU called THEM. State your purpose immediately.");
  lines.push("=== END OUTBOUND CONTEXT ===");

  return lines.join("\n");
};

export const updateContactName = async (contactId: number, name: string): Promise<void> => {
  await sql`
    UPDATE contacts SET name = ${name}
    WHERE id = ${contactId} AND (name IS NULL OR name = '')
  `;
};

export const updateContactSummary = async (
  contactId: number,
  summary: string,
  outcome: string
): Promise<void> => {
  await sql`
    UPDATE contacts
    SET last_summary = ${summary}, last_outcome = ${outcome}, last_seen = NOW()
    WHERE id = ${contactId}
  `;
};

export const adjustOpenTasks = async (contactId: number, delta: number): Promise<void> => {
  await sql`
    UPDATE contacts
    SET open_tasks_count = GREATEST(0, open_tasks_count + ${delta})
    WHERE id = ${contactId}
  `;
};

export const markDoNotCall = async (contactId: number): Promise<void> => {
  await sql`UPDATE contacts SET do_not_call = TRUE WHERE id = ${contactId}`;
};

export const getContact = async (contactId: number): Promise<Contact | undefined> => {
  const rows = await sql<Contact[]>`SELECT * FROM contacts WHERE id = ${contactId}`;
  return rows[0];
};

export const listContacts = async (
  limit = 50,
  offset = 0
): Promise<{ contacts: Contact[]; total: number }> => {
  const contacts = await sql<Contact[]>`
    SELECT * FROM contacts ORDER BY last_seen DESC LIMIT ${limit} OFFSET ${offset}
  `;
  const countResult = await sql<{ count: string }[]>`SELECT COUNT(*) as count FROM contacts`;
  return { contacts, total: Number(countResult[0].count) };
};
