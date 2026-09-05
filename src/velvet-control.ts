export type VelvetControlConfiguration =
  | { configured: true; baseUrl: string; apiKey: string }
  | { configured: false; reason: string };

export function getVelvetControlConfiguration(
  env: Record<string, string | undefined> = process.env,
): VelvetControlConfiguration {
  const rawBaseUrl = String(env.VELVET_ALCHEMY_BASE_URL || "").trim();
  const apiKey = String(env.VELVET_ALCHEMY_READ_KEY || "").trim();
  if (!rawBaseUrl) return { configured: false, reason: "VELVET_ALCHEMY_BASE_URL is not configured." };
  if (!apiKey) return { configured: false, reason: "VELVET_ALCHEMY_READ_KEY is not configured." };

  try {
    const parsed = new URL(rawBaseUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      return { configured: false, reason: "VELVET_ALCHEMY_BASE_URL must use HTTPS outside local development." };
    }
    return { configured: true, baseUrl: parsed.toString().replace(/\/$/, ""), apiKey };
  } catch {
    return { configured: false, reason: "VELVET_ALCHEMY_BASE_URL is not a valid URL." };
  }
}

async function velvetGet(path: string): Promise<Record<string, unknown>> {
  const config = getVelvetControlConfiguration();
  if (config.configured === false) return { ok: false, state: "not_configured", reason: config.reason };

  try {
    const response = await fetch(`${config.baseUrl}/api/v1${path}`, {
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({ error: "Velvet returned a non-JSON response." }));
    if (!response.ok) {
      return {
        ok: false,
        state: response.status === 401 || response.status === 403 ? "unauthorized" : "degraded",
        status: response.status,
        error: typeof body?.error === "string" ? body.error : "Velvet control request failed.",
      };
    }
    return { ok: true, state: "reachable", ...(body as Record<string, unknown>) };
  } catch (error) {
    return { ok: false, state: "unreachable", error: error instanceof Error ? error.message : "Velvet request failed." };
  }
}

/** Read-only, allowlisted cross-system functions. Never accepts arbitrary URLs or methods. */
export const velvetControl = {
  getSystemState: () => velvetGet("/integrations/smirk/control"),
  listQualifiedLeads: (limit?: number) => velvetGet(`/integrations/smirk/control/qualified?limit=${Math.min(Math.max(Number(limit) || 10, 1), 25)}`),
  getLeadEvidence: (leadId: number) => velvetGet(`/integrations/smirk/control/leads/${Math.max(1, Math.trunc(Number(leadId)))}`),
};
