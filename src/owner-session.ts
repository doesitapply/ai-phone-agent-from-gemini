import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OWNER_SESSION_COOKIE = "smirk_owner_session";
export const OWNER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export type OwnerSession = {
  email: string;
  name?: string;
  picture?: string;
  subject?: string;
  role: "operator";
  issuedAt: number;
  expiresAt: number;
  sessionId: string;
};

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url").toString("utf8");

const signatureFor = (payload: string, secret: string) => (
  createHmac("sha256", secret).update(`smirk-owner-session.v1.${payload}`).digest("base64url")
);

export function issueOwnerSessionToken(input: {
  email: string;
  name?: string;
  picture?: string;
  subject?: string;
}, secret: string, nowMs = Date.now()): { token: string; session: OwnerSession } {
  if (!secret) throw new Error("Owner session signing is not configured.");
  const email = String(input.email || "").trim().toLowerCase();
  if (!email) throw new Error("Owner session email is required.");
  const issuedAt = Math.floor(nowMs / 1000);
  const session: OwnerSession = {
    email,
    name: String(input.name || "").trim() || undefined,
    picture: String(input.picture || "").trim() || undefined,
    subject: String(input.subject || "").trim() || undefined,
    role: "operator",
    issuedAt,
    expiresAt: issuedAt + OWNER_SESSION_TTL_SECONDS,
    sessionId: randomBytes(18).toString("base64url"),
  };
  const payload = encode(JSON.stringify(session));
  return { token: `${payload}.${signatureFor(payload, secret)}`, session };
}

export function verifyOwnerSessionToken(tokenRaw: string, secret: string, nowMs = Date.now()): OwnerSession | null {
  const token = String(tokenRaw || "").trim();
  if (!token || !secret) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = signatureFor(payload, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const parsed = JSON.parse(decode(payload)) as OwnerSession;
    const now = Math.floor(nowMs / 1000);
    if (parsed.role !== "operator" || !parsed.email || !parsed.sessionId) return null;
    if (!Number.isFinite(parsed.issuedAt) || !Number.isFinite(parsed.expiresAt)) return null;
    if (parsed.issuedAt > now + 60 || parsed.expiresAt <= now) return null;
    return { ...parsed, email: parsed.email.trim().toLowerCase() };
  } catch {
    return null;
  }
}

export function readOwnerSessionCookie(cookieHeader: string | undefined): string {
  const raw = String(cookieHeader || "");
  for (const entry of raw.split(";")) {
    const [name, ...rest] = entry.trim().split("=");
    if (name === OWNER_SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function ownerSessionCookie(token: string, secure: boolean): string {
  return [
    `${OWNER_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${OWNER_SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearOwnerSessionCookie(secure: boolean): string {
  return [
    `${OWNER_SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}
