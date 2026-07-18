#!/usr/bin/env tsx
import assert from "node:assert/strict";
import {
  buildApprovalPayloadHash,
  buildTelegramApprovalCallbackData,
  extractTelegramApprovalCallback,
  isTelegramActorAllowed,
  parseTelegramCallbackData,
  processTelegramApprovalAction,
  telegramWebhookSecretMatches,
  type LaunchApprovalRecord,
  type LaunchApprovalStatus,
  type LaunchApprovalStore,
  type TelegramApprovalActor,
} from "../src/launch-approval.ts";

const approvalId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const actor: TelegramApprovalActor = {
  userId: "111",
  chatId: "222",
  callbackQueryId: "callback-1",
  updateId: "9001",
};

function record(overrides: Partial<LaunchApprovalRecord> = {}): LaunchApprovalRecord {
  const preparedPayload = {
    company: "Fake Target Plumbing",
    subject: "Review only",
    preview_text: "Fake target only. No outreach should be sent.",
  };
  return {
    approvalId,
    status: "PREPARED",
    actionType: "manual_send_test",
    targetKind: "fake_target",
    targetRef: "fake-target-001",
    channel: "none",
    preparedPayload,
    payloadHash: buildApprovalPayloadHash(preparedPayload),
    intendedAction: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function memoryStore(rows: LaunchApprovalRecord[] = [record()]): LaunchApprovalStore & { rows: Map<string, LaunchApprovalRecord>; audits: any[] } {
  const byId = new Map(rows.map((row) => [row.approvalId, { ...row }]));
  const audits: any[] = [];
  return {
    rows: byId,
    audits,
    async getApproval(id) {
      const row = byId.get(id);
      return row ? { ...row } : null;
    },
    async transitionApproval(input) {
      const row = byId.get(input.approvalId);
      if (!row) return null;
      if (!input.allowedStatuses.includes(row.status)) return null;
      if (input.requireUnexpired && new Date(row.expiresAt).getTime() <= Date.now()) return null;
      const next = {
        ...row,
        status: input.nextStatus,
        intendedAction: input.intendedAction,
      };
      byId.set(input.approvalId, next);
      return { ...next };
    },
    async recordAudit(input) {
      audits.push(input);
    },
  };
}

function callback(action: "preview" | "approve" | "reject" | "expire" | "cancel", id = approvalId) {
  return {
    action,
    approvalId: id,
    actor,
    rawCallback: {
      update_id: 9001,
      callback_query_id: "callback-1",
      data: buildTelegramApprovalCallbackData(action, id),
    },
  };
}

function statusOf(store: ReturnType<typeof memoryStore>): LaunchApprovalStatus | undefined {
  return store.rows.get(approvalId)?.status;
}

assert.equal(telegramWebhookSecretMatches({ provided: "correct-secret", expected: "correct-secret" }), true);
assert.equal(telegramWebhookSecretMatches({ provided: "wrong-secret", expected: "correct-secret" }), false);
assert.equal(telegramWebhookSecretMatches({ provided: "", expected: "correct-secret" }), false);

assert.deepEqual(isTelegramActorAllowed({ actor, allowedUserIds: "111", allowedChatIds: "222" }), {
  ok: true,
  userAllowed: true,
  chatAllowed: true,
});
assert.equal(isTelegramActorAllowed({ actor, allowedUserIds: "999", allowedChatIds: "222" }).ok, false);
assert.equal(isTelegramActorAllowed({ actor, allowedUserIds: "111", allowedChatIds: "999" }).ok, false);
assert.equal(isTelegramActorAllowed({ actor, allowedUserIds: "", allowedChatIds: "222" }).ok, false);

for (const bad of [
  null,
  {},
  "",
  "approve:any-target",
  "smirk_launch:approve:12",
  "smirk_launch:approve:launch_ledger_123",
  "smirk_launch:send:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  `smirk_launch:approve:${"a".repeat(80)}`,
]) {
  const parsed = parseTelegramCallbackData(bad);
  assert.equal(parsed.ok, false, `expected malformed callback data to fail: ${String(bad)}`);
}

const parsedCallback = parseTelegramCallbackData(buildTelegramApprovalCallbackData("approve", approvalId));
assert.equal(parsedCallback.ok, true);
if (parsedCallback.ok) {
  assert.equal(parsedCallback.action, "approve");
  assert.equal(parsedCallback.approvalId, approvalId);
}

const extracted = extractTelegramApprovalCallback({
  update_id: 9001,
  callback_query: {
    id: "callback-1",
    from: { id: 111 },
    message: { chat: { id: 222 } },
    data: buildTelegramApprovalCallbackData("approve", approvalId),
  },
});
assert.equal(extracted.ok, true);

const malformedUpdate = extractTelegramApprovalCallback({ callback_query: { from: { id: 111 }, data: "bad" } });
assert.equal(malformedUpdate.ok, false);

const previewStore = memoryStore();
const preview = await processTelegramApprovalAction({ store: previewStore, callback: callback("preview") });
assert.equal(preview.ok, true);
assert.equal(statusOf(previewStore), "PREPARED");
assert.equal(preview.delivery_status, "not_started");

const approveStore = memoryStore();
const approved = await processTelegramApprovalAction({ store: approveStore, callback: callback("approve") });
assert.equal(approved.ok, true);
assert.equal(approved.status, "APPROVED");
assert.equal(approved.delivery_status, "not_sent");
assert.match(approved.message, /no outreach was sent/i);
assert.equal(statusOf(approveStore), "APPROVED");

const replayed = await processTelegramApprovalAction({ store: approveStore, callback: callback("approve") });
assert.equal(replayed.ok, false);
assert.equal(replayed.httpStatus, 409);
assert.equal(statusOf(approveStore), "APPROVED");

const missing = await processTelegramApprovalAction({ store: memoryStore([]), callback: callback("approve") });
assert.equal(missing.ok, false);
assert.equal(missing.httpStatus, 404);
assert.equal(missing.code, "approval-row-missing");

const expiredStore = memoryStore([record({ expiresAt: new Date(Date.now() - 60_000).toISOString() })]);
const expired = await processTelegramApprovalAction({ store: expiredStore, callback: callback("approve") });
assert.equal(expired.ok, false);
assert.equal(expired.httpStatus, 409);
assert.equal(statusOf(expiredStore), "EXPIRED");

const rejectStore = memoryStore();
const rejected = await processTelegramApprovalAction({ store: rejectStore, callback: callback("reject") });
assert.equal(rejected.ok, true);
assert.equal(statusOf(rejectStore), "REJECTED");

const failingStore: LaunchApprovalStore = {
  async getApproval() {
    throw new Error("database offline");
  },
  async transitionApproval() {
    throw new Error("database offline");
  },
  async recordAudit() {
    throw new Error("database offline");
  },
};
await assert.rejects(() => processTelegramApprovalAction({ store: failingStore, callback: callback("approve") }), /database offline/);

console.log("OK Telegram approval path rejects forged/malformed/replayed callbacks, handles missing rows and DB failures, and never sends outreach.");
