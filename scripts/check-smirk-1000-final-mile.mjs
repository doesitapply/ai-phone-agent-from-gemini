#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const outputPath = path.resolve("output/smirk-1000-final-mile-audit.json");
const basicChaosArtifactPath = path.resolve("output/basic-chaos-last.json");
const deployApprovalToken = "APPROVE_SMIRK_POST_CALL_FIX_DEPLOY";
const deployConfirmation = "deploy-post-call-fix";
const stripeWebhookSmokeApprovalPhrase =
  "APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live";
const smokeCleanupApplyApprovalPhrase =
  "APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply";

function run(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    });
    return { ok: true, stdout: stdout.trim(), stderr: "", status: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || "").trim(),
      stderr: String(error?.stderr || error?.message || "").trim(),
      status: error?.status ?? 1,
    };
  }
}

function parseJson(text) {
  const source = String(text || "");
  try {
    return JSON.parse(source);
  } catch {
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
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function artifactMeta(file) {
  if (!existsSync(file)) return { exists: false, path: file };
  const stat = statSync(file);
  return { exists: true, path: file, bytes: stat.size, mtime: stat.mtime.toISOString() };
}

function currentCommit() {
  const result = run("git", ["rev-parse", "HEAD"]);
  return result.ok ? result.stdout : null;
}

function currentBranch() {
  const result = run("git", ["branch", "--show-current"]);
  return result.ok && result.stdout ? result.stdout : "main";
}

function shortOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 2000);
}

function commandEvidence(id, command, args, pass, notes = {}) {
  const result = run(command, args);
  const parsed = parseJson([result.stdout, result.stderr].filter(Boolean).join("\n"));
  const ok = Boolean(pass(result, parsed));
  return {
    id,
    ok,
    type: "command",
    command: [command, ...args].join(" "),
    summary: notes.summary ? notes.summary(result, parsed, ok) : ok ? "passed" : "failed",
    detail: parsed || shortOutput(result),
  };
}

function basicChaosEvidence(commit) {
  const artifact = readJson(basicChaosArtifactPath);
  const currentCommitMatches = artifact?.gitCommit === commit;
  const ok = Boolean(
    artifact?.ok === true &&
      artifact?.code === "BASIC_CHAOS_PASSED" &&
      Number(artifact?.allowedRequests || 0) > 0 &&
      Number(artifact?.restrictedRequests || 0) > 0 &&
      artifact?.cleanupRequired === false &&
      currentCommitMatches
  );

  return {
    id: "basic-chaos-validation",
    ok,
    type: "artifact",
    command:
      "APP_URL=<target> DASHBOARD_API_KEY=<operator-key> ALLOW_SMIRK_BASIC_CHAOS_PROVISION=1 CONFIRM_SMIRK_BASIC_CHAOS_CLEANUP=delete-temp-basic-workspace npm run -s check:basic-chaos",
    summary: ok
      ? `Basic chaos passed with ${artifact.allowedRequests} allowed and ${artifact.restrictedRequests} restricted requests`
      : "Basic chaos artifact missing, stale, dirty, or incomplete",
    detail: {
      artifact: artifactMeta(basicChaosArtifactPath),
      checkedAt: artifact?.checkedAt || null,
      gitCommit: artifact?.gitCommit || null,
      currentCommit: commit,
      currentCommitMatches,
      appUrl: artifact?.appUrl || null,
      provisioned: artifact?.provisioned ?? null,
      cleanedUp: artifact?.cleanedUp ?? null,
      cleanupRequired: artifact?.cleanupRequired ?? null,
      allowedRequests: artifact?.allowedRequests ?? null,
      restrictedRequests: artifact?.restrictedRequests ?? null,
      code: artifact?.code || null,
    },
  };
}

function outboundAuditorEvidence() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "smirk-final-mile-audit-"));
  try {
    const result = run("python3", [
      "scripts/outbound_auditor.py",
      "--targets",
      "docs/outbound-auditor-targets.example.json",
      "--output",
      tmpDir,
    ]);
    const parsed = parseJson([result.stdout, result.stderr].filter(Boolean).join("\n"));
    const written = Array.isArray(parsed?.written) ? parsed.written : [];
    const ok = result.ok && parsed?.ok === true && written.length > 0;
    return {
      id: "non-spam-local-acquisition-audit",
      ok,
      type: "command",
      command:
        "python3 scripts/outbound_auditor.py --targets docs/outbound-auditor-targets.example.json --output <tmp>",
      summary: ok ? `manual-review draft generated (${written.length})` : "manual-review audit draft failed",
      detail: {
        outputDir: tmpDir,
        writtenCount: written.length,
        writtenBasenames: written.map((file) => path.basename(file)),
        parsed,
        raw: ok ? undefined : shortOutput(result),
      },
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const commit = currentCommit();
const branch = currentBranch();
const guardedDeployCommand = branch === "main"
  ? `CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=${deployConfirmation} npm run deploy:post-call-fix`
  : `CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=${deployConfirmation} CONFIRM_SMIRK_DEPLOY_BRANCH=${branch} npm run deploy:post-call-fix`;
const checks = [
  commandEvidence("high-fidelity-no-db-demo-mode", "npm", ["run", "-s", "check:no-db-demo-mode"], (_result, parsed) => (
    parsed?.ok === true &&
    parsed?.code === "NO_DB_DEMO_MODE_PASSED" &&
    Number(parsed?.calls || 0) >= 3 &&
    Number(parsed?.contacts || 0) >= 3 &&
    Number(parsed?.tasks || 0) >= 3
  )),
  commandEvidence("customer-operator-ui-partition", "npm", ["run", "-s", "check:customer-dashboard"], (result) => (
    result.ok && /OK customer dashboard contract/.test(result.stdout)
  )),
  commandEvidence("plan-boundary-contract", "npm", ["run", "-s", "check:plan-boundaries"], (result) => (
    result.ok && /OK plan boundary contract/.test(result.stdout)
  )),
  commandEvidence("contact-dnc-management", "npm", ["run", "-s", "check:contact-management"], (result) => (
    result.ok && /\bok\b/i.test(result.stdout)
  )),
  commandEvidence("first-dollar-offer-scope", "npm", ["run", "-s", "check:first-dollar-offer-scope"], (result) => (
    result.ok && /OK first-dollar offer scope/.test(result.stdout)
  )),
  basicChaosEvidence(commit),
  outboundAuditorEvidence(),
  commandEvidence("live-production-parity", "npm", ["run", "-s", "check:live-is-current"], (_result, parsed) => (
    parsed?.ok === true
  ), {
    summary: (_result, parsed, ok) => ok
      ? "live production matches local HEAD"
      : `live production stale (${parsed?.actualVersion || "unknown"} != ${parsed?.expectedVersion || commit || "unknown"})`,
  }),
  commandEvidence("first-customer-10of10", "npm", ["run", "-s", "check:first-customer-10of10"], (_result, parsed) => (
    parsed?.ok === true
  ), {
    summary: (_result, parsed, ok) => ok
      ? "first-customer 10/10 bundle passed"
      : parsed?.verdict || "first-customer 10/10 bundle failed",
  }),
];

const localMilestones = new Map([
  ["high-fidelity-no-db-demo-mode", 35],
  ["customer-operator-ui-partition", 25],
  ["plan-boundary-contract", 25],
  ["basic-chaos-validation", 40],
]);

const localScore = checks.reduce((score, check) => score + (check.ok ? localMilestones.get(check.id) || 0 : 0), 875);
const failures = checks.filter((check) => !check.ok);
const liveParity = checks.find((check) => check.id === "live-production-parity");
const firstCustomer = checks.find((check) => check.id === "first-customer-10of10");

const report = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  gitCommit: commit,
  branch,
  localScore,
  targetScore: 1000,
  localFinalMileComplete: localScore >= 1000 && checks.filter((check) => localMilestones.has(check.id)).every((check) => check.ok),
  productionReady: Boolean(liveParity?.ok && firstCustomer?.ok),
  approvalGates: {
    deploy: {
      required: !liveParity?.ok,
      approvalToken: deployApprovalToken,
      confirmationEnv: "CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY",
      confirmationValue: deployConfirmation,
      branchConfirmationEnv: branch === "main" ? null : "CONFIRM_SMIRK_DEPLOY_BRANCH",
      branchConfirmationValue: branch === "main" ? null : branch,
      command: guardedDeployCommand,
      meaning:
        "Production deploy approval only. Does not authorize Stripe smoke, cleanup apply, proof calls, secret access, paid spend, or outreach.",
    },
    postDeployProof: {
      required: Boolean(liveParity?.ok && !firstCustomer?.ok),
      commands: [
        "npm run -s check:ship-live",
        "npm run -s check:real-call-readiness -- <safe-number>",
        "npm run -s proof:real-call -- <safe-number>",
      ],
      expectedArtifacts: [
        "call record",
        "generated summary",
        "owner email alert",
        "callback task",
        "dashboard proof counters",
      ],
    },
    stripeWebhookSmoke: {
      requiredApprovalPhrase: stripeWebhookSmokeApprovalPhrase,
    },
    smokeCleanupApply: {
      requiredApprovalPhrase: smokeCleanupApplyApprovalPhrase,
    },
  },
  checks,
  failures: failures.map((check) => ({
    id: check.id,
    summary: check.summary,
    command: check.command,
  })),
  nextAction: liveParity?.ok
    ? "Run the post-deploy proof and live Basic chaos gates."
    : `Deploy the current commit with ${deployApprovalToken}, then rerun this audit.`,
  artifactPath: outputPath,
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
