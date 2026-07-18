const value = (env, key) => String(env?.[key] || "").trim();

const isUsableSecret = (raw, minimumLength = 20) => {
  const normalized = String(raw || "").trim();
  if (normalized.length < minimumLength) return false;
  return !/(?:change[_-]?me|replace[_-]?me|your[_-]|example|\.\.\.|xxxxx)/i.test(normalized);
};

const hasGoogleTtsServiceAccount = (raw) => {
  const encoded = String(raw || "").trim();
  if (!encoded) return false;
  const candidates = [encoded];
  try {
    candidates.push(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    // The raw candidate is still checked below.
  }
  return candidates.some((candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed?.type === "service_account"
        && isUsableSecret(parsed?.private_key, 32)
        && /@/.test(String(parsed?.client_email || ""));
    } catch {
      return false;
    }
  });
};

export function evaluateFirstDollarVoiceReadiness(env = process.env) {
  const parentAccountSidReady = /^AC[a-fA-F0-9]{32}$/.test(value(env, "TWILIO_ACCOUNT_SID"));
  const parentAuthTokenReady = isUsableSecret(value(env, "TWILIO_AUTH_TOKEN"), 20);
  const workspaceSecretEncryptionReady = isUsableSecret(value(env, "WORKSPACE_SECRET_ENCRYPTION_KEY"), 32);
  const twilioProvisioningReady = parentAccountSidReady && parentAuthTokenReady && workspaceSecretEncryptionReady;

  const openRouterKeyReady = /^sk-or-[A-Za-z0-9_-]{16,}$/.test(value(env, "OPENROUTER_API_KEY"));
  const openRouterEnabled = value(env, "OPENROUTER_ENABLED").toLowerCase() === "true";
  // The runtime only enters streamingTtsPipeline when FAST_LIVE_CALLS is false.
  const streamingPathEnabled = value(env, "FAST_LIVE_CALLS").toLowerCase() === "false";
  const ttsProviders = {
    cartesia: isUsableSecret(value(env, "CARTESIA_API_KEY")),
    elevenlabs: isUsableSecret(value(env, "ELEVENLABS_API_KEY"))
      && value(env, "ELEVENLABS_ENABLED").toLowerCase() !== "false",
    google: (isUsableSecret(value(env, "GOOGLE_TTS_API_KEY"))
      || hasGoogleTtsServiceAccount(value(env, "GOOGLE_SERVICE_ACCOUNT_JSON")))
      && value(env, "GOOGLE_TTS_ENABLED").toLowerCase() !== "false",
    openai: /^sk-[A-Za-z0-9_-]{16,}$/.test(value(env, "OPENAI_API_KEY")),
  };
  const streamingTtsReady = Object.values(ttsProviders).some(Boolean);
  const streamingAiReady = openRouterKeyReady && openRouterEnabled && streamingPathEnabled && streamingTtsReady;

  const blockers = [];
  if (!parentAccountSidReady) blockers.push("TWILIO_ACCOUNT_SID must be an exact Twilio AC... SID");
  if (!parentAuthTokenReady) blockers.push("TWILIO_AUTH_TOKEN must be a non-placeholder parent-account auth token");
  if (!workspaceSecretEncryptionReady) blockers.push("WORKSPACE_SECRET_ENCRYPTION_KEY must be a dedicated secret of at least 32 characters");
  if (!openRouterKeyReady) blockers.push("OPENROUTER_API_KEY must be a non-placeholder OpenRouter key");
  if (!openRouterEnabled) blockers.push("OPENROUTER_ENABLED must be exactly true");
  if (!streamingPathEnabled) blockers.push("FAST_LIVE_CALLS must be exactly false because true bypasses the streaming AI path");
  if (!streamingTtsReady) blockers.push("at least one enabled premium streaming TTS provider must be configured");

  return {
    twilioProvisioningReady,
    parentAccountSidReady,
    parentAuthTokenReady,
    workspaceSecretEncryptionReady,
    streamingAiReady,
    openRouterKeyReady,
    openRouterEnabled,
    streamingPathEnabled,
    streamingTtsReady,
    ttsProviders,
    blockers,
    ready: twilioProvisioningReady && streamingAiReady,
  };
}
