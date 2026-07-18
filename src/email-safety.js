const PLACEHOLDER_DOMAINS = new Set(["example.com", "yourdomain.com"]);
const LOCAL_PART_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** @param {unknown} value */
export function extractMailboxAddress(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const displayMatch = raw.match(/^[^<>]*<([^<>]+)>$/);
  if (displayMatch) return displayMatch[1].trim();
  if (raw.includes("<") || raw.includes(">")) return "";
  return raw;
}

/** @param {unknown} value */
export function normalizeStrictMailbox(value) {
  const address = extractMailboxAddress(value);
  if (!address || address.length > 254) return null;
  const separator = address.lastIndexOf("@");
  if (separator <= 0 || separator !== address.indexOf("@")) return null;
  const local = address.slice(0, separator);
  const domain = address.slice(separator + 1).toLowerCase();
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!LOCAL_PART_RE.test(local) || domain.length > 253 || !DOMAIN_RE.test(domain)) return null;
  if (PLACEHOLDER_DOMAINS.has(domain) || domain.endsWith(".example.com") || domain.endsWith(".yourdomain.com")) return null;
  return `${local}@${domain}`;
}

/** @param {unknown} value */
export function parseStrictMailboxList(value) {
  const unique = new Set();
  for (const item of String(value || "").split(/[;,]/)) {
    const mailbox = normalizeStrictMailbox(item);
    if (mailbox) unique.add(mailbox);
  }
  return Array.from(unique);
}

/** @param {Record<string, unknown>} values */
export function collectStrictMailboxes(values) {
  const unique = new Set();
  for (const value of Object.values(values)) {
    for (const mailbox of parseStrictMailboxList(value)) unique.add(mailbox);
  }
  return Array.from(unique);
}
