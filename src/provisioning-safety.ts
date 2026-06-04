export function isTestLikeProvisioningInput(args: { businessName?: string | null; ownerEmail?: string | null; source?: string | null }): boolean {
  const businessName = String(args.businessName || "").trim().toLowerCase();
  const ownerEmail = String(args.ownerEmail || "").trim().toLowerCase();
  const source = String(args.source || "").trim().toLowerCase();
  const combined = `${businessName} ${ownerEmail} ${source}`.trim();
  if (!combined) return false;
  if (ownerEmail.endsWith("@example.com")) return true;
  if (ownerEmail.startsWith("test@") || ownerEmail.includes("+test") || ownerEmail.includes("+smoke") || ownerEmail.includes("+stripe")) return true;
  if (source === "test" || source.includes("smoke") || source.includes("buyer-auth-smoke")) return true;
  if (/^(test|testing|smoke|test business|smirk smoke test|smirk stripe webhook smoke)$/i.test(businessName)) return true;
  if (/\b(smoke|test|testing|webhook smoke|buyer-auth-smoke)\b/i.test(combined)) return true;
  return false;
}
