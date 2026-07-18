import type { Express, Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  buildApprovalPayloadHash,
  buildTelegramApprovalCallbackData,
  createOpaqueApprovalId,
  extractTelegramApprovalCallback,
  isTelegramActorAllowed,
  processTelegramApprovalAction,
  telegramWebhookSecretMatches,
  type LaunchApprovalRecord,
  type LaunchApprovalStatus,
  type LaunchApprovalStore,
  type TelegramApprovalAction,
} from "../launch-approval.js";

type TelegramApprovalRouteDeps = {
  dashboardAuth: RequestHandler;
  requireOperator: RequestHandler;
  sql: any;
  dbEnabled: boolean;
  log: (level: string, message: string, meta?: Record<string, unknown>) => void;
};

const telegramWebhookRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { ok: false, error: "Too many Telegram approval callbacks. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

const prepareApprovalSchema = z.object({
  target_kind: z.enum(["fake_target", "launch_outreach_draft"]).default("fake_target"),
  target_ref: z.string().trim().max(120).optional(),
  action_type: z.enum(["manual_send_test", "outreach_email_review"]).default("manual_send_test"),
  channel: z.enum(["none", "email", "website_form", "linkedin", "phone"]).default("none"),
  expires_in_minutes: z.coerce.number().int().min(1).max(1440).default(30),
  prepared_payload: z.record(z.string(), z.unknown()).default({}),
});

const cleanRow = (row: any): LaunchApprovalRecord => ({
  approvalId: String(row.approval_id),
  status: String(row.status) as LaunchApprovalStatus,
  actionType: String(row.action_type || ""),
  targetKind: String(row.target_kind || ""),
  targetRef: row.target_ref ? String(row.target_ref) : null,
  channel: String(row.channel || ""),
  preparedPayload: row.prepared_payload && typeof row.prepared_payload === "object" ? row.prepared_payload : {},
  payloadHash: String(row.payload_hash || ""),
  intendedAction: row.intended_action ? String(row.intended_action) : null,
  expiresAt: new Date(row.expires_at).toISOString(),
});

function createPostgresLaunchApprovalStore(sql: any): LaunchApprovalStore & {
  prepareApproval(input: {
    targetKind: string;
    targetRef?: string | null;
    actionType: string;
    channel: string;
    preparedPayload: Record<string, unknown>;
    expiresAt: string;
    preparedBy: string;
  }): Promise<LaunchApprovalRecord>;
} {
  return {
    async prepareApproval(input) {
      const approvalId = createOpaqueApprovalId();
      const payloadHash = buildApprovalPayloadHash(input.preparedPayload);
      const [row] = await sql`
        INSERT INTO launch_outreach_approvals (
          approval_id,
          action_type,
          target_kind,
          target_ref,
          channel,
          status,
          prepared_payload,
          payload_hash,
          prepared_by,
          expires_at
        ) VALUES (
          ${approvalId},
          ${input.actionType},
          ${input.targetKind},
          ${input.targetRef || null},
          ${input.channel},
          ${"PREPARED"},
          ${sql.json(input.preparedPayload)},
          ${payloadHash},
          ${input.preparedBy},
          ${input.expiresAt}
        )
        RETURNING *
      `;
      return cleanRow(row);
    },

    async getApproval(approvalId) {
      const [row] = await sql`
        SELECT *
        FROM launch_outreach_approvals
        WHERE approval_id = ${approvalId}
        LIMIT 1
      `;
      return row ? cleanRow(row) : null;
    },

    async transitionApproval(input) {
      const actorUserId = input.actor.userId;
      const actorChatId = input.actor.chatId;
      const callbackQueryId = input.actor.callbackQueryId;
      const updateId = input.actor.updateId;
      const [row] = await sql`
        UPDATE launch_outreach_approvals
        SET
          status = ${input.nextStatus},
          intended_action = ${input.intendedAction},
          approved_at = CASE WHEN ${input.nextStatus === "APPROVED"} THEN NOW() ELSE approved_at END,
          approved_by_telegram_user_id = CASE WHEN ${input.nextStatus === "APPROVED"} THEN ${actorUserId} ELSE approved_by_telegram_user_id END,
          approved_chat_id = CASE WHEN ${input.nextStatus === "APPROVED"} THEN ${actorChatId} ELSE approved_chat_id END,
          approved_payload_hash = CASE WHEN ${input.nextStatus === "APPROVED"} THEN payload_hash ELSE approved_payload_hash END,
          rejected_at = CASE WHEN ${input.nextStatus === "REJECTED"} THEN NOW() ELSE rejected_at END,
          cancelled_at = CASE WHEN ${input.nextStatus === "CANCELLED"} THEN NOW() ELSE cancelled_at END,
          expired_at = CASE WHEN ${input.nextStatus === "EXPIRED"} THEN NOW() ELSE expired_at END,
          used_at = COALESCE(used_at, NOW()),
          last_callback_query_id = ${callbackQueryId},
          last_telegram_update_id = ${updateId},
          updated_at = NOW()
        WHERE approval_id = ${input.approvalId}
          AND status = ANY(${sql.array(input.allowedStatuses)})
          AND (${!input.requireUnexpired} OR expires_at > NOW())
        RETURNING *
      `;
      return row ? cleanRow(row) : null;
    },

    async recordAudit(input) {
      await sql`
        INSERT INTO launch_outreach_approval_audit (
          approval_id,
          action,
          actor_telegram_user_id,
          actor_chat_id,
          callback_query_id,
          telegram_update_id,
          payload_hash,
          intended_action,
          outcome,
          reason,
          status_before,
          status_after,
          raw_callback
        ) VALUES (
          ${input.approvalId},
          ${input.action},
          ${input.actor.userId},
          ${input.actor.chatId},
          ${input.actor.callbackQueryId},
          ${input.actor.updateId},
          ${input.payloadHash},
          ${input.intendedAction},
          ${input.outcome},
          ${input.reason},
          ${input.statusBefore || null},
          ${input.statusAfter || null},
          ${sql.json(input.rawCallback)}
        )
      `;
    },
  };
}

const callbackControls = (approvalId: string): Record<TelegramApprovalAction, string> => ({
  preview: buildTelegramApprovalCallbackData("preview", approvalId),
  approve: buildTelegramApprovalCallbackData("approve", approvalId),
  reject: buildTelegramApprovalCallbackData("reject", approvalId),
  expire: buildTelegramApprovalCallbackData("expire", approvalId),
  cancel: buildTelegramApprovalCallbackData("cancel", approvalId),
});

export function registerTelegramApprovalRoutes(app: Express, deps: TelegramApprovalRouteDeps): void {
  const { dashboardAuth, requireOperator, sql, dbEnabled, log } = deps;
  const store = createPostgresLaunchApprovalStore(sql);
  const telegramWebhookSecretGuard: RequestHandler = (req: Request, res: Response, next) => {
    const expectedSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
    if (!expectedSecret) return res.status(503).json({ ok: false, error: "Telegram approval webhook is not configured" });
    if (!telegramWebhookSecretMatches({
      provided: req.get("x-telegram-bot-api-secret-token"),
      expected: expectedSecret,
    })) {
      log("warn", "Rejected Telegram approval callback with invalid secret header", { requestId: (req as any).requestId });
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    next();
  };

  app.post("/api/launch/approvals/prepare", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });

    const parsed = prepareApprovalSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "Invalid approval payload", issues: parsed.error.issues.map((issue) => issue.message) });
    }
    const input = parsed.data;
    if (input.target_kind !== "fake_target" && process.env.ENABLE_REAL_LAUNCH_APPROVALS !== "true") {
      return res.status(409).json({
        ok: false,
        error: "Real launch approvals are disabled until the fake-target test passes and sending is explicitly approved.",
      });
    }

    try {
      const expiresAt = new Date(Date.now() + input.expires_in_minutes * 60_000).toISOString();
      const approval = await store.prepareApproval({
        targetKind: input.target_kind,
        targetRef: input.target_ref || null,
        actionType: input.action_type,
        channel: input.channel,
        preparedPayload: input.prepared_payload,
        expiresAt,
        preparedBy: "operator",
      });
      return res.status(201).json({
        ok: true,
        approval,
        controls: callbackControls(approval.approvalId),
        note: "Prepared only. No outreach, SMS, calls, paid spend, or delivery was triggered.",
      });
    } catch (err: any) {
      log("error", "Launch approval prepare failed", { error: err?.message });
      return res.status(500).json({ ok: false, error: "Launch approval prepare failed" });
    }
  });

  app.get("/api/launch/approvals/:approvalId", dashboardAuth, requireOperator, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });
    const approvalId = String(req.params.approvalId || "").trim();
    if (!/^[A-Za-z0-9_-]{24,48}$/.test(approvalId)) return res.status(400).json({ ok: false, error: "Invalid approval id" });

    try {
      const approval = await store.getApproval(approvalId);
      if (!approval) return res.status(404).json({ ok: false, error: "Approval not found" });
      return res.json({ ok: true, approval, controls: callbackControls(approval.approvalId) });
    } catch (err: any) {
      log("error", "Launch approval lookup failed", { error: err?.message });
      return res.status(500).json({ ok: false, error: "Launch approval lookup failed" });
    }
  });

  app.post("/api/launch/telegram-approval/webhook", telegramWebhookSecretGuard, telegramWebhookRateLimit, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "Database is disabled" });

    const parsed = extractTelegramApprovalCallback(req.body);
    if (parsed.ok === false) return res.status(400).json({ ok: false, error: parsed.error });

    const allowed = isTelegramActorAllowed({
      actor: parsed.callback.actor,
      allowedUserIds: process.env.TELEGRAM_ALLOWED_USER_IDS,
      allowedChatIds: process.env.TELEGRAM_ALLOWED_CHAT_IDS,
    });
    if (!allowed.ok) {
      log("warn", "Rejected Telegram approval callback from non-allowlisted actor", {
        requestId: (req as any).requestId,
        userAllowed: allowed.userAllowed,
        chatAllowed: allowed.chatAllowed,
      });
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    try {
      const result = await processTelegramApprovalAction({ store, callback: parsed.callback });
      return res.status(result.httpStatus).json(result);
    } catch (err: any) {
      log("error", "Telegram approval callback failed", { error: err?.message });
      return res.status(500).json({ ok: false, error: "Telegram approval callback failed" });
    }
  });
}
