export function resolveOperatorAdminEmails(input: {
  googleAdminEmails?: string | null;
  extraOperatorEmails?: string | null;
  ownerEmail?: string | null;
}): string[] {
  const split = (raw?: string | null) => String(raw || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const placeholders = new Set(["owner@example.com", "admin@example.com"]);
  return Array.from(new Set([
    ...split(input.googleAdminEmails),
    ...split(input.extraOperatorEmails),
    ...split(input.ownerEmail),
  ].filter((email) => !placeholders.has(email))));
}
