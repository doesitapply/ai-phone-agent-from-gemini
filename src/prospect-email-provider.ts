import {
  hashProspectOutreachPayload,
  prospectOutreachPayloadSchema,
  type ProspectOutreachPayload,
} from "./prospect-outreach.js";

export const PROSPECT_EMAIL_EXECUTION_MODE =
  "single-recipient-reviewed-v1" as const;
export const PROSPECT_EMAIL_EXECUTION_CONFIRMATION =
  "send-one-approved-email-v1" as const;

const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";
const MAX_RESPONSE_BYTES = 32 * 1024;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type ProspectEmailProviderConfig = {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  mode: typeof PROSPECT_EMAIL_EXECUTION_MODE | null;
  apiKey: string;
  from: string;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  workspaceId: number | null;
  dailyRecipientCap: number | null;
  dailySpendCapCents: number | null;
  unitCostCents: number | null;
};

export type ProspectEmailProviderResult =
  | {
      status: "accepted";
      provider: "resend";
      providerMessageId: string;
      httpStatus: number;
    }
  | {
      status: "blocked" | "definitive_failure" | "outcome_unknown";
      provider: "resend";
      code: string;
      error: string;
      httpStatus?: number;
      retryable: boolean;
    };

function positiveInteger(
  raw: string | undefined,
  minimum: number,
  maximum: number
): number | null {
  if (!/^\d+$/.test(String(raw || ""))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) &&
    value.length <= 320
    ? value
    : null;
}

function isSmirkMailbox(address: string): boolean {
  const domain = address.split("@")[1] || "";
  return domain === "smirkcalls.com" || domain.endsWith(".smirkcalls.com");
}

function parseFromMailbox(
  raw: string
): { from: string; name: string; address: string } | null {
  const match = raw.trim().match(/^([^<>\r\n]{2,160})<([^<>\r\n]+)>$/);
  if (!match) return null;
  const name = match[1].trim();
  const address = normalizeEmail(match[2]);
  if (!name || !address || !isSmirkMailbox(address)) return null;
  return { from: `${name} <${address}>`, name, address };
}

export function readProspectEmailProviderConfig(
  env: Record<string, string | undefined> = process.env
): ProspectEmailProviderConfig {
  const enabled = env.PROSPECT_EMAIL_EXECUTION_ENABLED === "true";
  const mode =
    env.PROSPECT_EMAIL_EXECUTION_MODE === PROSPECT_EMAIL_EXECUTION_MODE
      ? PROSPECT_EMAIL_EXECUTION_MODE
      : null;
  const apiKey = String(env.PROSPECT_EMAIL_RESEND_API_KEY || "").trim();
  const parsedFrom = parseFromMailbox(
    String(env.PROSPECT_EMAIL_FROM || "")
  );
  const replyTo =
    normalizeEmail(String(env.PROSPECT_EMAIL_REPLY_TO || "")) || "";
  const workspaceId = positiveInteger(
    env.PROSPECT_EMAIL_WORKSPACE_ID,
    1,
    Number.MAX_SAFE_INTEGER
  );
  const dailyRecipientCap = positiveInteger(
    env.PROSPECT_EMAIL_DAILY_RECIPIENT_CAP,
    1,
    20
  );
  const dailySpendCapCents = positiveInteger(
    env.PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS,
    1,
    100
  );
  const unitCostCents = positiveInteger(
    env.PROSPECT_EMAIL_UNIT_COST_CENTS,
    1,
    5
  );
  const missing: string[] = [];

  if (!mode) missing.push("PROSPECT_EMAIL_EXECUTION_MODE");
  if (!/^re_[A-Za-z0-9_]{12,}$/.test(apiKey)) {
    missing.push("PROSPECT_EMAIL_RESEND_API_KEY");
  }
  if (
    apiKey &&
    apiKey === String(env.RESEND_API_KEY || "").trim()
  ) {
    missing.push("PROSPECT_EMAIL_RESEND_API_KEY");
  }
  if (!parsedFrom) missing.push("PROSPECT_EMAIL_FROM");
  if (!replyTo || !isSmirkMailbox(replyTo)) {
    missing.push("PROSPECT_EMAIL_REPLY_TO");
  }
  if (!workspaceId) missing.push("PROSPECT_EMAIL_WORKSPACE_ID");
  if (!dailyRecipientCap) {
    missing.push("PROSPECT_EMAIL_DAILY_RECIPIENT_CAP");
  }
  if (!dailySpendCapCents) {
    missing.push("PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS");
  }
  if (!unitCostCents) missing.push("PROSPECT_EMAIL_UNIT_COST_CENTS");
  if (
    dailySpendCapCents &&
    unitCostCents &&
    dailySpendCapCents < unitCostCents
  ) {
    missing.push("PROSPECT_EMAIL_DAILY_SPEND_CAP_CENTS");
  }

  return {
    enabled,
    configured: missing.length === 0,
    missing: Array.from(new Set(missing)),
    mode,
    apiKey,
    from: parsedFrom?.from || "",
    fromName: parsedFrom?.name || "",
    fromAddress: parsedFrom?.address || "",
    replyTo,
    workspaceId,
    dailyRecipientCap,
    dailySpendCapCents,
    unitCostCents,
  };
}

export function buildProspectEmailIdempotencyKey(input: {
  approvalId: string;
  payloadHash: string;
}): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.approvalId
    ) ||
    !/^[a-f0-9]{64}$/.test(input.payloadHash)
  ) {
    throw new Error(
      "A valid approval ID and payload hash are required for email idempotency."
    );
  }
  return `smirk-prospect-email/${input.approvalId}/${input.payloadHash.slice(
    0,
    24
  )}`;
}

function safeProviderMessage(raw: unknown): string {
  return String(raw || "Email provider request failed.")
    .replace(/re_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_RESPONSE_BYTES
  ) {
    throw new Error("Email provider response exceeded the safe size limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Email provider response exceeded the safe size limit.");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function responseBody(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function assertApprovedEmailPayload(
  rawPayload: unknown,
  config: ProspectEmailProviderConfig
): ProspectOutreachPayload {
  const payload = prospectOutreachPayloadSchema.parse(rawPayload);
  if (
    payload.channel !== "email" ||
    !payload.subject ||
    !payload.emailCompliance ||
    payload.controls.providerExecution !==
      "operator-triggered-single-recipient" ||
    payload.controls.bulkExecution !== false ||
    payload.controls.smsAllowed !== false
  ) {
    throw new Error(
      "Only one approved recipient-specific email can reach the provider."
    );
  }
  if (
    payload.emailCompliance.senderIdentity.toLowerCase() !==
    config.fromName.toLowerCase()
  ) {
    throw new Error(
      "The approved sender identity does not match the configured From identity."
    );
  }
  for (const requiredText of [
    payload.emailCompliance.advertisementDisclosure,
    payload.emailCompliance.senderIdentity,
    payload.emailCompliance.physicalPostalAddress,
    payload.emailCompliance.optOutInstructions,
  ]) {
    if (!payload.content.includes(requiredText)) {
      throw new Error(
        "The provider payload is missing approved commercial-email compliance text."
      );
    }
  }
  if (
    !config.unitCostCents ||
    payload.maxCostCents < config.unitCostCents
  ) {
    throw new Error("The approved per-message cost cap is too low.");
  }
  return payload;
}

export async function sendApprovedProspectEmail(input: {
  payload: unknown;
  payloadHash: string;
  approvalId: string;
  idempotencyKey: string;
  config: ProspectEmailProviderConfig;
  fetchImpl?: FetchLike;
}): Promise<ProspectEmailProviderResult> {
  if (!input.config.enabled || !input.config.configured) {
    return {
      status: "blocked",
      provider: "resend",
      code: input.config.enabled
        ? "PROSPECT_EMAIL_NOT_CONFIGURED"
        : "PROSPECT_EMAIL_EXECUTION_DISABLED",
      error: input.config.enabled
        ? `Prospect email is not configured: ${input.config.missing.join(", ")}`
        : "Prospect email execution is disabled.",
      retryable: false,
    };
  }

  let payload: ProspectOutreachPayload;
  try {
    payload = assertApprovedEmailPayload(input.payload, input.config);
    if (hashProspectOutreachPayload(payload) !== input.payloadHash) {
      throw new Error(
        "The approved email payload does not match its immutable hash."
      );
    }
    const expectedIdempotencyKey = buildProspectEmailIdempotencyKey({
      approvalId: input.approvalId,
      payloadHash: input.payloadHash,
    });
    if (input.idempotencyKey !== expectedIdempotencyKey) {
      throw new Error("The email idempotency key does not match the approval.");
    }
  } catch (error) {
    return {
      status: "blocked",
      provider: "resend",
      code: "PROSPECT_EMAIL_INVALID_APPROVED_PAYLOAD",
      error:
        error instanceof Error
          ? error.message
          : "Approved email payload validation failed.",
      retryable: false,
    };
  }

  try {
    const response = await (input.fetchImpl || fetch)(
      RESEND_EMAIL_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({
          from: input.config.from,
          to: [payload.recipient],
          reply_to: input.config.replyTo,
          subject: payload.subject,
          text: payload.content,
        }),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      }
    );
    const raw = await readBoundedResponse(response);
    const body = responseBody(raw);
    const providerCode = String(
      body.name || body.code || body.error || ""
    ).trim();
    const providerMessage = safeProviderMessage(
      body.message || body.error || `Resend returned HTTP ${response.status}.`
    );

    if (response.ok) {
      const providerMessageId = String(body.id || "").trim();
      if (
        !providerMessageId ||
        providerMessageId.length > 200 ||
        /[\s\r\n]/.test(providerMessageId)
      ) {
        return {
          status: "outcome_unknown",
          provider: "resend",
          code: "PROSPECT_EMAIL_PROVIDER_ID_MISSING",
          error:
            "The provider accepted the request without a usable message identifier.",
          httpStatus: response.status,
          retryable: true,
        };
      }
      return {
        status: "accepted",
        provider: "resend",
        providerMessageId,
        httpStatus: response.status,
      };
    }

    if (
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500 ||
      providerCode === "concurrent_idempotent_requests"
    ) {
      return {
        status: "outcome_unknown",
        provider: "resend",
        code:
          providerCode ||
          `PROSPECT_EMAIL_PROVIDER_HTTP_${response.status}`,
        error: providerMessage,
        httpStatus: response.status,
        retryable: true,
      };
    }

    return {
      status: "definitive_failure",
      provider: "resend",
      code:
        providerCode || `PROSPECT_EMAIL_PROVIDER_HTTP_${response.status}`,
      error: providerMessage,
      httpStatus: response.status,
      retryable: false,
    };
  } catch (error) {
    return {
      status: "outcome_unknown",
      provider: "resend",
      code: "PROSPECT_EMAIL_PROVIDER_REQUEST_UNCERTAIN",
      error: safeProviderMessage(
        error instanceof Error ? error.message : "Email provider request failed."
      ),
      retryable: true,
    };
  }
}
