import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LAUNCH_TOUCH_APPROVAL_SCHEMA = "smirk.outreach-batch-approval.v3";
export const LAUNCH_TOUCH_PREPARED_STATUS = "prepared_not_approved";

const allowedChannels = new Set(["website_form", "email", "linkedin", "phone"]);

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function addFailure(failures, condition, code, detail = {}) {
  if (!condition) failures.push({ code, ...detail });
}

export function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

export function launchTouchDraftSubject(draft) {
  return String(draft || "")
    .split(/\r?\n/)[0]
    ?.replace(/^Subject:\s*/i, "")
    .trim() || "";
}

function targetTokenList(targets) {
  return targets.map((target) => target.company).join(" | ");
}

export function buildLaunchTouchApprovalToken(payload, payloadSha256) {
  const targets = Array.isArray(payload?.targets) ? payload.targets : [];
  const ledgerStateSha256 = String(payload?.production_ledger_binding?.selected_state_sha256 || "");
  const channels = [...new Set(targets.map((target) => String(target?.channel || "")))];
  const channel = channels.length === 1 ? channels[0] : channels.join("|");
  return [
    "APPROVE_SMIRK_OUTREACH_BATCH:",
    `targets=${targetTokenList(targets)};`,
    `channel=${channel};`,
    `copy=sha256:${payloadSha256};`,
    `ledger=sha256:${ledgerStateSha256};`,
    `batch=${targets.length}`,
  ].join(" ");
}

export function validateLaunchTouchApprovalManifest(manifest) {
  const failures = [];
  addFailure(failures, isRecord(manifest), "approval-manifest-not-object");
  if (!isRecord(manifest)) return { ok: false, failures, approval: null };

  addFailure(failures, manifest.status === LAUNCH_TOUCH_PREPARED_STATUS, "approval-manifest-status-invalid", {
    expected: LAUNCH_TOUCH_PREPARED_STATUS,
    actual: manifest.status ?? null,
    note: "Packet integrity never proves owner approval.",
  });
  addFailure(failures, manifest.no_send === true, "approval-manifest-no-send-missing");
  addFailure(failures, Number.isFinite(Date.parse(String(manifest.generated_at || ""))), "approval-manifest-generated-at-invalid");

  const approval = manifest.approval;
  addFailure(failures, isRecord(approval), "approval-envelope-missing");
  if (!isRecord(approval)) return { ok: false, failures, approval: null };

  const payload = approval.payload;
  addFailure(failures, isRecord(payload), "approval-payload-missing");
  if (!isRecord(payload)) return { ok: false, failures, approval };

  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const productionLedgerBinding = payload.production_ledger_binding;
  addFailure(failures, payload.schema === LAUNCH_TOUCH_APPROVAL_SCHEMA, "approval-schema-invalid", {
    expected: LAUNCH_TOUCH_APPROVAL_SCHEMA,
    actual: payload.schema ?? null,
  });
  addFailure(failures, Number.isInteger(payload.batch_count) && payload.batch_count > 0 && payload.batch_count <= 200, "approval-batch-count-invalid", {
    actual: payload.batch_count ?? null,
  });
  addFailure(failures, payload.batch_count === targets.length, "approval-batch-count-mismatch", {
    declared: payload.batch_count ?? null,
    targets: targets.length,
  });
  addFailure(failures, isRecord(productionLedgerBinding), "approval-production-ledger-binding-missing");
  if (isRecord(productionLedgerBinding)) {
    addFailure(
      failures,
      /^https:\/\//i.test(String(productionLedgerBinding.source || "")),
      "approval-production-ledger-source-invalid",
    );
    addFailure(
      failures,
      /^[a-f0-9]{64}$/i.test(String(productionLedgerBinding.selected_state_sha256 || "")),
      "approval-production-ledger-hash-invalid",
    );
    addFailure(
      failures,
      productionLedgerBinding.selected_company_count === targets.length,
      "approval-production-ledger-company-count-mismatch",
      {
        bound: productionLedgerBinding.selected_company_count ?? null,
        targets: targets.length,
      },
    );
  }

  const seenCompanies = new Set();
  targets.forEach((target, index) => {
    const label = `target-${index + 1}`;
    addFailure(failures, isRecord(target), "approval-target-not-object", { target: label });
    if (!isRecord(target)) return;

    const company = String(target.company || "");
    const channel = String(target.channel || "");
    const contactUrl = String(target.contact_url || "");
    const draft = String(target.draft || "");
    const companyKey = company.trim().toLowerCase();

    addFailure(failures, company === company.trim() && Boolean(company), "approval-target-company-invalid", { target: label });
    addFailure(failures, !/[|;\r\n]/.test(company), "approval-target-company-token-unsafe", { target: label, company });
    addFailure(failures, Boolean(companyKey) && !seenCompanies.has(companyKey), "approval-target-company-duplicate", { target: label, company });
    if (companyKey) seenCompanies.add(companyKey);
    addFailure(failures, allowedChannels.has(channel), "approval-target-channel-invalid", { target: label, channel });
    addFailure(failures, Boolean(contactUrl) && contactUrl === contactUrl.trim(), "approval-target-contact-path-invalid", { target: label });
    if (channel === "website_form") {
      addFailure(failures, /^https:\/\/[^\s]+$/i.test(contactUrl), "approval-target-website-form-must-be-https", { target: label, contact_url: contactUrl });
    }
    addFailure(failures, !/^(?:sms|tel):/i.test(contactUrl), "approval-target-contact-path-forbidden", { target: label, contact_url: contactUrl });
    addFailure(failures, Boolean(draft.trim()), "approval-target-draft-missing", { target: label });
    addFailure(failures, target.draft_sha256 === sha256Text(draft), "approval-target-draft-hash-mismatch", { target: label });
  });

  const canonicalPayload = stableJson(payload);
  const payloadSha256 = sha256Text(canonicalPayload);
  const exactApprovalToken = buildLaunchTouchApprovalToken(payload, payloadSha256);
  addFailure(failures, approval.canonical_payload === canonicalPayload, "approval-canonical-payload-mismatch");
  addFailure(failures, approval.payload_sha256 === payloadSha256, "approval-payload-hash-mismatch", {
    expected: payloadSha256,
    actual: approval.payload_sha256 ?? null,
  });
  addFailure(failures, approval.exact_approval_token === exactApprovalToken, "approval-token-mismatch");

  return {
    ok: failures.length === 0,
    failures,
    approval,
    payload,
    targets,
    canonicalPayload,
    payloadSha256,
    exactApprovalToken,
  };
}

export function buildLaunchTouchApproval(rows, draftFor, options = {}) {
  const targets = rows.map((row) => {
    const draft = String(draftFor(row));
    return {
      company: String(row.company || "").trim(),
      channel: String(row.channel || "").trim(),
      contact_url: String(row.contact_url || "").trim(),
      draft_sha256: sha256Text(draft),
      draft,
    };
  });
  const payload = {
    schema: LAUNCH_TOUCH_APPROVAL_SCHEMA,
    batch_count: targets.length,
    production_ledger_binding: {
      source: String(options.productionLedgerSnapshot?.source || "").trim(),
      selected_state_sha256: String(options.productionLedgerSnapshot?.selected_state_sha256 || "").trim(),
      selected_company_count: options.productionLedgerSnapshot?.selected_company_count,
    },
    targets,
  };
  const canonicalPayload = stableJson(payload);
  const payloadSha256 = sha256Text(canonicalPayload);
  const approval = {
    payload,
    canonical_payload: canonicalPayload,
    payload_sha256: payloadSha256,
    exact_approval_token: buildLaunchTouchApprovalToken(payload, payloadSha256),
  };
  const generatedAt = new Date().toISOString();
  const manifest = {
    generated_at: generatedAt,
    status: LAUNCH_TOUCH_PREPARED_STATUS,
    no_send: true,
    approval,
  };
  const validation = validateLaunchTouchApprovalManifest(manifest);
  if (!validation.ok) {
    const error = new Error("launch touch approval could not be built safely");
    error.failures = validation.failures;
    throw error;
  }
  return { approval, manifest, generatedAt };
}

export function approvalManifestPathForExecution(executionFile) {
  const resolved = path.resolve(executionFile);
  if (!/-execution\.csv$/i.test(resolved)) {
    throw new Error("launch touch execution file must end in -execution.csv");
  }
  return resolved.replace(/-execution\.csv$/i, "-approval.json");
}

export function loadLaunchTouchApprovalManifestForExecution(executionFile) {
  let manifestPath;
  try {
    manifestPath = approvalManifestPathForExecution(executionFile);
  } catch (error) {
    return {
      ok: false,
      manifestPath: null,
      manifest: null,
      failures: [{ code: "approval-manifest-path-invalid", message: error?.message || String(error) }],
    };
  }
  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      manifestPath,
      manifest: null,
      failures: [{ code: "approval-manifest-missing", manifestPath }],
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      manifestPath,
      manifest: null,
      failures: [{ code: "approval-manifest-invalid-json", manifestPath, message: error?.message || String(error) }],
    };
  }
  const validation = validateLaunchTouchApprovalManifest(manifest);
  return { ...validation, manifestPath, manifest };
}

export function validateLaunchTouchExecutionApproval({ rows, executionFile }) {
  const manifestValidation = loadLaunchTouchApprovalManifestForExecution(executionFile);
  const failures = [...(manifestValidation.failures || [])];
  if (!manifestValidation.ok) return { ...manifestValidation, ok: false, failures };

  const targets = manifestValidation.targets;
  addFailure(failures, rows.length === targets.length, "execution-approval-row-count-mismatch", {
    execution_rows: rows.length,
    approved_targets: targets.length,
  });

  rows.forEach((row, index) => {
    const target = targets[index];
    const label = `${index + 1}:${row.company || "missing-company"}`;
    if (!target) {
      failures.push({ code: "execution-approval-target-missing", row: label });
      return;
    }
    addFailure(failures, String(row.send_order || "") === String(index + 1), "execution-send-order-mismatch", {
      row: label,
      expected: String(index + 1),
      actual: row.send_order || null,
    });
    addFailure(failures, row.company === target.company, "execution-company-mismatch", { row: label, approved: target.company, actual: row.company || null });
    addFailure(failures, row.channel === target.channel, "execution-channel-mismatch", { row: label, approved: target.channel, actual: row.channel || null });
    addFailure(failures, row.contact_url === target.contact_url, "execution-contact-path-mismatch", { row: label, approved: target.contact_url, actual: row.contact_url || null });
    addFailure(failures, row.draft_sha256 === target.draft_sha256, "execution-draft-hash-mismatch", { row: label });
    addFailure(failures, row.approval_batch_sha256 === manifestValidation.payloadSha256, "execution-batch-hash-mismatch", { row: label });
    addFailure(failures, row.draft_subject === launchTouchDraftSubject(target.draft), "execution-draft-subject-mismatch", { row: label });
    if (row.sent_at) {
      addFailure(failures, row.actual_contact_path === target.contact_url, "execution-actual-contact-path-not-approved", {
        row: label,
        approved: target.contact_url,
        actual: row.actual_contact_path || null,
        next_action: "Regenerate the packet and obtain a new exact approval before using a different contact path.",
      });
    }
  });

  return {
    ...manifestValidation,
    ok: failures.length === 0,
    failures,
    ownerApprovalProven: false,
  };
}
