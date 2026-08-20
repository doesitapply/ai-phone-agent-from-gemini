import { createHash, timingSafeEqual } from "node:crypto";

export const WEBHOOK_BUFFER_REPLAY_CONTRACT =
  "smirk.webhook-buffer-replay.v2";
export const WEBHOOK_BUFFER_REPLAY_APPROVAL_PREFIX =
  "APPROVE_REPLAY_SMIRK_WEBHOOK_BUFFER";
export const WEBHOOK_BUFFER_REPLAY_MAX_ROWS = 20;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function exactStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function normalizePhone(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDirection(value) {
  const direction = String(value || "").trim().toLowerCase();
  return direction || "inbound";
}

function valuesConflict(values) {
  return new Set(values.filter((value) => value !== null)).size > 1;
}

export function normalizeWebhookBufferReplayIds(values) {
  const raw = Array.isArray(values) ? values : [];
  const parsed = raw.map((value) => Number(value));
  const valid = parsed.every((value) => Number.isInteger(value) && value > 0);
  const duplicate = new Set(parsed).size !== parsed.length;
  const tooMany = parsed.length > WEBHOOK_BUFFER_REPLAY_MAX_ROWS;
  return {
    ok: valid && !duplicate && !tooMany && parsed.length > 0,
    ids: valid ? [...parsed].sort((left, right) => left - right) : [],
    blockers: uniqueSorted([
      ...(parsed.length === 0 ? ["WEBHOOK_REPLAY_ROW_SELECTION_REQUIRED"] : []),
      ...(!valid ? ["WEBHOOK_REPLAY_ROW_ID_INVALID"] : []),
      ...(duplicate ? ["WEBHOOK_REPLAY_ROW_ID_DUPLICATE"] : []),
      ...(tooMany ? ["WEBHOOK_REPLAY_ROW_LIMIT_EXCEEDED"] : []),
    ]),
  };
}

function normalizeReplayRow(row, defaultWorkspaceId) {
  const blockers = [];
  const payload = row?.payload && typeof row.payload === "object" &&
    !Array.isArray(row.payload)
    ? row.payload
    : null;
  if (!payload) blockers.push("WEBHOOK_REPLAY_PAYLOAD_INVALID");

  const id = Number(row?.id);
  if (!Number.isInteger(id) || id <= 0) {
    blockers.push("WEBHOOK_REPLAY_ROW_ID_INVALID");
  }
  const callSid = String(row?.call_sid || payload?.CallSid || "").trim();
  if (!/^CA[a-f0-9]{32}$/i.test(callSid)) {
    blockers.push("WEBHOOK_REPLAY_CALL_SID_INVALID");
  }
  if (row?.call_sid && payload?.CallSid &&
    String(row.call_sid).trim() !== String(payload.CallSid).trim()) {
    blockers.push("WEBHOOK_REPLAY_CALL_SID_CONFLICT");
  }

  const webhookType = String(row?.webhook_type || "").trim();
  if (webhookType !== "twilio.incoming") {
    blockers.push("WEBHOOK_REPLAY_TYPE_NOT_INBOUND_CALL");
  }
  const processStatus = normalizeStatus(row?.process_status);
  if (!new Set(["received", "retry"]).has(processStatus)) {
    blockers.push("WEBHOOK_REPLAY_STATUS_NOT_REPLAYABLE");
  }

  const rowWorkspaceId = Number(row?.workspace_id || 0);
  const payloadWorkspaceId = Number(payload?.workspace_id || 0);
  const fallbackWorkspaceId = Number(defaultWorkspaceId || 0);
  const workspaceCandidates = [
    Number.isInteger(rowWorkspaceId) && rowWorkspaceId > 0
      ? rowWorkspaceId
      : null,
    Number.isInteger(payloadWorkspaceId) && payloadWorkspaceId > 0
      ? payloadWorkspaceId
      : null,
  ];
  if (valuesConflict(workspaceCandidates)) {
    blockers.push("WEBHOOK_REPLAY_WORKSPACE_CONFLICT");
  }
  const workspaceId = workspaceCandidates.find((value) => value !== null) ||
    (Number.isInteger(fallbackWorkspaceId) && fallbackWorkspaceId > 0
      ? fallbackWorkspaceId
      : null);
  if (!workspaceId) blockers.push("WEBHOOK_REPLAY_WORKSPACE_MISSING");

  const fromCandidates = [
    normalizePhone(row?.from_number),
    normalizePhone(payload?.From),
  ];
  const toCandidates = [
    normalizePhone(row?.to_number),
    normalizePhone(payload?.To),
  ];
  if (valuesConflict(fromCandidates)) blockers.push("WEBHOOK_REPLAY_FROM_CONFLICT");
  if (valuesConflict(toCandidates)) blockers.push("WEBHOOK_REPLAY_TO_CONFLICT");
  const fromNumber = fromCandidates.find(Boolean) || null;
  const toNumber = toCandidates.find(Boolean) || null;

  const directionCandidates = [
    row?.direction ? normalizeDirection(row.direction) : null,
    payload?.Direction ? normalizeDirection(payload.Direction) : null,
  ];
  if (valuesConflict(directionCandidates)) {
    blockers.push("WEBHOOK_REPLAY_DIRECTION_CONFLICT");
  }
  const direction = directionCandidates.find(Boolean) || "inbound";
  if (direction !== "inbound") {
    blockers.push("WEBHOOK_REPLAY_DIRECTION_NOT_INBOUND");
  }

  const receivedAt = normalizeTimestamp(row?.received_at);
  if (!receivedAt) blockers.push("WEBHOOK_REPLAY_RECEIVED_AT_INVALID");
  const payloadHash = payload ? sha256(payload) : null;
  const replayBinding = {
    id: Number.isInteger(id) && id > 0 ? id : null,
    callSid,
    webhookType,
    workspaceId,
    fromNumber,
    toNumber,
    direction,
    processStatus,
    receivedAt,
    payloadHash,
  };

  return {
    ...replayBinding,
    rowDigest: sha256(replayBinding),
    blockers: uniqueSorted(blockers),
  };
}

export function buildWebhookBufferReplayPlan({
  requestedIds,
  rows,
  defaultWorkspaceId = 0,
  runtimeCommit,
}) {
  const selection = normalizeWebhookBufferReplayIds(requestedIds);
  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeReplayRow(row, defaultWorkspaceId))
    .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  const actualIds = normalizedRows
    .map((row) => row.id)
    .filter((id) => Number.isInteger(id));
  const missingIds = selection.ids.filter((id) => !actualIds.includes(id));
  const unexpectedIds = actualIds.filter((id) => !selection.ids.includes(id));
  const workspaceIds = uniqueSorted(
    normalizedRows
      .map((row) => row.workspaceId)
      .filter((id) => Number.isInteger(id))
      .map(String)
  ).map(Number);
  const normalizedRuntimeCommit = String(runtimeCommit || "").trim();
  const blockers = uniqueSorted([
    ...selection.blockers,
    ...normalizedRows.flatMap((row) => row.blockers),
    ...(missingIds.length > 0 ? ["WEBHOOK_REPLAY_SELECTION_DRIFT"] : []),
    ...(unexpectedIds.length > 0 ? ["WEBHOOK_REPLAY_UNEXPECTED_ROW"] : []),
    ...(workspaceIds.length !== 1 ? ["WEBHOOK_REPLAY_WORKSPACE_SET_INVALID"] : []),
    ...(!/^[a-f0-9]{40}$/i.test(normalizedRuntimeCommit)
      ? ["WEBHOOK_REPLAY_RUNTIME_COMMIT_UNCONFIRMED"]
      : []),
  ]);
  const requestDigest = sha256({
    contractVersion: WEBHOOK_BUFFER_REPLAY_CONTRACT,
    requestedIds: selection.ids,
    defaultWorkspaceId: Number(defaultWorkspaceId || 0) || null,
    runtimeCommit: normalizedRuntimeCommit,
    rowDigests: normalizedRows.map((row) => row.rowDigest),
  });
  const approvalPhrase = blockers.length === 0
    ? [
        WEBHOOK_BUFFER_REPLAY_APPROVAL_PREFIX,
        `digest=${requestDigest}`,
        `rows=${selection.ids.join(",")}`,
        `workspace=${workspaceIds[0]}`,
        `runtime=${normalizedRuntimeCommit}`,
        "action=replay-buffered-inbound-calls-only",
      ].join(": ")
    : null;

  return {
    contractVersion: WEBHOOK_BUFFER_REPLAY_CONTRACT,
    ok: blockers.length === 0,
    blockers,
    requestDigest,
    approvalPhrase,
    approvalHash: approvalPhrase ? sha256(approvalPhrase) : null,
    requestedIds: selection.ids,
    selected: normalizedRows.length,
    missingIds,
    unexpectedIds,
    workspaceIds,
    runtimeCommit: normalizedRuntimeCommit || null,
    defaultWorkspaceId: Number(defaultWorkspaceId || 0) || null,
    replayRows: normalizedRows,
    guardrails: {
      fullOperatorRequired: true,
      exactApprovalRequired: true,
      singleWorkspaceRequired: true,
      maximumRows: WEBHOOK_BUFFER_REPLAY_MAX_ROWS,
      inboundCallsOnly: true,
      providerCallAuthorized: false,
      outboundContactAuthorized: false,
      smsAuthorized: false,
      deploymentAuthorized: false,
      deletionAuthorized: false,
    },
  };
}

export function publicWebhookBufferReplayPlan(plan) {
  return {
    ...plan,
    replayRows: (plan?.replayRows || []).map((row) => ({
      id: row.id,
      callSidSuffix: row.callSid ? String(row.callSid).slice(-6) : null,
      webhookType: row.webhookType,
      workspaceId: row.workspaceId,
      direction: row.direction,
      processStatus: row.processStatus,
      receivedAt: row.receivedAt,
      payloadHash: row.payloadHash,
      rowDigest: row.rowDigest,
      blockers: row.blockers,
    })),
  };
}

export function evaluateWebhookBufferReplayApproval({
  plan,
  providedApproval,
  providedRequestDigest,
}) {
  const blockers = [...(plan?.blockers || [])];
  if (plan?.ok !== true) blockers.push("WEBHOOK_REPLAY_PLAN_NOT_EXECUTABLE");
  if (!exactStringEqual(providedRequestDigest, plan?.requestDigest)) {
    blockers.push("WEBHOOK_REPLAY_REQUEST_DIGEST_MISMATCH");
  }
  if (!exactStringEqual(providedApproval, plan?.approvalPhrase)) {
    blockers.push("WEBHOOK_REPLAY_EXACT_APPROVAL_MISSING");
  }
  const uniqueBlockers = uniqueSorted(blockers);
  return {
    authorized: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    requestDigest: plan?.requestDigest || null,
    approvalHash: plan?.approvalHash || null,
    replayAuthorized: uniqueBlockers.length === 0,
    outboundContactAuthorized: false,
    smsAuthorized: false,
    deploymentAuthorized: false,
    deletionAuthorized: false,
  };
}

export function webhookBufferReplayApprovalHash(value) {
  return sha256(String(value || ""));
}
