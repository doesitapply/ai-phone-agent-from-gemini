import crypto from "crypto";
import type { Express, Request, RequestHandler, Response } from "express";

const APPROVAL_STATES = new Set(["PREPARED", "APPROVED", "SENDING", "SENT", "FAILED", "REJECTED", "EXPIRED"]);
const CALLBACK_ACTIONS = new Set(["approve", "reject", "preview"]);

export type TelegramApprovalAction = "approve" | "reject" | "preview";

export type ParsedTelegramCallback = {
  action: TelegramApprovalAction;
  approvalId: string;
};

type TelegramApprovalDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
};

const cleanCsvInts = (value: string | undefined): Set<number> => {
  return new Set(
    String(value || "")
      .split(",")
      .map((v) => Number.parseInt(v.trim(), 10))
      .filter((v) => Number.isSafeInteger(v))
  );
};

export function safePayloadHash(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex");
}

export function validateTelegramSecretHeader(headers: Record<string, unknown>, expectedSecret: string): boolean {
  const expected = String(expectedSecret || "").trim();
  const actual = String(headers["x-telegram-bot-api-secret-token"] || "").trim();
  if (!expected || !actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseTelegramCallbackData(raw: unknown): ParsedTelegramCallback | null {
  const text = String(raw || "").trim();
  const match = text.match(/^(approve|reject|preview):([a-zA-Z0-9_-]{16,96})$/);
  if (!match) return null;
  const action = match[1] as TelegramApprovalAction;
  if (!CALLBACK_ACTIONS.has(action)) return null;
  return { action, approvalId: match[2] };
}

export function isAllowedTelegramActor(userId: unknown, chatId: unknown, allowedUsers: Set<number>, allowedChats: Set<number>): boolean {
  const user = Number(userId);
  const chat = Number(chatId);
  if (!Number.isSafeInteger(user) || !Number.isSafeInteger(chat)) return false;
  return allowedUsers.has(user) && allowedChats.has(chat);
}

const telegramEditMessage = (chatId: number, messageId: number, text: string) => ({
  method: "editMessageText",
  chat_id: chatId,
  message_id: messageId,
  text,
});

async function recordApprovalAudit(sql: any, input: {
  approvalId: string;
  action: string;
  statusBefore: string | null;
  statusAfter: string | null;
  actorUserId: number;
  chatId: number;
  payloadHash: string;
  metadata?: Record<string, unknown>;
}) {
  await sql`
    INSERT INTO telegram_approval_audit (
      approval_id,
      action,
      status_before,
      status_after,
      actor_user_id,
      chat_id,
      payload_hash,
      metadata
    ) VALUES (
      ${input.approvalId},
      ${input.action},
      ${input.statusBefore},
      ${input.statusAfter},
      ${input.actorUserId},
      ${input.chatId},
      ${input.payloadHash},
      ${JSON.stringify(input.metadata || {})}
    )
  `;
}

export async function applyTelegramApproval(sql: any, args: {
  action: TelegramApprovalAction;
  approvalId: string;
  actorUserId: number;
  chatId: number;
  payloadHash: string;
  payload: unknown;
}): Promise<{ ok: boolean; status: number; message: string; row?: any }> {
  const now = new Date().toISOString();

  const existingRows = await sql`
    SELECT approval_id, target_id, intended_action, status, expires_at
    FROM telegram_approval_requests
    WHERE approval_id = ${args.approvalId}
    LIMIT 1
  `;
  const existing = existingRows?.[0];
  if (!existing) {
    await recordApprovalAudit(sql, {
      approvalId: args.approvalId,
      action: args.action,
      statusBefore: null,
      statusAfter: null,
      actorUserId: args.actorUserId,
      chatId: args.chatId,
      payloadHash: args.payloadHash,
      metadata: { outcome: "missing_approval" },
    });
    return { ok: false, status: 404, message: "Approval not found." };
  }

  if (!APPROVAL_STATES.has(String(existing.status))) {
    return { ok: false, status: 409, message: "Approval has invalid state." };
  }

  if (args.action === "preview") {
    await recordApprovalAudit(sql, {
      approvalId: args.approvalId,
      action: "preview",
      statusBefore: String(existing.status),
      statusAfter: String(existing.status),
      actorUserId: args.actorUserId,
      chatId: args.chatId,
      payloadHash: args.payloadHash,
      metadata: { target_id: existing.target_id, intended_action: existing.intended_action },
    });
    return {
      ok: true,
      status: 200,
      message: `Preview only: ${existing.intended_action} for approval ${args.approvalId}. No send/deploy executed.`,
      row: existing,
    };
  }

  if (String(existing.status) !== "PREPARED") {
    await recordApprovalAudit(sql, {
      approvalId: args.approvalId,
      action: args.action,
      statusBefore: String(existing.status),
      statusAfter: String(existing.status),
      actorUserId: args.actorUserId,
      chatId: args.chatId,
      payloadHash: args.payloadHash,
      metadata: { outcome: "replay_or_non_prepared" },
    });
    return { ok: false, status: 409, message: `Approval is ${existing.status}; no state changed.` };
  }

  const nextStatus = args.action === "approve" ? "APPROVED" : "REJECTED";
  const column = args.action === "approve" ? "approved_at" : "rejected_at";
  const updateRows = await sql.unsafe(
    `UPDATE telegram_approval_requests
     SET status = $1,
         ${column} = NOW(),
         actor_user_id = $2,
         chat_id = $3,
         original_payload_hash = $4,
         raw_telegram_payload = $5::jsonb,
         updated_at = NOW()
     WHERE approval_id = $6
       AND status = 'PREPARED'
       AND expires_at > NOW()
     RETURNING approval_id, target_id, intended_action, status`,
    [nextStatus, args.actorUserId, args.chatId, args.payloadHash, JSON.stringify(args.payload || {}), args.approvalId]
  );

  const changed = updateRows?.[0];
  if (!changed) {
    await recordApprovalAudit(sql, {
      approvalId: args.approvalId,
      action: args.action,
      statusBefore: String(existing.status),
      statusAfter: String(existing.status),
      actorUserId: args.actorUserId,
      chatId: args.chatId,
      payloadHash: args.payloadHash,
      metadata: { outcome: "expired_or_concurrent_update" },
    });
    return { ok: false, status: 409, message: "Approval was not changed; it may be expired or already used." };
  }

  await recordApprovalAudit(sql, {
    approvalId: args.approvalId,
    action: args.action,
    statusBefore: String(existing.status),
    statusAfter: nextStatus,
    actorUserId: args.actorUserId,
    chatId: args.chatId,
    payloadHash: args.payloadHash,
    metadata: { target_id: changed.target_id, intended_action: changed.intended_action },
  });

  return {
    ok: true,
    status: 200,
    message: `${nextStatus}: ${changed.intended_action} for ${changed.target_id}. No delivery has been sent yet.`,
    row: changed,
  };
}

export function registerTelegramApprovalRoutes(app: Express, deps: TelegramApprovalDeps): void {
  const { dashboardAuth, requireOperator, sql, dbEnabled, log } = deps;

  app.post("/api/launch/telegram-approvals/fake-target", dashboardAuth, requireOperator, async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });
    const approvalId = `fake_${crypto.randomBytes(18).toString("base64url")}`;
    try {
      const [row] = await sql`
        INSERT INTO telegram_approval_requests (
          approval_id,
          target_id,
          intended_action,
          status,
          expires_at
        ) VALUES (
          ${approvalId},
          ${"fake-target-do-not-send"},
          ${"HARmless_APPROVAL_PATH_TEST_ONLY"},
          ${"PREPARED"},
          NOW() + INTERVAL '30 minutes'
        )
        RETURNING approval_id, target_id, intended_action, status, expires_at
      `;
      return res.status(201).json({ ok: true, row, callback_data: `approve:${approvalId}` });
    } catch (err: any) {
      log("error", "Fake Telegram approval seed failed", { error: err?.message });
      return res.status(500).json({ ok: false, error: "Fake approval seed failed" });
    }
  });

  app.post("/telegram-webhook", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
    if (!validateTelegramSecretHeader(req.headers as Record<string, unknown>, expectedSecret)) {
      return res.status(403).json({ ok: false, error: "Invalid Telegram secret header" });
    }
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });

    const callbackQuery = (req.body as any)?.callback_query;
    if (!callbackQuery) return res.status(200).json({ ok: true, ignored: true });

    const actorUserId = Number(callbackQuery?.from?.id);
    const chatId = Number(callbackQuery?.message?.chat?.id);
    const messageId = Number(callbackQuery?.message?.message_id);
    const allowedUsers = cleanCsvInts(process.env.TELEGRAM_ALLOWED_USER_IDS);
    const allowedChats = cleanCsvInts(process.env.TELEGRAM_ALLOWED_CHAT_IDS);

    if (!isAllowedTelegramActor(actorUserId, chatId, allowedUsers, allowedChats)) {
      log("warn", "Rejected Telegram approval from non-allowlisted actor", { actorUserId, chatId });
      return res.status(403).json({ ok: false, error: "Telegram actor not allowed" });
    }

    const parsed = parseTelegramCallbackData(callbackQuery.data);
    if (!parsed || !Number.isSafeInteger(messageId)) {
      return res.status(400).json({ ok: false, error: "Malformed callback data" });
    }

    const payloadHash = safePayloadHash(req.body);
    try {
      const result = await applyTelegramApproval(sql, {
        action: parsed.action,
        approvalId: parsed.approvalId,
        actorUserId,
        chatId,
        payloadHash,
        payload: req.body,
      });
      if (!result.ok) {
        return res.status(result.status).json(telegramEditMessage(chatId, messageId, `⚠️ ${result.message}`));
      }
      return res.status(200).json(telegramEditMessage(chatId, messageId, `✅ ${result.message}`));
    } catch (err: any) {
      log("error", "Telegram approval webhook failed", { error: err?.message, approvalAction: parsed.action });
      return res.status(500).json(telegramEditMessage(chatId, messageId, "❌ Approval handler failed before any delivery was attempted."));
    }
  });
}
