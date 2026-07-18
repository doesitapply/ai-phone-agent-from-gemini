import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const approvalStatuses = [
  "PREPARED",
  "APPROVED",
  "SENDING",
  "SENT",
  "FAILED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
] as const;

export type LaunchApprovalStatus = (typeof approvalStatuses)[number];
export type TelegramApprovalAction = "preview" | "approve" | "reject" | "expire" | "cancel";

const callbackActions = new Set<TelegramApprovalAction>(["preview", "approve", "reject", "expire", "cancel"]);
const opaqueApprovalIdPattern = /^[A-Za-z0-9_-]{24,48}$/;
const callbackPrefix = "smirk_launch";

export type LaunchApprovalRecord = {
  approvalId: string;
  status: LaunchApprovalStatus;
  actionType: string;
  targetKind: string;
  targetRef: string | null;
  channel: string;
  preparedPayload: Record<string, unknown>;
  payloadHash: string;
  intendedAction: string | null;
  expiresAt: string;
};

export type TelegramApprovalActor = {
  userId: string;
  chatId: string;
  callbackQueryId: string | null;
  updateId: string | null;
};

export type ParsedTelegramApprovalCallback = {
  action: TelegramApprovalAction;
  approvalId: string;
  actor: TelegramApprovalActor;
  rawCallback: Record<string, unknown>;
};

export type LaunchApprovalStore = {
  getApproval(approvalId: string): Promise<LaunchApprovalRecord | null>;
  transitionApproval(input: {
    approvalId: string;
    allowedStatuses: LaunchApprovalStatus[];
    nextStatus: LaunchApprovalStatus;
    actor: TelegramApprovalActor;
    intendedAction: TelegramApprovalAction;
    requireUnexpired?: boolean;
  }): Promise<LaunchApprovalRecord | null>;
  recordAudit(input: {
    approvalId: string;
    action: TelegramApprovalAction;
    actor: TelegramApprovalActor;
    payloadHash: string | null;
    intendedAction: string | null;
    outcome: "success" | "failed";
    reason: string;
    statusBefore?: string | null;
    statusAfter?: string | null;
    rawCallback: Record<string, unknown>;
  }): Promise<void>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const cleanString = (value: unknown, max = 240): string | null => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.slice(0, max);
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const input = value as Record<string, unknown>;
  return `{${Object.keys(input)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(input[key])}`)
    .join(",")}}`;
};

export function createOpaqueApprovalId(): string {
  return randomBytes(24).toString("base64url");
}

export function buildApprovalPayloadHash(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload ?? {})).digest("hex");
}

export function buildTelegramApprovalCallbackData(action: TelegramApprovalAction, approvalId: string): string {
  if (!callbackActions.has(action)) throw new Error("Unsupported approval action.");
  if (!opaqueApprovalIdPattern.test(approvalId)) throw new Error("Approval id must be opaque.");
  return `${callbackPrefix}:${action}:${approvalId}`;
}

export function parseTelegramCallbackData(value: unknown):
  | { ok: true; action: TelegramApprovalAction; approvalId: string }
  | { ok: false; error: string } {
  const data = cleanString(value, 128);
  if (!data || data.length > 64) return { ok: false, error: "malformed-callback-data" };
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== callbackPrefix) return { ok: false, error: "malformed-callback-data" };
  const action = parts[1] as TelegramApprovalAction;
  const approvalId = parts[2];
  if (!callbackActions.has(action)) return { ok: false, error: "unsupported-callback-action" };
  if (!opaqueApprovalIdPattern.test(approvalId)) return { ok: false, error: "non-opaque-approval-id" };
  return { ok: true, action, approvalId };
}

export function extractTelegramApprovalCallback(body: unknown):
  | { ok: true; callback: ParsedTelegramApprovalCallback }
  | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: "invalid-telegram-update" };
  const callbackQuery = body.callback_query;
  if (!isObject(callbackQuery)) return { ok: false, error: "missing-callback-query" };
  const from = isObject(callbackQuery.from) ? callbackQuery.from : null;
  const message = isObject(callbackQuery.message) ? callbackQuery.message : null;
  const chat = message && isObject(message.chat) ? message.chat : null;
  const userId = cleanString(from?.id, 64);
  const chatId = cleanString(chat?.id, 64);
  if (!userId) return { ok: false, error: "missing-telegram-user-id" };
  if (!chatId) return { ok: false, error: "missing-telegram-chat-id" };

  const parsed = parseTelegramCallbackData(callbackQuery.data);
  if (parsed.ok === false) return { ok: false, error: parsed.error };

  return {
    ok: true,
    callback: {
      action: parsed.action,
      approvalId: parsed.approvalId,
      actor: {
        userId,
        chatId,
        callbackQueryId: cleanString(callbackQuery.id, 160),
        updateId: cleanString(body.update_id, 80),
      },
      rawCallback: {
        update_id: body.update_id ?? null,
        callback_query_id: callbackQuery.id ?? null,
        data: callbackQuery.data ?? null,
      },
    },
  };
}

export function parseCsvAllowlist(raw: unknown): Set<string> {
  return new Set(String(raw || "").split(",").map((item) => item.trim()).filter(Boolean));
}

export function isTelegramActorAllowed(input: {
  actor: TelegramApprovalActor;
  allowedUserIds: string | undefined;
  allowedChatIds: string | undefined;
}): { ok: boolean; userAllowed: boolean; chatAllowed: boolean } {
  const users = parseCsvAllowlist(input.allowedUserIds);
  const chats = parseCsvAllowlist(input.allowedChatIds);
  const userAllowed = users.size > 0 && users.has(input.actor.userId);
  const chatAllowed = chats.size > 0 && chats.has(input.actor.chatId);
  return { ok: userAllowed && chatAllowed, userAllowed, chatAllowed };
}

export function timingSafeStringEquals(provided: unknown, expected: unknown): boolean {
  const left = String(provided || "");
  const right = String(expected || "");
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export function telegramWebhookSecretMatches(input: { provided: unknown; expected: unknown }): boolean {
  return timingSafeStringEquals(input.provided, input.expected);
}

const isExpired = (record: LaunchApprovalRecord, now: Date): boolean => {
  const expiresAt = new Date(record.expiresAt);
  return Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime();
};

const safePreviewPayload = (record: LaunchApprovalRecord): Record<string, unknown> => {
  const payload = isObject(record.preparedPayload) ? record.preparedPayload : {};
  return {
    preview_text: cleanString(payload.preview_text, 1200),
    subject: cleanString(payload.subject, 180),
    company: cleanString(payload.company, 180),
  };
};

export async function processTelegramApprovalAction(input: {
  store: LaunchApprovalStore;
  callback: ParsedTelegramApprovalCallback;
  now?: Date;
}): Promise<{
  ok: boolean;
  httpStatus: number;
  code: string;
  approval_id: string;
  action: TelegramApprovalAction;
  status?: LaunchApprovalStatus;
  delivery_status?: "not_started" | "not_sent";
  message: string;
  preview?: Record<string, unknown>;
}> {
  const now = input.now ?? new Date();
  const { store, callback } = input;

  const audit = async (
    outcome: "success" | "failed",
    reason: string,
    record: LaunchApprovalRecord | null,
    statusAfter?: string | null,
  ) => store.recordAudit({
    approvalId: callback.approvalId,
    action: callback.action,
    actor: callback.actor,
    payloadHash: record?.payloadHash || null,
    intendedAction: callback.action,
    outcome,
    reason,
    statusBefore: record?.status || null,
    statusAfter: statusAfter || record?.status || null,
    rawCallback: callback.rawCallback,
  });

  if (callback.action === "preview") {
    const record = await store.getApproval(callback.approvalId);
    if (!record) {
      await audit("failed", "approval-row-missing", null, null);
      return {
        ok: false,
        httpStatus: 404,
        code: "approval-row-missing",
        approval_id: callback.approvalId,
        action: callback.action,
        message: "No matching approval row exists.",
      };
    }
    await audit("success", "preview-only", record, record.status);
    return {
      ok: true,
      httpStatus: 200,
      code: "approval-preview",
      approval_id: callback.approvalId,
      action: callback.action,
      status: record.status,
      delivery_status: "not_started",
      message: "Preview only. No approval, delivery, or ledger touch was performed.",
      preview: {
        target_kind: record.targetKind,
        channel: record.channel,
        action_type: record.actionType,
        payload_hash: record.payloadHash,
        expires_at: record.expiresAt,
        ...safePreviewPayload(record),
      },
    };
  }

  const targetStatus: Record<Exclude<TelegramApprovalAction, "preview">, LaunchApprovalStatus> = {
    approve: "APPROVED",
    reject: "REJECTED",
    expire: "EXPIRED",
    cancel: "CANCELLED",
  };
  const allowedBefore: Record<Exclude<TelegramApprovalAction, "preview">, LaunchApprovalStatus[]> = {
    approve: ["PREPARED"],
    reject: ["PREPARED"],
    expire: ["PREPARED", "APPROVED"],
    cancel: ["PREPARED", "APPROVED"],
  };

  const nextStatus = targetStatus[callback.action];
  const updated = await store.transitionApproval({
    approvalId: callback.approvalId,
    allowedStatuses: allowedBefore[callback.action],
    nextStatus,
    actor: callback.actor,
    intendedAction: callback.action,
    requireUnexpired: callback.action === "approve",
  });

  if (updated) {
    const reason = callback.action === "approve"
      ? "approved-without-delivery"
      : `${callback.action}ed-without-delivery`;
    await audit("success", reason, updated, updated.status);
    return {
      ok: true,
      httpStatus: 200,
      code: reason,
      approval_id: callback.approvalId,
      action: callback.action,
      status: updated.status,
      delivery_status: "not_sent",
      message: callback.action === "approve"
        ? "Approved for sending. Delivery has not started and no outreach was sent."
        : "Approval state changed. Delivery has not started and no outreach was sent.",
    };
  }

  const existing = await store.getApproval(callback.approvalId);
  if (!existing) {
    await audit("failed", "approval-row-missing", null, null);
    return {
      ok: false,
      httpStatus: 404,
      code: "approval-row-missing",
      approval_id: callback.approvalId,
      action: callback.action,
      message: "No matching approval row exists.",
    };
  }

  if (callback.action === "approve" && existing.status === "PREPARED" && isExpired(existing, now)) {
    const expired = await store.transitionApproval({
      approvalId: callback.approvalId,
      allowedStatuses: ["PREPARED"],
      nextStatus: "EXPIRED",
      actor: callback.actor,
      intendedAction: "expire",
    });
    await audit("failed", "approval-expired", existing, expired?.status || existing.status);
    return {
      ok: false,
      httpStatus: 409,
      code: "approval-expired",
      approval_id: callback.approvalId,
      action: callback.action,
      status: expired?.status || existing.status,
      message: "Approval expired before it could be approved. No delivery was started.",
    };
  }

  await audit("failed", "approval-not-in-expected-state", existing, existing.status);
  return {
    ok: false,
    httpStatus: 409,
    code: "approval-not-in-expected-state",
    approval_id: callback.approvalId,
    action: callback.action,
    status: existing.status,
    message: "Approval was already used, cancelled, rejected, sent, or failed. No delivery was started.",
  };
}
