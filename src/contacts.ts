/**
 * Caller Identity Module
 *
 * Resolves phone numbers to persistent contact records.
 * Loads prior call context so returning callers are recognized.
 */
import { db } from "./db.js";

export type Contact = {
  id: number;
  phone_number: string;
  name: string | null;
  email: string | null;
  notes: string | null;
  tags: string | null;
  first_seen: string;
  last_seen: string;
  last_summary: string | null;
  last_outcome: string | null;
  open_tasks_count: number;
  do_not_call: number;
  created_at: string;
};

/**
 * Normalize a phone number to E.164 format for consistent storage and lookup.
 * Strips all non-digit characters, then prepends + if missing.
 */
export const normalizePhone = (raw: string): string => {
  const digits = raw.replace(/\D/g, "");
  // US numbers without country code
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
};

/**
 * Look up a contact by phone number. Creates a new record if none exists.
 * Returns the contact and whether it was newly created.
 */
export const resolveContact = (
  rawPhone: string
): { contact: Contact; isNew: boolean } => {
  const phone = normalizePhone(rawPhone);

  const existing = db
    .prepare("SELECT * FROM contacts WHERE phone_number = ?")
    .get(phone) as Contact | undefined;

  if (existing) {
    // Update last_seen timestamp
    db.prepare("UPDATE contacts SET last_seen = datetime('now') WHERE id = ?").run(
      existing.id
    );
    return { contact: existing, isNew: false };
  }

  // Create new contact
  const result = db
    .prepare(
      `INSERT INTO contacts (phone_number, first_seen, last_seen)
       VALUES (?, datetime('now'), datetime('now'))`
    )
    .run(phone);

  const newContact = db
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(result.lastInsertRowid) as Contact;

  return { contact: newContact, isNew: true };
};

/**
 * Build the prior-context block to inject into the AI system prompt.
 * Returns an empty string for first-time callers.
 */
export const buildCallerContext = (contact: Contact, isNew: boolean): string => {
  if (isNew || (!contact.last_summary && !contact.name)) {
    return ""; // No prior context for new callers
  }

  const lines: string[] = [];
  lines.push("=== RETURNING CALLER CONTEXT ===");

  if (contact.name) {
    lines.push(`Caller name: ${contact.name}`);
  }
  if (contact.last_summary) {
    lines.push(`Last call summary: ${contact.last_summary}`);
  }
  if (contact.last_outcome) {
    lines.push(`Last call outcome: ${contact.last_outcome}`);
  }
  if (contact.open_tasks_count > 0) {
    lines.push(
      `Open tasks: ${contact.open_tasks_count} unresolved item(s) from previous calls`
    );
  }
  if (contact.notes) {
    lines.push(`Notes: ${contact.notes}`);
  }

  lines.push(
    "Use this context to greet the caller by name if known, and reference their prior situation naturally. Do not read this context aloud verbatim."
  );
  lines.push("=== END CONTEXT ===");

  return lines.join("\n");
};

/**
 * Update a contact's name if extracted during a call.
 */
export const updateContactName = (contactId: number, name: string): void => {
  db.prepare(
    "UPDATE contacts SET name = ? WHERE id = ? AND (name IS NULL OR name = '')"
  ).run(name, contactId);
};

/**
 * Update the contact's last summary and outcome after a call ends.
 */
export const updateContactSummary = (
  contactId: number,
  summary: string,
  outcome: string
): void => {
  db.prepare(
    `UPDATE contacts SET last_summary = ?, last_outcome = ?, last_seen = datetime('now')
     WHERE id = ?`
  ).run(summary, outcome, contactId);
};

/**
 * Increment or decrement the open tasks count for a contact.
 */
export const adjustOpenTasks = (contactId: number, delta: number): void => {
  db.prepare(
    `UPDATE contacts
     SET open_tasks_count = MAX(0, open_tasks_count + ?)
     WHERE id = ?`
  ).run(delta, contactId);
};

/**
 * Mark a contact as do-not-call.
 */
export const markDoNotCall = (contactId: number): void => {
  db.prepare("UPDATE contacts SET do_not_call = 1 WHERE id = ?").run(contactId);
};

/**
 * Get full contact record by ID.
 */
export const getContact = (contactId: number): Contact | undefined => {
  return db
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(contactId) as Contact | undefined;
};

/**
 * Get all contacts with pagination.
 */
export const listContacts = (
  limit = 50,
  offset = 0
): { contacts: Contact[]; total: number } => {
  const contacts = db
    .prepare(
      "SELECT * FROM contacts ORDER BY last_seen DESC LIMIT ? OFFSET ?"
    )
    .all(limit, offset) as Contact[];
  const total = (
    db.prepare("SELECT COUNT(*) as count FROM contacts").get() as {
      count: number;
    }
  ).count;
  return { contacts, total };
};
