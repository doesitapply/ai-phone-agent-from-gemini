#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputDir = path.resolve("output");
const readinessPath = path.join(outputDir, "first-customer-10of10-readiness.json");
const stripeSmokeArtifactPath = path.join(outputDir, "stripe-webhook-handoff-live.json");
const paidHandoffArtifactPath = path.join(outputDir, "paid-handoff-live.json");
const cleanupDryRunPath = path.join(outputDir, "smoke-workspace-cleanup-dry-run.json");

const stripeSmokeApprovalPhrase =
  "APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live";
const cleanupApplyApprovalPhrase =
  "APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply";

function run(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || "").trim(),
      stderr: String(error?.stderr || error?.message || "").trim(),
      status: error?.status ?? null,
    };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}$/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // Fall through to the bounded-object slice below.
      }
    }
    const source = String(text || "");
    const firstBrace = source.indexOf("{");
    const lastBrace = source.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    try {
      return JSON.parse(source.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function artifactMeta(file) {
  if (!existsSync(file)) return { exists: false };
  const stat = statSync(file);
  return {
    exists: true,
    path: file,
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

function recordCommand(checks, id, command, args, evaluate, options = {}) {
  const result = run(command, args, options);
  const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const parsed = parseJson(combinedOutput);
  const evaluated = evaluate ? evaluate(result, parsed) : { ok: result.ok };
  checks.push({
    id,
    ok: Boolean(result.ok && evaluated.ok),
    command: [command, ...args].join(" "),
    summary: evaluated.summary || (result.ok ? "pass" : "fail"),
    detail: evaluated.detail ?? parsed ?? combinedOutput.slice(0, 1000) ?? null,
  });
  return { result, parsed, evaluated };
}

function checkGitClean(checks) {
  const status = run("git", ["status", "--short"]);
  const dirty = status.stdout.split(/\r?\n/).filter(Boolean);
  checks.push({
    id: "git-clean",
    ok: status.ok && dirty.length === 0,
    command: "git status --short",
    summary: dirty.length === 0 ? "worktree clean" : "worktree has uncommitted files",
    detail: dirty,
  });
}

function artifactMatchesLiveDeploy(artifact, liveDeploy) {
  if (artifact?.liveDeploy?.ok !== true || liveDeploy?.ok !== true) return false;
  return (
    artifact.liveDeploy.version === liveDeploy.version &&
    artifact.liveDeploy.branch === liveDeploy.branch
  );
}

function checkSmokeProof(checks, liveDeploy, currentCleanupDryRun = undefined) {
  const stripeSmoke = readJson(stripeSmokeArtifactPath);
  const paidHandoff = readJson(paidHandoffArtifactPath);
  const cleanupDryRun = currentCleanupDryRun === undefined ? readJson(cleanupDryRunPath) : currentCleanupDryRun;

  const stripeSmokeOk = Boolean(
    stripeSmoke?.ok === true &&
      artifactMatchesLiveDeploy(stripeSmoke, liveDeploy) &&
      stripeSmoke?.webhook?.received === true &&
      stripeSmoke?.checkoutStatus?.found === true &&
      stripeSmoke?.checkoutStatus?.checkout_reference_received === true &&
      stripeSmoke?.checkoutStatus?.checkout_session_id_exposed === false &&
      stripeSmoke?.cleanupDryRun?.provisioning_request_visible === true
  );

  const paidHandoffOk = Boolean(
    paidHandoff?.ok === true &&
      artifactMatchesLiveDeploy(paidHandoff, liveDeploy) &&
      paidHandoff?.checkout?.hasCheckoutUrl === true &&
      paidHandoff?.activation?.provisioning_request_id &&
      paidHandoff?.checkoutStatus?.found === true &&
      paidHandoff?.checkoutStatus?.checkout_reference_received === true
  );

  const cleanupBaselineOk = Boolean(
    cleanupDryRun?.ok === true &&
      Number(cleanupDryRun?.result?.matched_workspaces || 0) === 0 &&
      Number(cleanupDryRun?.result?.matched_provisioning_requests || 0) === 0
  );

  checks.push({
    id: "approved-checkout-provisioning-write",
    ok: stripeSmokeOk || paidHandoffOk,
    command: "approval gated",
    summary: stripeSmokeOk || paidHandoffOk
      ? "approved checkout/provisioning write proof artifact present"
      : "missing approved production checkout/provisioning write proof",
    detail: {
      acceptedArtifacts: {
        stripeWebhookSmoke: {
          ...artifactMeta(stripeSmokeArtifactPath),
          liveDeployMatches: artifactMatchesLiveDeploy(stripeSmoke, liveDeploy),
          artifactVersion: stripeSmoke?.liveDeploy?.version || null,
          artifactBranch: stripeSmoke?.liveDeploy?.branch || null,
        },
        paidHandoffSmoke: {
          ...artifactMeta(paidHandoffArtifactPath),
          liveDeployMatches: artifactMatchesLiveDeploy(paidHandoff, liveDeploy),
          artifactVersion: paidHandoff?.liveDeploy?.version || null,
          artifactBranch: paidHandoff?.liveDeploy?.branch || null,
        },
      },
      currentLiveDeploy: liveDeploy || null,
      requiredApprovalPhrase: stripeSmokeApprovalPhrase,
      cleanupApplyApprovalPhrase,
    },
  });

  checks.push({
    id: "smoke-cleanup-baseline",
    ok: cleanupBaselineOk,
    command: "APP_URL=https://www.smirkcalls.com npm run cleanup:smoke-workspaces",
    summary: cleanupBaselineOk
      ? "cleanup dry-run baseline is clear"
      : "cleanup dry-run baseline is missing or not clear",
    detail: {
      artifact: artifactMeta(cleanupDryRunPath),
      ok: cleanupDryRun?.ok === true,
      error: cleanupDryRun?.error || cleanupDryRun?.result?.error || null,
      http_status: cleanupDryRun?.http_status ?? null,
      auth_source: cleanupDryRun?.auth_source || null,
      matched_workspaces: Number(cleanupDryRun?.result?.matched_workspaces || 0),
      matched_provisioning_requests: Number(cleanupDryRun?.result?.matched_provisioning_requests || 0),
    },
  });
}

const checks = [];

checkGitClean(checks);
const liveCurrentCheck = recordCommand(checks, "live-current", "npm", ["run", "-s", "check:live-is-current"], (_result, parsed) => ({
  ok: parsed?.ok === true,
  summary: parsed?.ok ? `live current at ${parsed.version}` : "live is not current",
  detail: parsed,
}));
const liveDeploy = liveCurrentCheck.parsed?.ok === true ? liveCurrentCheck.parsed : null;
recordCommand(checks, "latest-failed-deploy", "npm", ["run", "-s", "check:latest-failed-deploy"], (result) => ({
  ok: result.ok && /OK no failed deployments/.test(result.stdout),
  summary: result.stdout.slice(0, 200),
}));
recordCommand(checks, "dependency-audit", "npm", ["audit", "--audit-level=moderate"], (result) => ({
  ok: result.ok && /found 0 vulnerabilities/.test(result.stdout),
  summary: result.stdout.slice(0, 200),
}));
recordCommand(checks, "buyer-routes-live", "npm", ["run", "-s", "check:buyer-routes-live"], (result) => ({
  ok: result.ok && /OK buyer route audit/.test(result.stdout),
  summary: result.stdout.split(/\r?\n/).filter(Boolean).slice(-1)[0] || result.stdout.slice(0, 200),
}));
recordCommand(checks, "local-runtime-smoke", "npm", ["run", "-s", "check:local-runtime-smoke"], (result) => ({
  ok: result.ok && /OK local runtime smoke/.test(result.stdout),
  summary: result.stdout.split(/\r?\n/).filter(Boolean).slice(-1)[0] || result.stdout.slice(0, 200),
}));
recordCommand(checks, "customer-dashboard", "npm", ["run", "-s", "check:customer-dashboard"], (result) => ({
  ok: result.ok && /OK customer dashboard contract/.test(result.stdout),
  summary: result.stdout.slice(0, 200),
}));
recordCommand(checks, "plan-boundaries", "npm", ["run", "-s", "check:plan-boundaries"], (result) => ({
  ok: result.ok && /OK plan boundary contract/.test(result.stdout),
  summary: result.stdout.slice(0, 200),
}));
recordCommand(checks, "live-workspace-entitlements", "npm", ["run", "-s", "check:live-workspace-entitlements"], (_result, parsed) => ({
  ok: parsed?.ok === true,
  summary: parsed?.ok
    ? `live workspace entitlement proof passed (${parsed?.workspaceInventory?.total || 0} workspace(s), plans: ${(parsed?.workspaceInventory?.plans || []).join(", ") || "none"})`
    : "live workspace entitlement proof failed",
  detail: parsed,
}));
recordCommand(checks, "contact-management", "npm", ["run", "-s", "check:contact-management"], (result) => ({
  ok: result.ok && /ok/i.test(result.stdout),
  summary: result.stdout.slice(0, 200),
}));
recordCommand(checks, "stripe-signature", "npm", ["run", "-s", "check:stripe-webhook-signature-live"], (_result, parsed) => ({
  ok: parsed?.ok === true && parsed?.webhook?.verified === true && /none/i.test(String(parsed?.mutationRisk || "")),
  summary: parsed?.ok ? "signed webhook verifies without mutation" : "signed webhook verification failed",
  detail: parsed,
}));
recordCommand(checks, "stripe-preflight", "npm", ["run", "-s", "check:stripe-webhook-handoff-live:preflight"], (_result, parsed) => ({
  ok: parsed?.ok === true && parsed?.autoFulfillEnabled === true && parsed?.approvalRequired === true,
  summary: parsed?.ok ? "full Stripe smoke is configured and approval gated" : "Stripe preflight failed",
  detail: parsed,
}));
recordCommand(checks, "stripe-approval-ready", "npm", ["run", "-s", "check:stripe-webhook-smoke-approval-ready"], (_result, parsed) => ({
  ok: parsed?.ok === true && parsed?.approvalRequired === true,
  summary: parsed?.ok ? "Stripe smoke approval artifacts ready" : "Stripe smoke approval artifacts not ready",
  detail: parsed,
}));
recordCommand(checks, "proof-artifacts", "npm", ["run", "-s", "check:proof-artifacts-live"], (_result, parsed) => ({
  ok: parsed?.ok === true,
  summary: parsed?.ok ? "live proof artifacts present" : "live proof artifacts failed",
  detail: parsed,
}));
recordCommand(checks, "post-call-intelligence", "npm", ["run", "-s", "check:post-call-intelligence-live"], (_result, parsed) => ({
  ok: parsed?.ok === true && parsed?.summaryDegraded === false,
  summary: parsed?.ok ? "post-call intelligence healthy" : "post-call intelligence failed",
  detail: parsed,
}));
recordCommand(checks, "dashboard-proof", "npm", ["run", "-s", "check:dashboard-proof-live"], (_result, parsed) => ({
  ok: parsed?.ok === true && parsed?.publicProof?.leakedFields?.length === 0,
  summary: parsed?.ok ? "dashboard and public proof healthy" : "dashboard proof failed",
  detail: parsed,
}));
const cleanupDryRunCheck = recordCommand(
  checks,
  "smoke-cleanup-dry-run-current",
  "npm",
  ["run", "-s", "cleanup:smoke-workspaces"],
  (_result, parsed) => ({
    ok: parsed?.ok === true &&
      parsed?.apply === false &&
      Number(parsed?.result?.matched_workspaces || 0) === 0 &&
      Number(parsed?.result?.matched_provisioning_requests || 0) === 0,
    summary: parsed?.ok
      ? `current cleanup dry-run matched ${Number(parsed?.result?.matched_workspaces || 0)} workspace(s) and ${Number(parsed?.result?.matched_provisioning_requests || 0)} provisioning request(s)`
      : "current cleanup dry-run failed",
    detail: parsed,
  }),
  { env: { ...process.env, APP_URL: "https://www.smirkcalls.com" } },
);

checkSmokeProof(checks, liveDeploy, cleanupDryRunCheck.parsed);

const failures = checks.filter((check) => !check.ok);
const output = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  verdict: failures.length === 0
    ? "SMIRK first-customer 10/10 gate is fully proven."
    : "SMIRK is not fully 10/10 yet; see failing gates.",
  checks,
  failures: failures.map((check) => ({
    id: check.id,
    summary: check.summary,
    detail: check.detail,
  })),
  requiredNextApproval: failures.some((check) => check.id === "approved-checkout-provisioning-write")
    ? stripeSmokeApprovalPhrase
    : null,
};

mkdirSync(outputDir, { recursive: true });
writeFileSync(readinessPath, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));

if (!output.ok) process.exit(1);
