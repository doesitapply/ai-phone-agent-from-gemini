export type GoogleAudienceValidation =
  | { ok: true; audience: string }
  | { ok: false; code: "GOOGLE_OAUTH_NOT_CONFIGURED" | "GOOGLE_CLIENT_MISMATCH" };

export function validateGoogleTokenAudience(
  audience: unknown,
  configuredClientIds: readonly string[],
): GoogleAudienceValidation {
  const allowed = new Set(
    configuredClientIds
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  if (allowed.size === 0) return { ok: false, code: "GOOGLE_OAUTH_NOT_CONFIGURED" };

  const normalizedAudience = String(audience || "").trim();
  if (!normalizedAudience || !allowed.has(normalizedAudience)) {
    return { ok: false, code: "GOOGLE_CLIENT_MISMATCH" };
  }
  return { ok: true, audience: normalizedAudience };
}
