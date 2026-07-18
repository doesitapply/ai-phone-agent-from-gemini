export const TRUSTED_PRODUCTION_APP_ORIGINS = Object.freeze([
  "https://ai-phone-agent-production-6811.up.railway.app",
  "https://smirkcalls.com",
  "https://www.smirkcalls.com",
] as const);

const TRUSTED_PRODUCTION_APP_ORIGIN_SET = new Set<string>(TRUSTED_PRODUCTION_APP_ORIGINS);
const UNSAFE_HOST_SUFFIX_RE = /(?:^|\.)(?:localhost|local|internal)$/i;
const URL_CONTROL_OR_WHITESPACE_RE = /[\u0000-\u0020\u007f]/;

const hasSafePublicHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized || UNSAFE_HOST_SUFFIX_RE.test(normalized)) return false;
  // Buyer-facing setup links never need literal IP hosts. Rejecting IP literals
  // keeps env mistakes from pointing a buyer at loopback or internal infrastructure.
  if (normalized.includes(":")) return false;
  if (/^\d+(?:\.\d+){3}$/.test(normalized)) return false;
  return true;
};

export function normalizePublicHttpsUrl(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 2_048 || URL_CONTROL_OR_WHITESPACE_RE.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || !hasSafePublicHostname(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function firstSafePublicHttpsUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const safeUrl = normalizePublicHttpsUrl(value);
    if (safeUrl) return safeUrl;
  }
  return null;
}

export function normalizeTrustedProductionAppUrl(value: unknown): string | null {
  const safeUrl = normalizePublicHttpsUrl(value);
  if (!safeUrl) return null;
  const url = new URL(safeUrl);
  if (url.port || !TRUSTED_PRODUCTION_APP_ORIGIN_SET.has(url.origin)) return null;
  return url.href;
}

export function resolveTrustedProductionAppOrigin(...values: unknown[]): string {
  for (const value of values) {
    const safeUrl = normalizeTrustedProductionAppUrl(value);
    if (safeUrl) return new URL(safeUrl).origin;
  }
  return TRUSTED_PRODUCTION_APP_ORIGINS[0];
}
