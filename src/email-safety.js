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

/**
 * Require every named alias to contain the same single strict mailbox.
 * This is used at the paid-buyer boundary so a stale legacy alias cannot
 * silently receive customer details.
 * @param {Record<string, unknown>} values
 * @param {string[]} keys
 */
export function evaluateCanonicalMailboxAliases(values, keys) {
  const entries = keys.map((key) => {
    const raw = typeof values?.[key] === "string" ? values[key].trim() : "";
    return { key, raw, normalized: normalizeStrictMailbox(raw) };
  });
  const missing = entries.filter((entry) => !entry.raw).map((entry) => entry.key);
  const invalid = entries.filter((entry) => entry.raw && !entry.normalized).map((entry) => entry.key);
  const exactValues = new Set(entries.map((entry) => entry.raw).filter(Boolean));
  const ready = missing.length === 0 && invalid.length === 0 && exactValues.size === 1;
  const blockers = [];
  if (missing.length) blockers.push(`missing aliases: ${missing.join(", ")}`);
  if (invalid.length) blockers.push(`invalid aliases: ${invalid.join(", ")}`);
  if (!missing.length && !invalid.length && exactValues.size !== 1) {
    blockers.push("all alert aliases must be exactly equal to the one reviewed recipient");
  }
  return {
    ready,
    canonical: ready ? entries[0].normalized : null,
    entries,
    blockers,
  };
}
