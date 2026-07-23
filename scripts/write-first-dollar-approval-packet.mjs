#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { evaluateCustomerPolicyApproval } from "../src/customer-policy-approval.js";
import { verifiedRailwayCustomerPolicyVersion } from "./lib/deploy-customer-policy-version.mjs";
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
const policyDecisionPath = path.join(repoRoot, "docs", "launch", "first-dollar-policy-decisions.md");
const ownerDecisionCardStart = "<!-- SMIRK_OWNER_POLICY_DECISION_CARD_START -->";
const ownerDecisionCardEnd = "<!-- SMIRK_OWNER_POLICY_DECISION_CARD_END -->";

const required = [
  ["Stripe smoke approval note", stripeNotePath],
  ["Stripe smoke approval JSON", stripeJsonPath],
  ["Deploy approval note", deployNotePath],
  ["Deploy approval bundle", deployBundlePath],
  ["Owner policy decision sheet", policyDecisionPath],
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
const policyDecisionSheet = readFileSync(policyDecisionPath, "utf8");
const ownerDecisionCardStartIndex = policyDecisionSheet.indexOf(ownerDecisionCardStart);
const ownerDecisionCardEndIndex = policyDecisionSheet.indexOf(ownerDecisionCardEnd);
if (
  ownerDecisionCardStartIndex < 0
  || ownerDecisionCardEndIndex <= ownerDecisionCardStartIndex + ownerDecisionCardStart.length
) {
  console.error(JSON.stringify({
    ok: false,
    error: "missing-canonical-owner-policy-decision-card",
    path: policyDecisionPath,
    nextAction: "Restore the canonical no-default owner decision card before regenerating the approval packet.",
  }, null, 2));
  process.exit(1);
}
const ownerPolicyDecisionCard = policyDecisionSheet
  .slice(ownerDecisionCardStartIndex + ownerDecisionCardStart.length, ownerDecisionCardEndIndex)
  .trim();

const stripeCommand = stripeApproval.commandToApprove || "ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live";
const stripeApprovalToken = stripeApproval.approvalToken || "APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE";
const stripeApprovalPhrase = `${stripeApprovalToken}: ${stripeCommand}`;
const cleanupApplyCommand = stripeApproval.cleanup?.applyCommand || "APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply";
const cleanupApprovalToken = stripeApproval.cleanupApprovalToken || "APPROVE_SMIRK_SMOKE_CLEANUP_APPLY";
const cleanupApprovalPhrase = `${cleanupApprovalToken}: ${cleanupApplyCommand}`;
const deployCommand = deployBundle.approvalSteps?.find((step) => step.includes("npm run deploy:post-call-fix")) || deployBundle.nextAction || "See deploy approval note.";
const deployApprovalToken = deployBundle.deployApprovalToken || "APPROVE_SMIRK_POST_CALL_FIX_DEPLOY";
const deployApprovalMeaning = deployBundle.deployApprovalMeaning || "Production deploy approval only. This does not authorize a Git push, Stripe smoke, cleanup apply, proof calls, secret access, paid spend, outreach, or activation of a staged first-dollar environment manifest; pending activation requires the exact staged digest plus distinct activation-deploy and real Starter checkout authority.";
const firstDollarBootstrapDeployRequired = deployBundle.firstDollarBootstrapDeployRequired === true;
const firstDollarBootstrapDeployMode = deployBundle.firstDollarBootstrapDeployMode || null;
const firstDollarBootstrapDeployMeaning = deployBundle.firstDollarBootstrapDeployMeaning || null;
const expectedFirstDollarBootstrapDeployMode = "SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY=deploy-fail-closed-checkout";
const pendingEnvDigestSentinel = "SMIRK_PENDING_FIRST_DOLLAR_ENV_DIGEST";
const liveEnvApprovalPhrase = "APPROVE_SMIRK_FIRST_DOLLAR_ENV_STAGE: digest=<exact-sha256-from-dry-run>; commit=<exact-head>; target=90599f03-6d6f-4044-8933-e0301be67a82/96bcd6e7-9487-4197-bcd1-a6bd0546e6b2/22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a; action=stage-with-skip-deploys-only";
const liveEnvMachineConfirmation = "CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env";
const pendingEnvDigestMachineConfirmation = "CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST=<exact-sha256-from-dry-run>";
const activationDeployApprovalPhrase = "APPROVE_SMIRK_FIRST_DOLLAR_ACTIVATION_DEPLOY: digest=<exact-staged-sha256>; commit=<exact-staged-commit>; target=90599f03-6d6f-4044-8933-e0301be67a82/96bcd6e7-9487-4197-bcd1-a6bd0546e6b2/22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a; action=deploy-and-activate-starter-197-only";
const activationDeployMachineConfirmation = "CONFIRM_SMIRK_FIRST_DOLLAR_ACTIVATION_DEPLOY=activate-reviewed-first-dollar-pending-env";
const pendingEnvActivationInspectionCommand = "npm run -s print:first-dollar-pending-env-activation";
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
const liveFirstDollarEnvReady = deployBundle.liveFirstDollarEnvReady === true;
const incompleteFirstDollarEnvRecommendation = "Production is current, but first-dollar checkout remains fail-closed. Complete the owner policy decision card and exact Starter-only Railway/Stripe configuration before requesting any Stripe write smoke.";
const incompleteFirstDollarEnvNextAction = "Do not request the signed Stripe smoke yet. First complete the canonical owner decision card, run `npm run -s check:railway:first-dollar-env`, and prepare a masked provider-verified `set:first-dollar-live-env -- --dry-run` for digest-bound review.";
const customerPolicyVersionEvidence = verifiedRailwayCustomerPolicyVersion(deployBundle);
const customerPolicyVersion = customerPolicyVersionEvidence.version;
const customerPolicyVersionRecorded = customerPolicyVersionEvidence.recorded;
const customerPolicyVersionRailwayReadSucceeded = customerPolicyVersionEvidence.railwayReadSucceeded;
const customerPolicyVersionSource = customerPolicyVersionEvidence.source;
const customerPolicyEvaluation = evaluateCustomerPolicyApproval(
  customerPolicyVersionRecorded ? customerPolicyVersion : "",
);
const customerPolicyCoreReady = customerPolicyVersionEvidence.provenanceVerified
  && customerPolicyEvaluation.coreReady === true;
const customerPolicyVersionMatches = customerPolicyVersionEvidence.provenanceVerified
  && customerPolicyEvaluation.versionMatches === true;
const customerPolicyCoreBlockerCount = Array.isArray(customerPolicyEvaluation.coreBlockers)
  ? customerPolicyEvaluation.coreBlockers.length
  : 0;

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
    ? (liveFirstDollarEnvReady
      ? "Production is already current and the deploy-relevant working tree is clean. The next approval-gated money-path proof is the signed Stripe webhook smoke after live and buffer checks pass."
      : incompleteFirstDollarEnvRecommendation)
    : (deployState === "pending-first-dollar-env-activation-deploy"
    ? "Approve the production deploy first. A digest-bound first-dollar manifest is staged, so use only the packet's complete exact activation command after the separate real Starter checkout and activation-deploy phrases are approved."
    : (deployState === "pending-local-deploy-work"
    ? (deployBundle.liveFingerprintCurrent === true
      ? `Approve the production deploy first. The local proof-hardening bundle is ready, live fingerprint is current, and deploy-relevant local work is pending approval/shipping; running paid-path or proof-call checks before this deploy risks proving the wrong approval surface.`
      : `Approve the production deploy first. The local proof-hardening bundle is ready, but production is stale; running paid-path or proof-call checks before deploy risks proving the wrong code.`)
    : `Approve the production deploy first. The local proof-hardening bundle is ready, but production is stale; running paid-path or proof-call checks before deploy risks proving the wrong code.`)));

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
  "Complete the canonical card from `docs/launch/first-dollar-policy-decisions.md` after qualified review and publication of the exact customer-facing documents. Every blank means NOT APPROVED. Technical deploy or smoke approval does not approve those policies.",
  `Checked-in customer policy manifest state: ${customerPolicyEvaluation.manifestApprovalState}`,
  `Customer policy core readiness (manifest plus matching live-config version): ${customerPolicyCoreReady ? "yes" : "no"}`,
  `Customer policy core blockers remaining: ${customerPolicyCoreBlockerCount}`,
  `Railway production variables read succeeded: ${customerPolicyVersionRailwayReadSucceeded ? "yes" : "no"}`,
  `Customer policy version source: ${customerPolicyVersionSource || "UNVERIFIED"}`,
  `Customer policy version recorded in live configuration: ${customerPolicyVersionRecorded ? customerPolicyVersion : "NOT_CONFIGURED"}`,
  `Live configuration version matches the checked-in approved manifest: ${customerPolicyVersionMatches ? "yes" : "no"}`,
  "Native Checkout Sessions and Payment Link subscriptions must carry this exact non-secret version in Stripe metadata.",
  "",
  ownerPolicyDecisionCard,
  "",
  "## First-Dollar Offer Configuration",
  "",
  "This first-dollar cutover requires one exact Starter URL + exact current `plink_` ID plus `STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS`.",
  "The fulfillment allowlist must include the current ID; exact prior Starter IDs may remain only when their hosted links are inactive. The setter rejects Pro or Enterprise inputs, always clears Pro and Enterprise URL + ID pairs, and forces native Checkout off.",
  "The exact Starter Payment Link must pass its live URL, `plink_` ID, active state, canonical $197 monthly price/product, required business-name and phone collection, customer-policy metadata, tax/Terms binding, and success-redirect checks before any Railway mutation.",
  "Railway variable clearing does not deactivate a hosted Stripe URL. The read-only exclusivity proof must show exactly one active SMIRK link: the reviewed Starter link, and must prove each allowlisted historical fulfillment ID is inactive. If it names old links, provider-side deactivation requires the separate exact-ID Approval 4A below.",
  "The dry run provider-verifies Starter and makes no Railway change.",
  `It computes a SHA-256 over the exact Railway target IDs, exact HEAD, and complete ordered unmasked assignment set without printing secrets. A non-dry-run staging write requires \`${liveEnvMachineConfirmation}\` plus \`${pendingEnvDigestMachineConfirmation}\`, saves \`${pendingEnvDigestSentinel}\` and its key-list/commit/schema sentinels with \`--skip-deploys\`, and does not expose checkout or require real-checkout authority.`,
  `Activation is a later deploy boundary. Run \`${pendingEnvActivationInspectionCommand}\` to recompute the staged manifest from the exact pinned Railway target. The complete activation command requires the same digest, exact commit, existing deploy authority, \`${activationDeployMachineConfirmation}\`, and \`${starterCheckoutMachineConfirmation}\`.`,
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
      : (liveFirstDollarEnvReady
        ? [
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
          ]
        : [
            incompleteFirstDollarEnvNextAction,
            "",
          ]))),
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
  "## Approval 4: Stage Pending Live Railway Environment (No Deploy)",
  "",
  "First run the all-at-once Starter-only setter with `--dry-run`, using secrets from the secure operator environment. Review its masked assignments, exact target, exact commit, complete ordered key list, assignment count, provider proof, and SHA-256. Do not paste secrets into this packet or chat.",
  "",
  `Human approval phrase: \`${liveEnvApprovalPhrase}\``,
  `Machine confirmations required on the approved non-dry staging run: \`${liveEnvMachineConfirmation}\` and \`${pendingEnvDigestMachineConfirmation}\``,
  "",
  `This authority applies only the reviewed digest-bound Railway variable set. The setter writes all assignments plus \`${pendingEnvDigestSentinel}\` and its exact key-list/commit/schema sentinels with \`--skip-deploys\`. It does not restart production, expose checkout, or require real-checkout authority, and it does not approve deployment, policy or price changes, Stripe smoke, cleanup, proof calls, outreach, or initiating a customer charge.`,
  "After staging, production is still running the prior deployment. Inspect the separately gated activation command only with `npm run -s print:first-dollar-pending-env-activation`.",
  "",
  "## Approval 4A: Stripe Legacy Payment Link Deactivation (Conditional)",
  "",
  "Use this only if the read-only exclusivity check reports exact old SMIRK Payment Link IDs. It authorizes setting `active=false` for only those reviewed IDs. It does not authorize changing the approved Starter link, prices, products, policy, refunds, charges, or Railway variables.",
  "",
  `Exact-ID approval template: \`${legacyLinkDeactivationApprovalTemplate}\``,
  "",
  "After any approved deactivation, rerun `npm run -s check:first-dollar-payment-link-exclusivity` and require a pass before staging or activation.",
  "",
  "## Approval 5: Deploy and Activate Real Starter Checkout",
  "",
  `Human approval phrase: \`${starterCheckoutApprovalPhrase}\``,
  `Exact digest-bound activation approval phrase: \`${activationDeployApprovalPhrase}\``,
  `Machine confirmations required on the activation deploy: \`${starterCheckoutMachineConfirmation}\`, \`${activationDeployMachineConfirmation}\`, and \`CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST=<exact-staged-sha256>\`, in addition to the existing exact-commit deploy confirmations printed by the inspection command.`,
  "",
  `Run \`${pendingEnvActivationInspectionCommand}\` after staging. It reads the exact pinned Railway target, recomputes every unmasked staged value in the recorded order, requires the recorded commit to equal current HEAD, and prints the complete command. Never reconstruct that command from memory.`,
  "",
  "Request this only after the owner-approved core policies are published, the exact Starter Payment Link and Billing Portal pass provider verification, the staged digest and exact commit are re-verified, and all activation gates pass. It authorizes one exact production deploy that activates the already staged Starter-only values for buyer-initiated checkout; it does not authorize an operator to initiate a charge, change price or legal terms, enable Pro/Enterprise, run outreach, or spend money. `deploy.sh` fails closed unless existing deploy authority, exact commit, same digest, distinct activation-deploy authority, and real Starter checkout authority are all present.",
  "Because staging requires a commit already live, activation can be a same-commit redeploy. Immediately before upload, `deploy.sh` captures the exact-target Railway deployment IDs and generates a one-use upload message bound to the exact commit, pending digest, and random nonce. It requires the new successful nonce-bound reviewed upload before live commit and ship checks may continue.",
  "After the exact deployment reaches live parity and the full ship check succeeds, the receipt command independently re-queries Railway for that exact successful nonce-bound deployment, reruns the full live ship gate, and re-reads the staged manifest. It records the activated digest with `--skip-deploys` while preserving pending-manifest evidence. It preserves all four pending-manifest sentinels as durable evidence. A direct or premature invocation fails closed; a restaged or drifted digest becomes pending again and requires fresh activation authority.",
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
  "- If a pending first-dollar manifest exists, ordinary deploy approval is insufficient; do not deploy without the exact digest-bound activation command printed by `npm run -s print:first-dollar-pending-env-activation`.",
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
      "6. After a masked provider-verified dry run, approve the exact digest and stage the pending values with `--skip-deploys`; this does not expose checkout and does not require real-checkout authority.",
      "7. Run `npm run -s print:first-dollar-pending-env-activation`, review the recomputed digest/commit/target, and request both real Starter checkout and exact activation-deploy authority. Use only the complete printed deploy command.",
      "8. Request target-specific approval for one pinned proof call, then use both exact machine confirmations with that same E.164 number.",
      "9. If outreach is desired, request a separate approval naming the exact targets, channel, reviewed copy, and batch count. Do not send or queue anything automatically.",
    ]
    : [
      "1. Run `npm run -s check:ship-live` and `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` to confirm live and buffer health.",
      "2. Run `npm run -s check:stripe-webhook-smoke-approval-ready` to confirm the signed Stripe smoke is still approval-ready.",
      "3. If Cameron approves the Stripe smoke, run only the signed smoke command and inspect the result.",
      "4. If smoke rows are created, run cleanup dry-run only; stop before confirmed cleanup apply unless Cameron separately approves cleanup.",
      "5. After a masked provider-verified dry run, approve the exact digest and stage the pending values with `--skip-deploys`; this does not expose checkout and does not require real-checkout authority.",
      "6. Run `npm run -s print:first-dollar-pending-env-activation`, review the recomputed digest/commit/target, and request both real Starter checkout and exact activation-deploy authority. Use only the complete printed deploy command.",
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
