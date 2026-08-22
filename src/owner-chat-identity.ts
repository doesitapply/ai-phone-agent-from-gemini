type OwnerChatIdentityInput = {
  email?: string | null;
  emailVerified?: boolean;
};

const splitCsv = (raw?: string | null): string[] => String(raw || "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

export function resolveOwnerChatEmails(input: {
  ownerChatEmails?: string | null;
  ownerEmail?: string | null;
}): string[] {
  const explicitAllowlist = splitCsv(input.ownerChatEmails);
  const fallbackOwner = splitCsv(input.ownerEmail);
  const source = explicitAllowlist.length > 0 ? explicitAllowlist : fallbackOwner;
  const placeholders = new Set(["owner@example.com", "admin@example.com"]);
  return Array.from(new Set(source.filter((email) => !placeholders.has(email))));
}

export function isVerifiedOwnerChatIdentity(
  identity: OwnerChatIdentityInput,
  allowedEmails: readonly string[]
): boolean {
  const email = String(identity.email || "").trim().toLowerCase();
  return Boolean(identity.emailVerified && email && allowedEmails.includes(email));
}
