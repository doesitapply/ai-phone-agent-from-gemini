import assert from "node:assert/strict";
import {
  applyTelegramApproval,
  isAllowedTelegramActor,
  parseTelegramCallbackData,
  safePayloadHash,
  validateTelegramSecretHeader,
} from "../src/routes/telegram-approval-routes.js";

const makeSql = ({ existing = null, updated = null, fail = false } = {}) => {
  const auditRows = [];
  const sql = async (strings, ..._values) => {
    if (fail) throw new Error("simulated db failure");
    const text = Array.isArray(strings) ? strings.join("?") : String(strings);
    if (text.includes("SELECT approval_id") && text.includes("FROM telegram_approval_requests")) {
      return existing ? [existing] : [];
    }
    if (text.includes("INSERT INTO telegram_approval_audit")) {
      auditRows.push({ ok: true });
      return [];
    }
    return [];
  };
  sql.unsafe = async (text, _values) => {
    if (fail) throw new Error("simulated db failure");
    if (String(text).includes("UPDATE telegram_approval_requests")) {
      return updated ? [updated] : [];
    }
    return [];
  };
  sql.auditRows = auditRows;
  return sql;
};

const prepared = {
  approval_id: "abc1234567890abc",
  target_id: "fake-target-do-not-send",
  intended_action: "HARmless_APPROVAL_PATH_TEST_ONLY",
  status: "PREPARED",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
};

const approved = { ...prepared, status: "APPROVED" };
const payload = { callback_query: { data: "approve:abc1234567890abc" } };
const payloadHash = safePayloadHash(payload);

assert.equal(validateTelegramSecretHeader({ "x-telegram-bot-api-secret-token": "secret" }, "secret"), true, "valid Telegram secret should pass");
assert.equal(validateTelegramSecretHeader({ "x-telegram-bot-api-secret-token": "bad" }, "secret"), false, "forged Telegram secret should fail");
assert.equal(isAllowedTelegramActor(111, 222, new Set([111]), new Set([222])), true, "allowlisted user/chat should pass");
assert.equal(isAllowedTelegramActor(999, 222, new Set([111]), new Set([222])), false, "non-allowlisted user should fail");
assert.deepEqual(parseTelegramCallbackData("approve:abc1234567890abc"), { action: "approve", approvalId: "abc1234567890abc" }, "valid callback should parse");
assert.equal(parseTelegramCallbackData("approve:any-target"), null, "public target-ish callback should fail opaque-id parser");
assert.equal(parseTelegramCallbackData("approve"), null, "malformed callback should fail safely");

let result = await applyTelegramApproval(makeSql({ existing: null }), {
  action: "approve",
  approvalId: "abc1234567890abc",
  actorUserId: 111,
  chatId: 222,
  payloadHash,
  payload,
});
assert.equal(result.status, 404, "missing approval should return 404");

result = await applyTelegramApproval(makeSql({ existing: { ...prepared, status: "APPROVED" } }), {
  action: "approve",
  approvalId: "abc1234567890abc",
  actorUserId: 111,
  chatId: 222,
  payloadHash,
  payload,
});
assert.equal(result.status, 409, "replayed/non-PREPARED approval should return 409");

result = await applyTelegramApproval(makeSql({ existing: prepared, updated: approved }), {
  action: "approve",
  approvalId: "abc1234567890abc",
  actorUserId: 111,
  chatId: 222,
  payloadHash,
  payload,
});
assert.equal(result.ok, true, "prepared approval should update once");
assert.equal(result.row.status, "APPROVED", "approved row should be returned");
assert.match(result.message, /No delivery has been sent yet/, "approval must not claim delivery");

result = await applyTelegramApproval(makeSql({ existing: prepared, updated: null }), {
  action: "approve",
  approvalId: "abc1234567890abc",
  actorUserId: 111,
  chatId: 222,
  payloadHash,
  payload,
});
assert.equal(result.status, 409, "expired/concurrent update with no changed row should return 409");

result = await applyTelegramApproval(makeSql({ existing: prepared }), {
  action: "preview",
  approvalId: "abc1234567890abc",
  actorUserId: 111,
  chatId: 222,
  payloadHash,
  payload,
});
assert.equal(result.ok, true, "preview should succeed");
assert.equal(result.row.status, "PREPARED", "preview must not change status");

await assert.rejects(
  () => applyTelegramApproval(makeSql({ fail: true }), {
    action: "approve",
    approvalId: "abc1234567890abc",
    actorUserId: 111,
    chatId: 222,
    payloadHash,
    payload,
  }),
  /simulated db failure/,
  "database failure should surface as failure for route to report"
);

console.log("Telegram approval webhook contract checks passed");
