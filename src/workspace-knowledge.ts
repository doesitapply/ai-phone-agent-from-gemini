import { sql } from "./db.js";

export type WorkspaceKnowledgeSource = {
  id: number;
  workspace_id: number;
  title: string;
  source_type: string;
  summary: string;
  raw_excerpt: string | null;
  record_count: number;
  imported_contacts: number;
  created_at: string;
  updated_at: string;
};

type ImportPayload = {
  title?: string;
  sourceType?: string;
  content?: string;
};

type ParsedRecord = Record<string, string>;

export type KnowledgeImportResult = {
  source: WorkspaceKnowledgeSource;
  parsedRecords: number;
  importedContacts: number;
  importedFields: number;
};

const MAX_IMPORT_CHARS = 200_000;
const MAX_EXCERPT_CHARS = 12_000;
const MAX_AGENT_CONTEXT_CHARS = 4_000;

const PHONE_KEYS = new Set(["phone", "phone_number", "mobile", "cell", "cell_phone", "telephone", "number"]);
const NAME_KEYS = new Set(["name", "full_name", "customer", "customer_name", "contact", "contact_name"]);
const EMAIL_KEYS = new Set(["email", "email_address", "mail"]);
const COMPANY_KEYS = new Set(["company", "company_name", "business", "business_name", "organization"]);
const NOTES_KEYS = new Set(["notes", "note", "details", "description", "summary"]);

export const normalizeKnowledgeSourceType = (value: unknown): string => {
  const cleaned = String(value || "text").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (["csv", "json", "text", "manual"].includes(cleaned)) return cleaned;
  return "text";
};

const normalizeFieldKey = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);

const normalizePhone = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (trimmed.startsWith("+") && digits.length >= 8) return `+${digits}`;
  return null;
};

const findValue = (record: ParsedRecord, keys: Set<string>): string | null => {
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(normalizeFieldKey(key)) && value.trim()) return value.trim();
  }
  return null;
};

const parseCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
};

const parseCsv = (content: string): ParsedRecord[] => {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((header, index) => normalizeFieldKey(header) || `field_${index + 1}`);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const record: ParsedRecord = {};
    headers.forEach((header, index) => {
      const value = values[index]?.trim();
      if (value) record[header] = value;
    });
    return record;
  }).filter((record) => Object.keys(record).length > 0);
};

const flattenRecord = (value: unknown): ParsedRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record: ParsedRecord = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      const normalizedKey = normalizeFieldKey(key);
      if (normalizedKey) record[normalizedKey] = String(raw).trim();
    }
  }
  return record;
};

const parseJson = (content: string): ParsedRecord[] => {
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed)) return parsed.map(flattenRecord).filter((record) => Object.keys(record).length > 0);
  if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    const arrayValue = Object.values(object).find(Array.isArray);
    if (Array.isArray(arrayValue)) return arrayValue.map(flattenRecord).filter((record) => Object.keys(record).length > 0);
    const record = flattenRecord(object);
    return Object.keys(record).length > 0 ? [record] : [];
  }
  return [];
};

export const parseKnowledgeRecords = (content: string, sourceType: string): ParsedRecord[] => {
  if (sourceType === "csv") return parseCsv(content);
  if (sourceType === "json") return parseJson(content);
  return [];
};

const buildSummary = (title: string, sourceType: string, content: string, records: ParsedRecord[], importedContacts: number): string => {
  if (records.length > 0) {
    const fields = Array.from(new Set(records.flatMap((record) => Object.keys(record)))).slice(0, 14);
    return `${title}: imported ${records.length} ${sourceType.toUpperCase()} rows, ${importedContacts} contact records, fields: ${fields.join(", ")}.`;
  }
  const text = content.replace(/\s+/g, " ").trim();
  return `${title}: saved ${sourceType === "manual" ? "manual notes" : sourceType.toUpperCase()} knowledge for agent grounding. ${text.slice(0, 220)}`;
};

export async function listWorkspaceKnowledgeSources(workspaceId: number): Promise<WorkspaceKnowledgeSource[]> {
  return sql<WorkspaceKnowledgeSource[]>`
    SELECT id, workspace_id, title, source_type, summary, raw_excerpt, record_count,
           imported_contacts, created_at, updated_at
    FROM workspace_knowledge_sources
    WHERE workspace_id = ${workspaceId}
    ORDER BY updated_at DESC, id DESC
    LIMIT 20
  `;
}

export async function deleteWorkspaceKnowledgeSource(workspaceId: number, id: number): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    DELETE FROM workspace_knowledge_sources
    WHERE workspace_id = ${workspaceId} AND id = ${id}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function importWorkspaceKnowledge(workspaceId: number, payload: ImportPayload): Promise<KnowledgeImportResult> {
  const content = String(payload.content || "").trim();
  if (!content) throw new Error("Import content is required.");
  if (content.length > MAX_IMPORT_CHARS) throw new Error("Import is too large. Keep uploads under 200,000 characters.");

  const sourceType = normalizeKnowledgeSourceType(payload.sourceType);
  const title = String(payload.title || `${sourceType.toUpperCase()} import`).trim().slice(0, 120) || "Knowledge import";
  const records = parseKnowledgeRecords(content, sourceType);
  let importedContacts = 0;
  let importedFields = 0;

  for (const record of records.slice(0, 1_000)) {
    const phone = normalizePhone(findValue(record, PHONE_KEYS) || "");
    if (!phone) continue;
    const name = findValue(record, NAME_KEYS);
    const email = findValue(record, EMAIL_KEYS);
    const company = findValue(record, COMPANY_KEYS);
    const notes = findValue(record, NOTES_KEYS);
    const contactRows = await sql<{ id: number }[]>`
      INSERT INTO contacts (workspace_id, phone_number, name, email, business_name, company_name, notes, source, last_seen, updated_at)
      VALUES (${workspaceId}, ${phone}, ${name}, ${email}, ${company}, ${company}, ${notes}, 'knowledge_import', NOW(), NOW())
      ON CONFLICT (workspace_id, phone_number) WHERE phone_number IS NOT NULL DO UPDATE SET
        name = COALESCE(NULLIF(EXCLUDED.name, ''), contacts.name),
        email = COALESCE(NULLIF(EXCLUDED.email, ''), contacts.email),
        business_name = COALESCE(NULLIF(EXCLUDED.business_name, ''), contacts.business_name),
        company_name = COALESCE(NULLIF(EXCLUDED.company_name, ''), contacts.company_name),
        notes = COALESCE(NULLIF(EXCLUDED.notes, ''), contacts.notes),
        last_seen = NOW(),
        updated_at = NOW()
      RETURNING id
    `;
    const contactId = contactRows[0]?.id;
    if (!contactId) continue;
    importedContacts += 1;

    for (const [fieldKey, fieldValue] of Object.entries(record)) {
      const normalizedKey = normalizeFieldKey(fieldKey);
      if (!normalizedKey || PHONE_KEYS.has(normalizedKey)) continue;
      if (!fieldValue.trim()) continue;
      await sql`
        INSERT INTO contact_custom_fields (contact_id, workspace_id, field_key, field_value, source, human_confirmed, updated_at)
        VALUES (${contactId}, ${workspaceId}, ${normalizedKey}, ${fieldValue.trim().slice(0, 1_000)}, 'knowledge_import', true, NOW())
        ON CONFLICT (contact_id, field_key) DO UPDATE SET
          field_value = EXCLUDED.field_value,
          source = 'knowledge_import',
          human_confirmed = true,
          updated_at = NOW()
      `;
      importedFields += 1;
    }
  }

  const summary = buildSummary(title, sourceType, content, records, importedContacts);
  const inserted = await sql<WorkspaceKnowledgeSource[]>`
    INSERT INTO workspace_knowledge_sources
      (workspace_id, title, source_type, summary, raw_excerpt, record_count, imported_contacts, updated_at)
    VALUES
      (${workspaceId}, ${title}, ${sourceType}, ${summary}, ${content.slice(0, MAX_EXCERPT_CHARS)}, ${records.length}, ${importedContacts}, NOW())
    RETURNING id, workspace_id, title, source_type, summary, raw_excerpt, record_count,
              imported_contacts, created_at, updated_at
  `;

  return {
    source: inserted[0],
    parsedRecords: records.length,
    importedContacts,
    importedFields,
  };
}

export async function buildWorkspaceKnowledgeContext(workspaceId: number): Promise<string> {
  const sources = await listWorkspaceKnowledgeSources(workspaceId).catch(() => []);
  if (sources.length === 0) {
    return "=== WORKSPACE KNOWLEDGE ===\nNo uploaded workspace knowledge yet. Do not invent prices, policies, service details, warranties, or customer facts. Ask for confirmation or create a callback task when details are missing.\n=== END WORKSPACE KNOWLEDGE ===";
  }

  const lines = sources.slice(0, 8).map((source) => {
    const excerpt = (source.raw_excerpt || "").replace(/\s+/g, " ").trim().slice(0, 500);
    return [
      `Source: ${source.title} (${source.source_type}, ${source.record_count} rows, ${source.imported_contacts} contacts)`,
      `Summary: ${source.summary}`,
      excerpt ? `Excerpt: ${excerpt}` : "",
    ].filter(Boolean).join("\n");
  });

  const body = lines.join("\n\n").slice(0, MAX_AGENT_CONTEXT_CHARS);
  return `=== WORKSPACE KNOWLEDGE ===
Use these uploaded workspace facts when answering callers. If the answer is not present in the business profile, caller history, or uploaded knowledge, do not guess. Say you can have the owner confirm it and capture the caller's need.

${body}
=== END WORKSPACE KNOWLEDGE ===`;
}
