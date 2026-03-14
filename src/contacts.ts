/**
 * Caller Identity Module
 *
 * Resolves phone numbers to persistent contact records.
 * Loads prior call context so returning callers are recognized.
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
 * Build the prior-context block to inject into the AI system prompt.
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
