export type SmirkChatProviderName = "openrouter" | "gemini";

export type SmirkChatProviderFailureKind =
  | "authentication"
  | "capacity"
  | "timeout"
  | "upstream";

export type SmirkChatProviderAttempt = {
  provider: SmirkChatProviderName;
  status: "not_configured" | "failed" | "succeeded";
  failureKind?: SmirkChatProviderFailureKind;
};

export type SmirkChatProvider<T> = {
  name: SmirkChatProviderName;
  configured: boolean;
  stopOnAuthenticationFailure?: boolean;
  run: () => Promise<T>;
};

export class SmirkChatProviderUnavailableError extends Error {
  readonly code = "SMIRK_CHAT_PROVIDER_UNAVAILABLE";
  readonly retryable = true;
  readonly attempts: readonly SmirkChatProviderAttempt[];

  constructor(attempts: readonly SmirkChatProviderAttempt[]) {
    super(
      "SMIRK chat is temporarily unavailable. Check AI provider status and billing, then try again."
    );
    this.name = "SmirkChatProviderUnavailableError";
    this.attempts = attempts;
  }
}

export function classifySmirkChatProviderFailure(
  error: unknown
): SmirkChatProviderFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid.{0,20}(?:api )?key|authentication/i.test(
      message
    )
  ) {
    return "authentication";
  }
  if (
    /\b429\b|resource[_ -]?exhausted|quota|rate.?limit|credit|billing|insufficient funds/i.test(
      message
    )
  ) {
    return "capacity";
  }
  if (/abort|timeout|timed out|deadline/i.test(message)) {
    return "timeout";
  }
  return "upstream";
}

export function isSmirkChatProviderUnavailableError(
  error: unknown
): error is SmirkChatProviderUnavailableError {
  return error instanceof SmirkChatProviderUnavailableError;
}

export async function runSmirkChatProviderChain<T>(input: {
  providers: readonly SmirkChatProvider<T>[];
  canFailover: () => boolean;
  onFailure?: (
    attempt: SmirkChatProviderAttempt,
    error: unknown
  ) => void;
}): Promise<{
  value: T;
  provider: SmirkChatProviderName;
  attempts: readonly SmirkChatProviderAttempt[];
}> {
  const attempts: SmirkChatProviderAttempt[] = [];

  for (const provider of input.providers) {
    if (!provider.configured) {
      attempts.push({
        provider: provider.name,
        status: "not_configured",
      });
      continue;
    }

    try {
      const value = await provider.run();
      attempts.push({ provider: provider.name, status: "succeeded" });
      return { value, provider: provider.name, attempts };
    } catch (error) {
      const failureKind = classifySmirkChatProviderFailure(error);
      const attempt: SmirkChatProviderAttempt = {
        provider: provider.name,
        status: "failed",
        failureKind,
      };
      attempts.push(attempt);
      input.onFailure?.(attempt, error);

      if (
        !input.canFailover() ||
        (failureKind === "authentication" &&
          provider.stopOnAuthenticationFailure)
      ) {
        break;
      }
    }
  }

  throw new SmirkChatProviderUnavailableError(attempts);
}
