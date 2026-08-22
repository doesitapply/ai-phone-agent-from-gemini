export type ChatProviderFailure = {
  status: number;
  body: {
    error: string;
    code: "CHAT_PROVIDER_ACCESS_DENIED" | "CHAT_PROVIDER_UNAVAILABLE";
  };
};

export function shouldTryOpenRouterFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /permission_denied|project has been denied access|project.*denied|\b403\b/i.test(message);
}

export function toSafeChatProviderFailure(error: unknown): ChatProviderFailure {
  if (shouldTryOpenRouterFallback(error)) {
    return {
      status: 503,
      body: {
        error: "SMIRK Agent is temporarily unavailable because its AI provider access needs repair. No action was taken.",
        code: "CHAT_PROVIDER_ACCESS_DENIED",
      },
    };
  }

  return {
    status: 503,
    body: {
      error: "SMIRK Agent is temporarily unavailable. No action was taken.",
      code: "CHAT_PROVIDER_UNAVAILABLE",
    },
  };
}
