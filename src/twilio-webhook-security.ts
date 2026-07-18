export type WorkspaceTwilioCredential = {
  workspaceId?: number;
  accountSid: string;
  encryptedAuthToken: string;
};

export function normalizeTwilioAccountSid(raw: unknown): string {
  const value = String(raw || "").trim();
  return /^AC[a-fA-F0-9]{32}$/.test(value) ? value : "";
}

export function selectExactWorkspaceTwilioCredential(
  requestAccountSid: unknown,
  rows: Array<{
    workspace_id?: number;
    twilio_account_sid?: string | null;
    twilio_auth_token?: string | null;
  }>,
): WorkspaceTwilioCredential | null {
  const accountSid = normalizeTwilioAccountSid(requestAccountSid);
  if (!accountSid) return null;
  const exact = rows.filter((row) => normalizeTwilioAccountSid(row.twilio_account_sid) === accountSid);
  if (exact.length !== 1) return null;
  const encryptedAuthToken = String(exact[0].twilio_auth_token || "").trim();
  const workspaceId = Number(exact[0].workspace_id);
  if (!encryptedAuthToken || !Number.isSafeInteger(workspaceId) || workspaceId <= 0) return null;
  return { workspaceId, accountSid, encryptedAuthToken };
}

export function resolveTwilioWebhookAuthToken(input: {
  requestAccountSid: unknown;
  parentAccountSid: string;
  parentAuthToken: string;
  workspaceCredential?: WorkspaceTwilioCredential | null;
  decryptWorkspaceToken: (encrypted: string) => string;
}): { authToken: string; scope: "parent" | "workspace" } | null {
  const requestAccountSid = normalizeTwilioAccountSid(input.requestAccountSid);
  const parentAccountSid = normalizeTwilioAccountSid(input.parentAccountSid);
  if (!requestAccountSid) return null;
  if (parentAccountSid && requestAccountSid === parentAccountSid) {
    const parentAuthToken = String(input.parentAuthToken || "").trim();
    return parentAuthToken ? { authToken: parentAuthToken, scope: "parent" } : null;
  }
  const workspaceAccountSid = normalizeTwilioAccountSid(input.workspaceCredential?.accountSid);
  if (!workspaceAccountSid || workspaceAccountSid !== requestAccountSid) return null;
  try {
    const authToken = String(input.decryptWorkspaceToken(String(input.workspaceCredential?.encryptedAuthToken || "")) || "").trim();
    return authToken ? { authToken, scope: "workspace" } : null;
  } catch {
    return null;
  }
}

export function buildTwilioSignatureCandidateUrls(input: {
  originalUrl: string;
  forwardedProto?: string;
  forwardedHost?: string;
  rawHost?: string;
  appUrl?: string;
}): string[] {
  const originalUrl = String(input.originalUrl || "");
  if (!originalUrl.startsWith("/")) return [];
  const proto = String(input.forwardedProto || "https").split(",")[0].trim();
  const forwardedHost = String(input.forwardedHost || "").split(",")[0].trim();
  const rawHost = String(input.rawHost || "").trim();
  const appUrl = String(input.appUrl || "").replace(/\/$/, "");
  const candidates = [
    `${proto}://${forwardedHost}${originalUrl}`,
    `${proto}://${rawHost}${originalUrl}`,
    `${appUrl}${originalUrl}`,
    `https://${forwardedHost}${originalUrl}`,
    `https://${rawHost}${originalUrl}`,
  ];
  const safe = [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname || parsed.port) continue;
      const normalized = parsed.toString();
      if (!safe.includes(normalized)) safe.push(normalized);
    } catch {
      // Invalid proxy headers cannot become signature candidates.
    }
  }
  return safe;
}

export function validateTwilioWebhookSignature(input: {
  validateRequest: (authToken: string, signature: string, url: string, params: Record<string, unknown>) => boolean;
  authToken: string;
  signature: string;
  candidateUrls: string[];
  body: Record<string, unknown>;
}): boolean {
  const authToken = String(input.authToken || "").trim();
  const signature = String(input.signature || "").trim();
  if (!authToken || !signature || input.candidateUrls.length === 0) return false;
  return input.candidateUrls.some((url) => {
    try {
      return input.validateRequest(authToken, signature, url, input.body);
    } catch {
      return false;
    }
  });
}
