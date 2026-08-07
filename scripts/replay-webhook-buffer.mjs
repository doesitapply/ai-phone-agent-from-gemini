#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  WEBHOOK_BUFFER_REPLAY_CONTRACT,
  normalizeWebhookBufferReplayIds,
} from "../src/webhook-buffer-replay-contract.mjs";
import { firstWorkingSmirkOperatorAuth } from "./lib/smirk-operator-auth.mjs";

const apply = process.argv.includes("--apply");
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--apply");
const appUrl = String(
  process.env.APP_URL ||
    "https://ai-phone-agent-production-6811.up.railway.app"
).trim();
const allowLoopback = process.env.SMIRK_ALLOW_LOOPBACK_OPERATOR_TEST === "1";
const defaultWorkspaceId = Number(
  process.env.WEBHOOK_BUFFER_REPLAY_DEFAULT_WORKSPACE_ID || 0
);
const requestedIdTokens = String(process.env.WEBHOOK_BUFFER_REPLAY_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const selection = normalizeWebhookBufferReplayIds(requestedIdTokens);
const providedApproval = String(
  process.env.WEBHOOK_BUFFER_REPLAY_APPROVAL || ""
);
const providedRequestDigest = String(
  process.env.WEBHOOK_BUFFER_REPLAY_REQUEST_DIGEST || ""
).trim();
const outputPath = path.resolve(
  "output",
  apply
    ? "webhook-buffer-replay-apply.json"
    : "webhook-buffer-replay-dry-run.json"
);

function writeOutput(output) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function failBeforeNetwork(error, blockers = []) {
  writeOutput({
    ok: false,
    contractVersion: WEBHOOK_BUFFER_REPLAY_CONTRACT,
    apply,
    mode: apply ? "apply-refused" : "dry-run-refused",
    error,
    blockers,
    requestedIds: selection.ids,
    source: "local-client",
    operatorApiRequestPerformed: false,
    productionWritePerformed: false,
    outboundContactPerformed: false,
    smsSent: false,
    deploymentPerformed: false,
    deletionPerformed: false,
    artifactPath: outputPath,
  });
  process.exitCode = 1;
}

async function requestReplay({ origin, apiKey, body }) {
  const response = await fetch(`${origin}/api/admin/webhook-buffer-replay`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!String(response.headers.get("content-type") || "").includes(
    "application/json"
  )) {
    throw new Error("WEBHOOK_REPLAY_RESPONSE_CONTENT_TYPE_INVALID");
  }
  const announcedLength = Number(response.headers.get("content-length") || 0);
  if (announcedLength > 128 * 1024) {
    throw new Error("WEBHOOK_REPLAY_RESPONSE_TOO_LARGE");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 128 * 1024) {
    throw new Error("WEBHOOK_REPLAY_RESPONSE_TOO_LARGE");
  }
  let bodyJson;
  try {
    bodyJson = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("WEBHOOK_REPLAY_RESPONSE_JSON_INVALID");
  }
  return { status: response.status, ok: response.ok, body: bodyJson };
}

function exactIdArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(Number).sort((left, right) => left - right);
}

function validatePreview(response) {
  const body = response.body;
  const blockers = [];
  if (!response.ok || body?.ok !== true) {
    blockers.push("WEBHOOK_REPLAY_PREVIEW_NOT_READY");
  }
  if (body?.contractVersion !== WEBHOOK_BUFFER_REPLAY_CONTRACT) {
    blockers.push("WEBHOOK_REPLAY_LIVE_CONTRACT_MISMATCH");
  }
  if (body?.mode !== "dry-run" || body?.apply !== false) {
    blockers.push("WEBHOOK_REPLAY_PREVIEW_MODE_INVALID");
  }
  if (body?.productionWritePerformed !== false) {
    blockers.push("WEBHOOK_REPLAY_PREVIEW_WRITE_CLAIM_INVALID");
  }
  if (JSON.stringify(exactIdArray(body?.requestedIds)) !==
    JSON.stringify(selection.ids)) {
    blockers.push("WEBHOOK_REPLAY_PREVIEW_SELECTION_MISMATCH");
  }
  if (Number(body?.selected) !== selection.ids.length) {
    blockers.push("WEBHOOK_REPLAY_PREVIEW_CARDINALITY_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(body?.requestDigest || ""))) {
    blockers.push("WEBHOOK_REPLAY_PREVIEW_DIGEST_INVALID");
  }
  if (!String(body?.approvalPhrase || "").startsWith(
    "APPROVE_REPLAY_SMIRK_WEBHOOK_BUFFER:"
  )) {
    blockers.push("WEBHOOK_REPLAY_PREVIEW_APPROVAL_INVALID");
  }
  return [...new Set(blockers)].sort();
}

if (unknownArguments.length > 0) {
  failBeforeNetwork("unknown-arguments", ["WEBHOOK_REPLAY_ARGUMENT_INVALID"]);
} else if (!selection.ok) {
  failBeforeNetwork("invalid-replay-selection", selection.blockers);
} else if (apply && (
  !/^[a-f0-9]{64}$/i.test(providedRequestDigest) || !providedApproval
)) {
  failBeforeNetwork("exact-replay-approval-required", [
    ...(!/^[a-f0-9]{64}$/i.test(providedRequestDigest)
      ? ["WEBHOOK_REPLAY_REQUEST_DIGEST_MISSING"]
      : []),
    ...(!providedApproval
      ? ["WEBHOOK_REPLAY_EXACT_APPROVAL_MISSING"]
      : []),
  ]);
}

if (process.exitCode) {
  // Validation failed before credentials or network were touched.
} else {
  try {
    const auth = await firstWorkingSmirkOperatorAuth({
      appUrl,
      allowLoopback,
    });
    if (!auth.ok) {
      throw new Error("SMIRK_FULL_OPERATOR_AUTH_UNAVAILABLE");
    }
    const previewResponse = await requestReplay({
      origin: auth.origin,
      apiKey: auth.apiKey,
      body: {
        apply: false,
        selectedIds: selection.ids,
        defaultWorkspaceId: defaultWorkspaceId > 0
          ? defaultWorkspaceId
          : null,
      },
    });
    const previewBlockers = validatePreview(previewResponse);
    const preview = {
      ...previewResponse.body,
      ok: previewBlockers.length === 0,
      blockers: [...new Set([
        ...(previewResponse.body?.blockers || []),
        ...previewBlockers,
      ])].sort(),
      httpStatus: previewResponse.status,
      source: "live-admin-api",
      operatorAuthSource: auth.source,
      operatorAuthFailures: auth.failures.length > 0
        ? auth.failures
        : undefined,
      artifactPath: outputPath,
    };

    if (!apply || previewBlockers.length > 0) {
      writeOutput(preview);
      process.exitCode = preview.ok ? 0 : 1;
    } else if (
      providedRequestDigest !== preview.requestDigest ||
      providedApproval !== preview.approvalPhrase
    ) {
      writeOutput({
        ...preview,
        ok: false,
        apply: true,
        mode: "apply-refused",
        error: "replay-approval-no-longer-matches-preview",
        blockers: [...new Set([
          ...(preview.blockers || []),
          ...(providedRequestDigest !== preview.requestDigest
            ? ["WEBHOOK_REPLAY_REQUEST_DIGEST_MISMATCH"]
            : []),
          ...(providedApproval !== preview.approvalPhrase
            ? ["WEBHOOK_REPLAY_EXACT_APPROVAL_MISSING"]
            : []),
        ])].sort(),
        productionWritePerformed: false,
      });
      process.exitCode = 1;
    } else {
      const applyResponse = await requestReplay({
        origin: auth.origin,
        apiKey: auth.apiKey,
        body: {
          apply: true,
          selectedIds: selection.ids,
          defaultWorkspaceId: defaultWorkspaceId > 0
            ? defaultWorkspaceId
            : null,
          requestDigest: providedRequestDigest,
          approval: providedApproval,
        },
      });
      const appliedIds = exactIdArray(applyResponse.body?.processedIds);
      const applyMode = String(applyResponse.body?.mode || "");
      const expectedWriteClaim = applyMode === "apply-verified"
        ? true
        : applyMode === "apply-idempotent-replay"
          ? false
          : null;
      const applyBlockers = [
        ...(!applyResponse.ok || applyResponse.body?.ok !== true
          ? ["WEBHOOK_REPLAY_APPLY_NOT_VERIFIED"]
          : []),
        ...(applyResponse.body?.contractVersion !==
          WEBHOOK_BUFFER_REPLAY_CONTRACT
          ? ["WEBHOOK_REPLAY_APPLY_CONTRACT_MISMATCH"]
          : []),
        ...(applyResponse.body?.requestDigest !== providedRequestDigest
          ? ["WEBHOOK_REPLAY_APPLY_DIGEST_MISMATCH"]
          : []),
        ...(applyResponse.body?.apply !== true || expectedWriteClaim === null
          ? ["WEBHOOK_REPLAY_APPLY_MODE_INVALID"]
          : []),
        ...(expectedWriteClaim !== null &&
          applyResponse.body?.productionWritePerformed !== expectedWriteClaim
          ? ["WEBHOOK_REPLAY_APPLY_WRITE_CLAIM_INVALID"]
          : []),
        ...(!Number.isInteger(Number(applyResponse.body?.auditId)) ||
          Number(applyResponse.body?.auditId) <= 0 ||
          !Number.isFinite(new Date(applyResponse.body?.appliedAt).getTime())
          ? ["WEBHOOK_REPLAY_APPLY_RECEIPT_INVALID"]
          : []),
        ...(JSON.stringify(appliedIds) !== JSON.stringify(selection.ids)
          ? ["WEBHOOK_REPLAY_APPLY_SELECTION_MISMATCH"]
          : []),
        ...(applyResponse.body?.outboundContactPerformed !== false ||
          applyResponse.body?.smsSent !== false ||
          applyResponse.body?.deploymentPerformed !== false ||
          applyResponse.body?.deletionPerformed !== false
          ? ["WEBHOOK_REPLAY_APPLY_SCOPE_CLAIM_INVALID"]
          : []),
      ];
      const output = {
        ...applyResponse.body,
        ok: applyBlockers.length === 0,
        blockers: [...new Set([
          ...(applyResponse.body?.blockers || []),
          ...applyBlockers,
        ])].sort(),
        httpStatus: applyResponse.status,
        source: "live-admin-api",
        operatorAuthSource: auth.source,
        previewRequestDigest: preview.requestDigest,
        previewMatchedApproval: true,
        artifactPath: outputPath,
      };
      writeOutput(output);
      process.exitCode = output.ok ? 0 : 1;
    }
  } catch (error) {
    writeOutput({
      ok: false,
      contractVersion: WEBHOOK_BUFFER_REPLAY_CONTRACT,
      apply,
      mode: apply ? "apply-failed" : "dry-run-failed",
      error: error instanceof Error ? error.message : "UNKNOWN_FAILURE",
      requestedIds: selection.ids,
      productionWritePerformed: false,
      outboundContactPerformed: false,
      smsSent: false,
      deploymentPerformed: false,
      deletionPerformed: false,
      artifactPath: outputPath,
    });
    process.exitCode = 1;
  }
}
