#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  REAL_PROOF_CALL_APPROVAL_TOKEN,
  realProofCallApprovalCommand,
} from "./lib/real-proof-call-approval.mjs";

const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, "output");
const stripeNotePath = path.join(outputDir, "stripe-webhook-smoke-approval.md");
const stripeJsonPath = path.join(outputDir, "stripe-webhook-smoke-approval.json");
const deployNotePath = path.join(outputDir, "post-call-fix-approval-note.md");
const deployBundlePath = path.join(outputDir, "deploy-approval-bundle.json");
const targetPath = path.join(outputDir, "first-dollar-approval-packet.md");

const required = [
  ["Stripe smoke approval note", stripeNotePath],
  ["Stripe smoke approval JSON", stripeJsonPath],
  ["Deploy approval note", deployNotePath],
  ["Deploy approval bundle", deployBundlePath],
];

const missing = required.filter(([, file]) => !existsSync(file));
if (missing.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-first-dollar-approval-artifacts",
    missing: missing.map(([label, file]) => ({ label, file })),
    nextAction: "Run npm run write:stripe-webhook-smoke-approval && npm run write:deploy-approval-bundle, then rerun npm run write:first-dollar-approval-packet.",
  }, null, 2));
  process.exit(1);
}

const stripeApproval = JSON.parse(readFileSync(stripeJsonPath, "utf8"));
const deployBundle = JSON.parse(readFileSync(deployBundlePath, "utf8"));
const stripeNote = readFileSync(stripeNotePath, "utf8").trim();
const deployNote = readFileSync(deployNotePath, "utf8").trim();

const stripeCommand = stripeApproval.commandToApprove || "ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live";
const stripeApprovalToken = stripeApproval.approvalToken || "APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE";
const stripeApprovalPhrase = `${stripeApprovalToken}: ${stripeCommand}`;
const cleanupApplyCommand = stripeApproval.cleanup?.applyCommand || "APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply";
const cleanupApprovalToken = stripeApproval.cleanupApprovalToken || "APPROVE_SMIRK_SMOKE_CLEANUP_APPLY";
const cleanupApprovalPhrase = `${cleanupApprovalToken}: ${cleanupApplyCommand}`;
const deployCommand = deployBundle.approvalSteps?.find((step) => step.includes("npm run deploy:post-call-fix")) || deployBundle.nextAction || "See deploy approval note.";
const deployApprovalToken = deployBundle.deployApprovalToken || "APPROVE_SMIRK_POST_CALL_FIX_DEPLOY";
const deployApprovalMeaning = deployBundle.deployApprovalMeaning || "Production deploy approval only. This does not authorize Stripe smoke, cleanup apply, proof calls, secret access, paid spend, or outreach.";
const firstDollarBootstrapDeployRequired = deployBundle.firstDollarBootstrapDeployRequired === true;
const firstDollarBootstrapDeployMode = deployBundle.firstDollarBootstrapDeployMode || null;
const firstDollarBootstrapDeployMeaning = deployBundle.firstDollarBootstrapDeployMeaning || null;
const expectedFirstDollarBootstrapDeployMode = "SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY=deploy-fail-closed-checkout";
const liveEnvApprovalPhrase = "APPROVE_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE: apply the immediately preceding masked, provider-verified Starter-only Railway dry run";
const liveEnvMachineConfirmation = "CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env";
const legacyLinkDeactivationApprovalTemplate = "APPROVE_SMIRK_STRIPE_PAYMENT_LINK_DEACTIVATION: ids=<exact-read-only-scan-plink-ids>; action=set-active-false-only";
const starterCheckoutApprovalPhrase = "APPROVE_SMIRK_REAL_STARTER_CHECKOUT: accept buyer-initiated subscriptions from unrelated real customers for Starter at the existing $197/month price only";
const starterCheckoutMachineConfirmation = "CONFIRM_SMIRK_REAL_STARTER_CHECKOUT=accept-buyer-initiated-starter-197-monthly";
const proofCallApprovalPhrase = `${REAL_PROOF_CALL_APPROVAL_TOKEN}: <exact-approved-e164>`;
const proofCallCommand = realProofCallApprovalCommand();
const outreachApprovalTemplate = "APPROVE_SMIRK_OUTREACH_BATCH: targets=<exact-list-or-ledger-ids>; channel=<exact-approved-channel>; copy=<exact-reviewed-template-or-hash>; batch=<exact-count>";
const deployState = deployBundle.deployState || "unknown";
const deployBlockerDetail = deployBundle.blockerDetail || "Pending deploy approval is required before paid-path or proof-call checks.";
const liveAlreadyCurrent = deployState === "live-already-current" && deployBundle.liveFingerprintCurrent === true && deployBundle.localDeployClean === true;
const deployApprovalNeeded = !liveAlreadyCurrent;
const customerPolicyVersion = String(deployBundle.customerPolicyVersion || "").trim();
const customerPolicyVersionRecorded = deployBundle.customerPolicyVersionRecorded === true
  && /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(customerPolicyVersion);

if (firstDollarBootstrapDeployRequired && (
  firstDollarBootstrapDeployMode !== expectedFirstDollarBootstrapDeployMode
  || !deployCommand.includes(expectedFirstDollarBootstrapDeployMode)
  || !deployCommand.includes("npm run deploy:post-call-fix")
  || !firstDollarBootstrapDeployMeaning
)) {
  console.error(JSON.stringify({
    ok: false,
    error: "first-dollar-bootstrap-deploy-command-missing",
    firstDollarBootstrapDeployRequired,
    firstDollarBootstrapDeployMode,
    deployCommand,
    nextAction: "Regenerate the deploy approval request and bundle so the exact bootstrap-mode deploy command is preserved before writing this packet.",
  }, null, 2));
  process.exit(1);
}

function runGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const localBranch = runGit(["branch", "--show-current"]) || "unknown";
const localCommit = runGit(["rev-parse", "HEAD"]);
const remoteMainCommit = runGit(["rev-parse", "origin/main"]);
const mergeBaseMain = runGit(["merge-base", "HEAD", "origin/main"]);
const stripeApprovalSourceCommit = stripeApproval.sourceCommit || null;
const stripeApprovalMatchesLocalCommit = Boolean(stripeApprovalSourceCommit && localCommit && stripeApprovalSourceCommit === localCommit);
const gitRemoteSync = localCommit && remoteMainCommit && mergeBaseMain
  ? (localCommit === remoteMainCommit
    ? "current"
    : (mergeBaseMain === remoteMainCommit ? "ahead" : (mergeBaseMain === localCommit ? "behind" : "diverged")))
  : "unknown";
const requiresBranchReconcile = gitRemoteSync === "behind" || gitRemoteSync === "diverged";
const branchConflictForecastCommand = "npm run -s check:branch-sync-conflict-forecast";
const branchReconcileCommand = `git stash push -u -m "smirk-deploy-divergence" && git pull --rebase origin main && git stash pop`;
const branchReconcileApprovalToken = "APPROVE_SMIRK_BRANCH_RECONCILE";
const deployRecommendation = requiresBranchReconcile
  ? `Synchronize the local branch with origin/main before approving production deploy. The reviewed branch is ${gitRemoteSync} relative to origin/main, so deploying now risks proving or shipping the wrong approval surface.`
  : (liveAlreadyCurrent
    ? "Production is already current and the deploy-relevant working tree is clean. The next approval-gated money-path proof is the signed Stripe webhook smoke after live and buffer checks pass."
    : (deployState === "pending-local-deploy-work"
    ? (deployBundle.liveFingerprintCurrent === true
      ? `Approve the production deploy first. The local proof-hardening bundle is ready, live fingerprint is current, and deploy-relevant local work is pending approval/shipping; running paid-path or proof-call checks before this deploy risks proving the wrong approval surface.`
      : `Approve the production deploy first. The local proof-hardening bundle is ready, but production is stale; running paid-path or proof-call checks before deploy risks proving the wrong code.`)
    : `Approve the production deploy first. The local proof-hardening bundle is ready, but production is stale; running paid-path or proof-call checks before deploy risks proving the wrong code.`));

if (liveAlreadyCurrent && !stripeApprovalMatchesLocalCommit) {
  console.error(JSON.stringify({
    ok: false,
    error: "stale-stripe-webhook-smoke-approval-artifact",
    currentCommit: localCommit || "unknown",
    stripeApprovalSourceCommit: stripeApprovalSourceCommit || "unknown",
    nextAction: "Run npm run -s write:stripe-webhook-smoke-approval, then rerun npm run write:deploy-approval-bundle.",
  }, null, 2));
  process.exit(1);
}

const stripeSourceNote = stripeApprovalMatchesLocalCommit
  ? stripeNote
  : [
      "# Stripe Webhook Smoke Approval",
      "",
      "The saved Stripe smoke approval artifact does not match the current commit.",
      "",
      `Saved artifact commit: ${stripeApprovalSourceCommit || "unknown"}`,
      `Current commit: ${localCommit || "unknown"}`,
      "",
      "Regenerate this artifact after live/current and buffer checks pass, before requesting Stripe smoke approval.",
    ].join("\n");

mkdirSync(outputDir, { recursive: true });

const packet = [
  "# SMIRK First-Dollar Approval Packet",
  "",
  `Generated: ${new Date().toISOString()}`,
  `Repo commit: ${deployBundle.sourceCommit || stripeApproval.sourceCommit || "unknown"}`,
  "",
  "## Purpose",
  "",
  "Move SMIRK closer to first dollar by proving paid checkout can hand off into activation without crossing any production write until Cameron explicitly approves it.",
  "",
  "## Business-Owner Decisions Before Real Sales",
  "",
  "Review and approve `docs/launch/first-dollar-policy-decisions.md` before enabling paid acquisition or accepting a real recurring checkout. It covers cancellation timing, refunds, usage enforcement, billing management, privacy/recording/retention, taxes, support ownership, and consent for the public proof workspace. Technical deploy or smoke approval does not approve those policies.",
  `Customer policy version recorded in live configuration: ${customerPolicyVersionRecorded ? customerPolicyVersion : "NOT_CONFIGURED"}`,
  `Customer policy approval marker ready: ${customerPolicyVersionRecorded ? "yes" : "no"}`,
  "Native Checkout Sessions and Payment Link subscriptions must carry this exact non-secret version in Stripe metadata.",
  "",
  "## First-Dollar Offer Configuration",
  "",
  "This first-dollar cutover requires one exact Starter URL + exact current `plink_` ID plus `STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS`.",
  "The fulfillment allowlist must include the current ID; exact prior Starter IDs may remain only when their hosted links are inactive. The setter rejects Pro or Enterprise inputs, always clears Pro and Enterprise URL + ID pairs, and forces native Checkout off.",
  "The exact Starter Payment Link must pass its live URL, `plink_` ID, active state, canonical $197 monthly price/product, required business-name and phone collection, customer-policy metadata, tax/Terms binding, and success-redirect checks before any Railway mutation.",
  "Railway variable clearing does not deactivate a hosted Stripe URL. The read-only exclusivity proof must show exactly one active SMIRK link: the reviewed Starter link, and must prove each allowlisted historical fulfillment ID is inactive. If it names old links, provider-side deactivation requires the separate exact-ID Approval 4A below.",
  "The dry run provider-verifies Starter and makes no Railway change. A non-dry-run write requires both `CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env` and `CONFIRM_SMIRK_REAL_STARTER_CHECKOUT=accept-buyer-initiated-starter-197-monthly`; neither token approves deploy, outreach, an operator-initiated charge, Pro, or Enterprise.",
  "",
  "```bash",
  "npm run -s check:railway:first-dollar-env",
  "```",
  "",
  "## Current Recommended Approval",
  "",
  deployRecommendation,
  "",
  `Git remote sync: ${gitRemoteSync}`,
  `Branch reconciliation required: ${requiresBranchReconcile ? "yes" : "no"}`,
  `Local branch: ${localBranch}`,
  `Local commit: ${localCommit || "unknown"}`,
  `Origin main commit: ${remoteMainCommit || "unknown"}`,
  `Stripe approval artifact commit: ${stripeApprovalSourceCommit || "unknown"}`,
  `Stripe approval artifact current: ${stripeApprovalMatchesLocalCommit ? "yes" : "no"}`,
  `Deploy state: ${deployState}`,
  `Deploy blocker detail: ${deployBlockerDetail}`,
  "",
  ...(requiresBranchReconcile
    ? [
        "## Approval 0: Branch Reconciliation",
        "",
        "This is the only safe next approval. It does not authorize deploy, Stripe smoke, cleanup apply, proof call, secret access, paid spend, or outreach.",
        "",
        `Approval token: \`${branchReconcileApprovalToken}\``,
        "",
        "To print the dedicated Approval 0 handoff, run:",
        "",
        "```bash",
        "npm run -s print:branch-reconcile-approval",
        "```",
        "",
        "Run the conflict forecast before branch reconciliation and respect a failure:",
        "",
        "```bash",
        branchConflictForecastCommand,
        "```",
        "",
        "Authorized command after Cameron approves the token:",
        "",
        "```bash",
        branchReconcileCommand,
        "```",
        "",
        "If rebase or `git stash pop` produces conflicts, stop and preserve the conflicted state for inspection. Do not deploy, run Stripe smoke, or run proof calls under branch-reconciliation approval.",
        "",
        "After synchronization, regenerate this packet and rerun deploy readiness before any production deploy approval.",
        "",
      ]
    : []),
  ...(requiresBranchReconcile
    ? [
        "Do not run a production deploy from this packet. Deploy approval comes only after branch synchronization and regenerated readiness pass.",
        "",
      ]
    : (deployApprovalNeeded
      ? [
        "```bash",
        deployCommand,
        "```",
        "",
        "After deploy, run `npm run -s check:ship-live`, then `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag`. Only then request separate approval for the signed Stripe webhook smoke, cleanup apply, and one pinned real proof call.",
        "",
      ]
      : [
        "Run these non-mutating checks before using the Stripe approval phrase:",
        "",
        "```bash",
        "npm run -s check:ship-live",
        "WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag",
        "npm run -s check:stripe-webhook-smoke-approval-ready",
        "```",
        "",
        "If those pass, request separate approval for the signed Stripe webhook smoke. Deploy approval is not needed while live remains current.",
        "",
      ])),
  "",
  "## Approval 1: Production Deploy",
  "",
  requiresBranchReconcile
    ? "Production deploy is not the next safe approval until the local branch is reconciled with origin/main and readiness is regenerated."
    : (deployApprovalNeeded
      ? "Deploy approval ships the pending proof-hardening bundle; it does not prove first-dollar readiness by itself."
      : "No production deploy approval is needed right now because live already matches the reviewed commit and the deploy-relevant working tree is clean."),
  "",
  ...(requiresBranchReconcile || !deployApprovalNeeded
    ? []
    : [
        `Approval token: \`${deployApprovalToken}\``,
        "",
        deployApprovalMeaning,
        "",
        ...(firstDollarBootstrapDeployRequired
          ? [
              `Bootstrap mode required by the reviewed command: \`${firstDollarBootstrapDeployMode}\``,
              "",
              firstDollarBootstrapDeployMeaning,
              "",
            ]
          : []),
      ]),
  ...(requiresBranchReconcile
    ? [
        "Deploy command intentionally withheld from the recommended action until synchronization is complete and this packet is regenerated.",
        "",
      ]
    : (deployApprovalNeeded
      ? [
        "```bash",
        deployCommand,
        "```",
        "",
      ]
      : [
        "Deploy command intentionally omitted from the recommended action because this packet is for the current live commit.",
        "",
      ])),
  `Deploy-relevant files covered: ${deployBundle.reviewFilesCount ?? deployBundle.deployRelevantDirtyFiles?.length ?? "unknown"}`,
  "",
  "## Approval 2: Stripe Webhook Smoke",
  "",
  "This is the next money-path proof after deploy and live checks. It may create production smoke provisioning/workspace state.",
  "",
  "```bash",
  stripeCommand,
  "```",
  "",
  "Approval phrase:",
  "",
  "```text",
  stripeApprovalPhrase,
  "```",
  "",
  "Expected after approval:",
  "",
  "- webhook response returns `received=true`",
  "- checkout-status finds the synthetic paid provisioning row",
  "- provisioning status is `workspace_created`, `workspace_and_line_created`, or `manual_fallback_required`",
  "- checkout-status returns public activation labels: `request_summary.status_label` and `next_step_label`",
  "- checkout-status acknowledges the checkout reference without exposing the raw Stripe checkout session ID",
  "- cleanup dry-run sees the created provisioning row before any cleanup apply",
  "",
  "## Approval 3: Smoke Cleanup Apply",
  "",
  "Cleanup is a production-data deletion. Review the smoke cleanup dry run first; the Stripe smoke approval does not authorize deletion.",
  "",
  "Exact approval phrase:",
  "",
  "```text",
  cleanupApprovalPhrase,
  "```",
  "",
  "## Approval 4: Live Railway Environment Write",
  "",
  "First run the all-at-once Starter-only setter with `--dry-run`, using secrets from the secure operator environment. Review its masked assignments and provider proof. Do not paste secrets into this packet or chat.",
  "",
  `Human approval phrase: \`${liveEnvApprovalPhrase}\``,
  `Machine confirmation required on the approved non-dry run: \`${liveEnvMachineConfirmation}\``,
  "",
  "This authority applies only the reviewed Railway variable set. It does not approve deployment, policy or price changes, Stripe smoke, cleanup, proof calls, outreach, accepting real checkout, or initiating a customer charge. If the write would make Starter checkout available, do not execute it under this approval alone; Approval 5 must also be present.",
  "",
  "## Approval 4A: Stripe Legacy Payment Link Deactivation (Conditional)",
  "",
  "Use this only if the read-only exclusivity check reports exact old SMIRK Payment Link IDs. It authorizes setting `active=false` for only those reviewed IDs. It does not authorize changing the approved Starter link, prices, products, policy, refunds, charges, or Railway variables.",
  "",
  `Exact-ID approval template: \`${legacyLinkDeactivationApprovalTemplate}\``,
  "",
  "After any approved deactivation, rerun `npm run -s check:first-dollar-payment-link-exclusivity` and require a pass before Approval 4 or Approval 5 is exercised.",
  "",
  "## Approval 5: Accept Real Starter Checkout",
  "",
  `Human approval phrase: \`${starterCheckoutApprovalPhrase}\``,
  `Machine confirmation required on the same approved non-dry run: \`${starterCheckoutMachineConfirmation}\``,
  "",
  "The operator must hold both Approval 4 and Approval 5 before running a live environment write that would open Starter checkout.",
  "",
  "Request this only after the owner-approved core policies are published, the exact Starter Payment Link and Billing Portal pass provider verification, live deployment is current, and the activation gates pass. It authorizes making the existing Starter offer available for buyer-initiated checkout; it does not authorize an operator to initiate a charge, change price or legal terms, enable Pro/Enterprise, run outreach, or spend money. The setter enforces both Approval 4 and Approval 5 machine confirmations before its one Starter-only Railway write.",
  "",
  "## Approval 6: One Pinned Real Proof Call",
  "",
  `Target-specific human approval phrase: \`${proofCallApprovalPhrase}\``,
  "",
  "After same-number readiness passes, run exactly one call with the approved E.164 number repeated privately in both confirmation positions:",
  "",
  "```bash",
  proofCallCommand,
  "```",
  "",
  "Readiness, deploy, Stripe smoke, environment-write, or checkout authority does not authorize a proof call.",
  "",
  "## Approval 7: Outreach Batch",
  "",
  `Required approval template: \`${outreachApprovalTemplate}\``,
  "",
  "The approval must identify the exact targets, channel, reviewed copy or immutable hash, and maximum batch count. Paid activation proof or an honestly disclosed manual fallback is only a prerequisite; neither automatically authorizes outreach. This packet never sends or queues outreach.",
  "",
  "## Stop Rules",
  "",
  "- Deploy approval does not authorize the signed Stripe webhook smoke.",
  "- Do not run the Stripe smoke without explicit approval.",
  "- Do not apply smoke cleanup before reviewing cleanup dry-run.",
  "- Do not apply confirmed smoke cleanup without separate explicit cleanup approval.",
  "- Do not deploy without explicit deploy approval.",
  "- Do not continue branch reconciliation after a failing conflict forecast or conflicted rebase/stash-pop without inspection.",
  "- Do not place a proof call without a same-number readiness pass and explicit call approval.",
  "- Do not send, queue, or begin outreach without a separate target/channel/copy/batch approval; proof or manual-fallback disclosure is not outreach authority.",
  "- Do not enable recurring real-customer checkout until the first-dollar policy decisions are explicitly approved and published consistently.",
  "- Do not accept real Starter checkout without the separate APPROVE_SMIRK_REAL_STARTER_CHECKOUT authority after live readiness passes.",
  "",
  "## After Approval Sequence",
  "",
  ...(deployApprovalNeeded
    ? [
      "1. If Cameron approves deploy, run only the deploy command, then run `npm run -s check:ship-live`.",
      "2. Run `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` so buffered Twilio events are not silently aging before proof.",
      "3. If post-deploy live and buffer lag checks pass, request separate approval for the signed Stripe smoke.",
      "4. If Cameron approves the Stripe smoke, run only the signed smoke command and inspect the result.",
      "5. If smoke rows are created, run cleanup dry-run only; stop before confirmed cleanup apply unless Cameron separately approves cleanup.",
      "6. After a masked provider-verified dry run, request the separate live environment-write approval; do not execute a write that opens checkout under that authority alone.",
      "7. After policy, provider, live, and activation gates pass, request the separate real Starter checkout approval. Only then may an operator holding both Approvals 4 and 5 apply the reviewed write that opens Starter checkout.",
      "8. Request target-specific approval for one pinned proof call, then use both exact machine confirmations with that same E.164 number.",
      "9. If outreach is desired, request a separate approval naming the exact targets, channel, reviewed copy, and batch count. Do not send or queue anything automatically.",
    ]
    : [
      "1. Run `npm run -s check:ship-live` and `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` to confirm live and buffer health.",
      "2. Run `npm run -s check:stripe-webhook-smoke-approval-ready` to confirm the signed Stripe smoke is still approval-ready.",
      "3. If Cameron approves the Stripe smoke, run only the signed smoke command and inspect the result.",
      "4. If smoke rows are created, run cleanup dry-run only; stop before confirmed cleanup apply unless Cameron separately approves cleanup.",
      "5. After a masked provider-verified dry run, request the separate live environment-write approval; do not execute a write that opens checkout under that authority alone.",
      "6. After policy, provider, live, and activation gates pass, request the separate real Starter checkout approval. Only then may an operator holding both Approvals 4 and 5 apply the reviewed write that opens Starter checkout.",
      "7. Request target-specific approval for one pinned proof call, then use both exact machine confirmations with that same E.164 number.",
      "8. If outreach is desired, request a separate approval naming the exact targets, channel, reviewed copy, and batch count. Do not send or queue anything automatically.",
    ]),
  "",
  "## Deploy Preflight Evidence Required",
  "",
  `Required passes: ${Array.isArray(deployBundle.deployPreflightRequiredPasses) && deployBundle.deployPreflightRequiredPasses.length
    ? deployBundle.deployPreflightRequiredPasses.join(", ")
    : "unknown"}.`,
  "",
  "## Source: Stripe Smoke Approval",
  "",
  stripeSourceNote,
  "",
  "## Source: Deploy Approval",
  "",
  deployNote,
  "",
].join("\n");

writeFileSync(targetPath, packet);

console.log(JSON.stringify({
  ok: true,
  path: targetPath,
  stripeCommand,
  deployCommand,
  deployRelevantFileCount: deployBundle.reviewFilesCount ?? null,
}, null, 2));
