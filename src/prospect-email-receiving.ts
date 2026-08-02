import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeProspectEmailAddress } from "./prospect-email-webhook.js";

export const PROSPECT_EMAIL_RECEIVING_MODE =
  "operator-reviewed-content-v1" as const;
export const PROSPECT_EMAIL_RECEIVING_CONFIRMATION =
  "retrieve-one-inbound-email-content-v1" as const;
export const PROSPECT_INBOUND_REPLY_CONTENT_CONTRACT_VERSION =
  "smirk.prospect-inbound-reply-content.v1" as const;

export const PROSPECT_EMAIL_RECEIVING_MAX_TEXT_BYTES = 20 * 1024;
const PROSPECT_EMAIL_RECEIVING_MAX_RESPONSE_BYTES = 512 * 1024;
const PROSPECT_EMAIL_RECEIVING_TIMEOUT_MS = 5_000;
const RESEND_RECEIVING_BASE_URL =
  "https://api.resend.com/emails/receiving";

export type ProspectEmailReceivingConfig = {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  mode: string;
  apiKey: string;
  workspaceId: number | null;
  replyToAddress: string;
};

export class ProspectEmailReceivingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
  }
}

function positiveInteger(raw: string | undefined): number | null {
  if (!/^\d+$/.test(String(raw || ""))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isSmirkAddress(address: string | null): address is string {
  if (!address) return false;
  const domain = address.split("@")[1] || "";
  return domain === "smirkcalls.com" || domain.endsWith(".smirkcalls.com");
}

export function readProspectEmailReceivingConfig(
  env: Record<string, string | undefined> = process.env
): ProspectEmailReceivingConfig {
  const enabled = env.PROSPECT_EMAIL_RECEIVING_ENABLED === "true";
  const mode = String(env.PROSPECT_EMAIL_RECEIVING_MODE || "").trim();
  const apiKey = String(
    env.PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY || ""
  ).trim();
  const workspaceId = positiveInteger(
    env.PROSPECT_EMAIL_RECEIVING_WORKSPACE_ID
  );
  const replyToAddress = normalizeProspectEmailAddress(
    env.PROSPECT_EMAIL_REPLY_TO
  );
  const privilegedKeys = [
    env.PROSPECT_EMAIL_RESEND_API_KEY,
    env.RESEND_API_KEY,
    env.DASHBOARD_API_KEY,
    env.DEMO_OPERATOR_API_KEY,
    env.VELVET_ALCHEMY_HANDOFF_API_KEY,
    env.VELVET_ALCHEMY_RESEARCH_API_KEY,
    env.VELVET_LEAD_SOURCE_API_KEY,
    env.VELVET_OUTCOME_API_KEY,
    env.PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY,
    env.PROSPECT_REVENUE_LOOP_PREPARER_API_KEY,
  ]
    .map(value => String(value || "").trim())
    .filter(Boolean);
  const missing: string[] = [];

  if (mode !== PROSPECT_EMAIL_RECEIVING_MODE) {
    missing.push("PROSPECT_EMAIL_RECEIVING_MODE");
  }
  if (!/^re_[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
    missing.push("PROSPECT_EMAIL_RESEND_RECEIVING_API_KEY");
  } else if (privilegedKeys.includes(apiKey)) {
    missing.push("PROSPECT_EMAIL_RECEIVING_API_KEY_SEPARATION");
  }
  if (!workspaceId) {
    missing.push("PROSPECT_EMAIL_RECEIVING_WORKSPACE_ID");
  }
  if (!isSmirkAddress(replyToAddress)) {
    missing.push("PROSPECT_EMAIL_REPLY_TO");
  }

  return {
    enabled,
    configured: missing.length === 0,
    missing,
    mode,
    apiKey,
    workspaceId,
    replyToAddress: replyToAddress || "",
  };
}

const contentRetrievalAttestationsSchema = z
  .object({
    noContactAuthorized: z.literal(true),
    noSendAuthorized: z.literal(true),
    attachmentsNotRequested: z.literal(true),
    htmlWillNotBeStored: z.literal(true),
  })
  .strict();

export const retrieveProspectInboundReplyContentSchema = z
  .object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.literal(PROSPECT_EMAIL_RECEIVING_CONFIRMATION),
    attestations: contentRetrievalAttestationsSchema,
  })
  .strict();

export const prospectInboundReplyContentReceiptSchema = z
  .object({
    contractVersion: z.literal(
      PROSPECT_INBOUND_REPLY_CONTENT_CONTRACT_VERSION
    ),
    reviewId: z.string().uuid(),
    workspaceId: z.number().int().positive(),
    providerEventId: z.string().trim().min(8).max(200),
    inboundMessageId: z.string().trim().min(1).max(200),
    replyReviewPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    retrievalRequestHash: z.string().regex(/^[a-f0-9]{64}$/),
    sender: z.string().email().max(320),
    replyToAddress: z.string().email().max(320),
    subject: z.string().max(998),
    providerCreatedAt: z.string().datetime({ offset: true }),
    plainText: z.string().min(1).max(PROSPECT_EMAIL_RECEIVING_MAX_TEXT_BYTES),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    contentBytes: z
      .number()
      .int()
      .min(1)
      .max(PROSPECT_EMAIL_RECEIVING_MAX_TEXT_BYTES),
    retrievedBy: z.string().trim().min(1).max(160),
    retrievedAt: z.string().datetime({ offset: true }),
    providerReadPerformed: z.literal(true),
    contactAuthorized: z.literal(false),
    sendAuthorized: z.literal(false),
    htmlStored: z.literal(false),
    attachmentsFetched: z.literal(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    const contentBytes = Buffer.byteLength(value.plainText, "utf8");
    if (contentBytes !== value.contentBytes) {
      ctx.addIssue({
        code: "custom",
        path: ["contentBytes"],
        message: "The content byte count does not match the plain text.",
      });
    }
    if (sha256(value.plainText) !== value.contentHash) {
      ctx.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "The content hash does not match the plain text.",
      });
    }
  });

export type RetrieveProspectInboundReplyContent = z.infer<
  typeof retrieveProspectInboundReplyContentSchema
>;
export type ProspectInboundReplyContentReceipt = z.infer<
  typeof prospectInboundReplyContentReceiptSchema
>;

type ProspectReceivedEmailContent = {
  inboundMessageId: string;
  sender: string;
  replyToAddress: string;
  subject: string;
  providerCreatedAt: string;
  plainText: string;
  contentHash: string;
  contentBytes: number;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashValue(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function hashProspectInboundReplyContentRequest(
  request: RetrieveProspectInboundReplyContent
): string {
  return hashValue(
    retrieveProspectInboundReplyContentSchema.parse(request)
  );
}

export function hashProspectInboundReplyContentReceipt(
  receipt: ProspectInboundReplyContentReceipt
): string {
  return hashValue(
    prospectInboundReplyContentReceiptSchema.parse(receipt)
  );
}

function normalizePlainText(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    throw new ProspectEmailReceivingError(
      "The received email has no reviewable plain-text content.",
      422,
      "PROSPECT_EMAIL_RECEIVING_TEXT_REQUIRED"
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new ProspectEmailReceivingError(
      "The received email plain text contains unsupported control characters.",
      422,
      "PROSPECT_EMAIL_RECEIVING_TEXT_INVALID"
    );
  }
  if (
    Buffer.byteLength(normalized, "utf8") >
    PROSPECT_EMAIL_RECEIVING_MAX_TEXT_BYTES
  ) {
    throw new ProspectEmailReceivingError(
      "The received email plain text exceeds the review limit.",
      413,
      "PROSPECT_EMAIL_RECEIVING_TEXT_TOO_LARGE"
    );
  }
  return normalized;
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  const declaredLength = Number(
    response.headers.get("content-length") || "0"
  );
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > PROSPECT_EMAIL_RECEIVING_MAX_RESPONSE_BYTES
  ) {
    throw new ProspectEmailReceivingError(
      "The received email provider response exceeds the safe limit.",
      502,
      "PROSPECT_EMAIL_RECEIVING_RESPONSE_TOO_LARGE"
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > PROSPECT_EMAIL_RECEIVING_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ProspectEmailReceivingError(
        "The received email provider response exceeds the safe limit.",
        502,
        "PROSPECT_EMAIL_RECEIVING_RESPONSE_TOO_LARGE"
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProspectEmailReceivingError(
      "The received email provider returned invalid UTF-8.",
      502,
      "PROSPECT_EMAIL_RECEIVING_RESPONSE_INVALID"
    );
  }
}

const providerResponseSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    from: z.string().trim().min(3).max(500),
    to: z.array(z.string().max(500)).max(100),
    received_for: z.array(z.string().max(500)).max(100),
    subject: z.string().max(998),
    created_at: z.string().datetime({ offset: true }),
    text: z.string().nullable(),
  })
  .passthrough();

export async function retrieveProspectReceivedEmail(input: {
  config: ProspectEmailReceivingConfig;
  inboundMessageId: string;
  expectedSender: string;
  fetchImpl?: typeof fetch;
}): Promise<ProspectReceivedEmailContent> {
  if (!input.config.enabled) {
    throw new ProspectEmailReceivingError(
      "Prospect email content retrieval is disabled.",
      503,
      "PROSPECT_EMAIL_RECEIVING_DISABLED"
    );
  }
  if (!input.config.configured || !input.config.workspaceId) {
    throw new ProspectEmailReceivingError(
      `Prospect email content retrieval is not configured: ${input.config.missing.join(", ")}`,
      503,
      "PROSPECT_EMAIL_RECEIVING_NOT_CONFIGURED"
    );
  }
  const inboundMessageId = String(input.inboundMessageId || "").trim();
  if (
    !inboundMessageId ||
    inboundMessageId.length > 200 ||
    /[\s\r\n]/.test(inboundMessageId)
  ) {
    throw new ProspectEmailReceivingError(
      "The received email provider ID is invalid.",
      400,
      "PROSPECT_EMAIL_RECEIVING_ID_INVALID"
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PROSPECT_EMAIL_RECEIVING_TIMEOUT_MS
  );
  let response: Response;
  try {
    response = await (input.fetchImpl || fetch)(
      `${RESEND_RECEIVING_BASE_URL}/${encodeURIComponent(inboundMessageId)}?html_format=cid`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.config.apiKey}`,
        },
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      }
    );
  } catch {
    clearTimeout(timeout);
    throw new ProspectEmailReceivingError(
      "The received email provider request failed before a verified response.",
      502,
      "PROSPECT_EMAIL_RECEIVING_PROVIDER_FAILED"
    );
  }
  if (!response.ok) {
    clearTimeout(timeout);
    throw new ProspectEmailReceivingError(
      "The received email provider did not return the requested content.",
      502,
      "PROSPECT_EMAIL_RECEIVING_PROVIDER_REJECTED"
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(await readBoundedResponseBody(response));
  } catch (error) {
    if (error instanceof ProspectEmailReceivingError) throw error;
    throw new ProspectEmailReceivingError(
      "The received email provider response is invalid.",
      502,
      "PROSPECT_EMAIL_RECEIVING_RESPONSE_INVALID"
    );
  } finally {
    clearTimeout(timeout);
  }
  const parsed = providerResponseSchema.safeParse(parsedBody);
  if (!parsed.success) {
    throw new ProspectEmailReceivingError(
      "The received email provider response is incomplete.",
      502,
      "PROSPECT_EMAIL_RECEIVING_RESPONSE_INVALID"
    );
  }

  const sender = normalizeProspectEmailAddress(parsed.data.from);
  const expectedSender = normalizeProspectEmailAddress(
    input.expectedSender
  );
  const recipients = [...parsed.data.to, ...parsed.data.received_for]
    .map(normalizeProspectEmailAddress)
    .filter((value): value is string => Boolean(value));
  if (
    parsed.data.id !== inboundMessageId ||
    !sender ||
    sender !== expectedSender ||
    !recipients.includes(input.config.replyToAddress)
  ) {
    throw new ProspectEmailReceivingError(
      "The received email content does not match the immutable review metadata.",
      409,
      "PROSPECT_EMAIL_RECEIVING_BINDING_MISMATCH"
    );
  }

  const plainText = normalizePlainText(parsed.data.text || "");
  return {
    inboundMessageId,
    sender,
    replyToAddress: input.config.replyToAddress,
    subject: parsed.data.subject.trim(),
    providerCreatedAt: new Date(parsed.data.created_at).toISOString(),
    plainText,
    contentHash: sha256(plainText),
    contentBytes: Buffer.byteLength(plainText, "utf8"),
  };
}

export function buildProspectInboundReplyContentReceipt(input: {
  reviewId: string;
  workspaceId: number;
  providerEventId: string;
  replyReviewPayloadHash: string;
  request: RetrieveProspectInboundReplyContent;
  content: ProspectReceivedEmailContent;
  retrievedBy: string;
  retrievedAt: string | Date;
}): ProspectInboundReplyContentReceipt {
  const request = retrieveProspectInboundReplyContentSchema.parse(
    input.request
  );
  return prospectInboundReplyContentReceiptSchema.parse({
    contractVersion: PROSPECT_INBOUND_REPLY_CONTENT_CONTRACT_VERSION,
    reviewId: input.reviewId,
    workspaceId: input.workspaceId,
    providerEventId: input.providerEventId,
    inboundMessageId: input.content.inboundMessageId,
    replyReviewPayloadHash: input.replyReviewPayloadHash,
    retrievalRequestHash:
      hashProspectInboundReplyContentRequest(request),
    sender: input.content.sender,
    replyToAddress: input.content.replyToAddress,
    subject: input.content.subject,
    providerCreatedAt: input.content.providerCreatedAt,
    plainText: input.content.plainText,
    contentHash: input.content.contentHash,
    contentBytes: input.content.contentBytes,
    retrievedBy: input.retrievedBy,
    retrievedAt: new Date(input.retrievedAt).toISOString(),
    providerReadPerformed: true,
    contactAuthorized: false,
    sendAuthorized: false,
    htmlStored: false,
    attachmentsFetched: false,
  });
}
