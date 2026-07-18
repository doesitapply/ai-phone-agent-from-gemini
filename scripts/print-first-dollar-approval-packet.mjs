#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { evaluateCustomerPolicyApproval } from "../src/customer-policy-approval.js";
import { verifiedRailwayCustomerPolicyVersion } from "./lib/deploy-customer-policy-version.mjs";

const repoRoot = process.cwd();
const packetPath = path.join(repoRoot, "output", "first-dollar-approval-packet.md");
const policyDecisionPath = path.join(repoRoot, "docs", "launch", "first-dollar-policy-decisions.md");
const ownerDecisionCardStart = "<!-- SMIRK_OWNER_POLICY_DECISION_CARD_START -->";
const ownerDecisionCardEnd = "<!-- SMIRK_OWNER_POLICY_DECISION_CARD_END -->";

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

function runJson(cmd, args) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return JSON.parse(out);
  } catch (error) {
    const out = String(error?.stdout || error?.stderr || "").trim();
    try {
      return out ? JSON.parse(out) : { ok: false, error: "empty-output" };
    } catch {
      return { ok: false, error: "invalid-json-output", sample: out.slice(0, 500) };
    }
  }
}

if (!existsSync(packetPath)) {
  fail("missing first-dollar approval packet", {
    packetPath,
    nextAction: "Run npm run write:deploy-approval-bundle, then rerun npm run print:first-dollar-approval-packet.",
  });
}

const handoff = runJson("npm", ["run", "-s", "check:deploy-approval-handoff"]);
if (handoff.ok !== true) {
  fail("first-dollar approval packet is stale or unsafe to print", {
    packetPath,
    handoff,
    nextAction: "Run npm run write:deploy-approval-bundle, then rerun npm run print:first-dollar-approval-packet.",
  });
}

let deployBundle = {};
try {
  deployBundle = JSON.parse(readFileSync(path.join(repoRoot, "output", "deploy-approval-bundle.json"), "utf8"));
} catch {
  deployBundle = {};
}
function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
const localCommit = git(["rev-parse", "HEAD"]);
const remoteMainCommit = git(["rev-parse", "origin/main"]);
const mergeBaseMain = git(["merge-base", "HEAD", "origin/main"]);
const gitRemoteSync = localCommit && remoteMainCommit && mergeBaseMain
  ? (localCommit === remoteMainCommit
    ? "current"
    : (mergeBaseMain === remoteMainCommit ? "ahead" : (mergeBaseMain === localCommit ? "behind" : "diverged")))
  : "unknown";
const requiresBranchReconcile = gitRemoteSync === "behind" || gitRemoteSync === "diverged";

if (!existsSync(policyDecisionPath)) {
  fail("missing owner policy decision sheet", { policyDecisionPath });
}
const policyDecisionSheet = readFileSync(policyDecisionPath, "utf8");
const ownerDecisionCardStartIndex = policyDecisionSheet.indexOf(ownerDecisionCardStart);
const ownerDecisionCardEndIndex = policyDecisionSheet.indexOf(ownerDecisionCardEnd);
if (
  ownerDecisionCardStartIndex < 0
  || ownerDecisionCardEndIndex <= ownerDecisionCardStartIndex + ownerDecisionCardStart.length
) {
  fail("missing canonical owner policy decision card", { policyDecisionPath });
}
const ownerPolicyDecisionCard = policyDecisionSheet
  .slice(ownerDecisionCardStartIndex + ownerDecisionCardStart.length, ownerDecisionCardEndIndex)
  .trim();
const customerPolicyVersionEvidence = verifiedRailwayCustomerPolicyVersion(deployBundle);
const customerPolicyVersion = customerPolicyVersionEvidence.version;
const customerPolicyVersionRecorded = customerPolicyVersionEvidence.recorded;
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

const packet = readFileSync(packetPath, "utf8");
const stripeSmokeCommand = "ALLOW_AUTO_FULFILL_STRIPE_WEBHOOK_SMOKE=1 npm run check:stripe-webhook-handoff-live";
const stripeSmokeApprovalPhrase = `APPROVE_SMIRK_STRIPE_WEBHOOK_SMOKE: ${stripeSmokeCommand}`;
const smokeCleanupCommand = "APP_URL=https://www.smirkcalls.com CONFIRM_SMOKE_CLEANUP_APPLY=delete-smirk-smoke-records npm run cleanup:smoke-workspaces:apply";
const smokeCleanupApprovalPhrase = `APPROVE_SMIRK_SMOKE_CLEANUP_APPLY: ${smokeCleanupCommand}`;
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
const proofCallApprovalPhrase = "APPROVE_SMIRK_REAL_PROOF_CALL: <exact-approved-e164>";
const proofCallCommand = "CONFIRM_SMIRK_REAL_PROOF_CALL=place-one-smirk-real-proof-call CONFIRM_SMIRK_REAL_PROOF_CALL_TARGET='<exact-approved-e164>' npm run -s proof:real-call -- '<exact-approved-e164>'";
const outreachApprovalTemplate = "APPROVE_SMIRK_OUTREACH_BATCH: targets=<exact-list-or-ledger-ids>; channel=<exact-approved-channel>; copy=<exact-reviewed-template-or-hash>; batch=<exact-count>";
const deployPreflightRequiredPasses = Array.isArray(deployBundle.deployPreflightRequiredPasses)
  ? deployBundle.deployPreflightRequiredPasses
  : [];
const requiredPassesLine = deployPreflightRequiredPasses.length
  ? `Required passes: ${deployPreflightRequiredPasses.join(", ")}.`
  : null;
const expectedDeployStateLine = `Deploy state: ${deployBundle.deployState || "unknown"}`;
const liveAlreadyCurrent = deployBundle.deployState === "live-already-current" && deployBundle.liveFingerprintCurrent === true && deployBundle.localDeployClean === true;
const expectedFirstDollarBootstrapDeployMode = "SMIRK_FIRST_DOLLAR_ENV_BOOTSTRAP_DEPLOY=deploy-fail-closed-checkout";
if (deployBundle.firstDollarBootstrapDeployRequired === true) {
  const deployCommand = Array.isArray(deployBundle.approvalSteps)
    ? deployBundle.approvalSteps.find((step) => String(step).includes("npm run deploy:post-call-fix"))
    : null;
  if (
    deployBundle.firstDollarBootstrapDeployMode !== expectedFirstDollarBootstrapDeployMode
    || typeof deployCommand !== "string"
    || !deployCommand.includes(expectedFirstDollarBootstrapDeployMode)
    || !packet.includes(deployCommand)
  ) {
    fail("first-dollar approval packet dropped the required bootstrap-mode deploy command", {
      packetPath,
      expectedFirstDollarBootstrapDeployMode,
      deployCommand: deployCommand || null,
    });
  }
}
for (const required of [
  "## Current Recommended Approval",
  "## Business-Owner Decisions Before Real Sales",
  "docs/launch/first-dollar-policy-decisions.md",
  "Every blank means NOT APPROVED.",
  `Checked-in customer policy manifest state: ${customerPolicyEvaluation.manifestApprovalState}`,
  `Customer policy core readiness (manifest plus matching live-config version): ${customerPolicyCoreReady ? "yes" : "no"}`,
  `Customer policy core blockers remaining: ${customerPolicyCoreBlockerCount}`,
  `Railway production variables read succeeded: ${customerPolicyVersionEvidence.railwayReadSucceeded ? "yes" : "no"}`,
  `Customer policy version source: ${customerPolicyVersionEvidence.source || "UNVERIFIED"}`,
  `Customer policy version recorded in live configuration: ${customerPolicyVersionRecorded ? customerPolicyVersion : "NOT_CONFIGURED"}`,
  `Live configuration version matches the checked-in approved manifest: ${customerPolicyVersionMatches ? "yes" : "no"}`,
  "Native Checkout Sessions and Payment Link subscriptions must carry this exact non-secret version in Stripe metadata.",
  ownerPolicyDecisionCard,
  "## First-Dollar Offer Configuration",
  "This first-dollar cutover requires one exact Starter URL + exact current `plink_` ID plus `STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS`.",
  "The fulfillment allowlist must include the current ID; exact prior Starter IDs may remain only when their hosted links are inactive.",
  "The setter rejects Pro or Enterprise inputs, always clears Pro and Enterprise URL + ID pairs, and forces native Checkout off.",
  "required business-name and phone collection",
  "Railway variable clearing does not deactivate a hosted Stripe URL.",
  "The read-only exclusivity proof must show exactly one active SMIRK link: the reviewed Starter link, and must prove each allowlisted historical fulfillment ID is inactive.",
  "The dry run provider-verifies Starter and makes no Railway change.",
  "complete ordered unmasked assignment set without printing secrets",
  liveEnvMachineConfirmation,
  pendingEnvDigestMachineConfirmation,
  pendingEnvDigestSentinel,
  "with `--skip-deploys`, and does not expose checkout or require real-checkout authority",
  pendingEnvActivationInspectionCommand,
  activationDeployMachineConfirmation,
  "npm run -s check:railway:first-dollar-env",
  requiresBranchReconcile
    ? "Synchronize the local branch with origin/main before approving production deploy."
    : (liveAlreadyCurrent
      ? "Production is already current and the deploy-relevant working tree is clean. The next approval-gated money-path proof is the signed Stripe webhook smoke after live and buffer checks pass."
      : "Approve the production deploy first."),
  requiresBranchReconcile
    ? "After synchronization, regenerate this packet and rerun deploy readiness before any production deploy approval."
    : (liveAlreadyCurrent
      ? "If those pass, request separate approval for the signed Stripe webhook smoke. Deploy approval is not needed while live remains current."
      : (deployBundle.liveFingerprintCurrent === true
      ? "deploy-relevant local work is pending approval/shipping; running paid-path or proof-call checks before this deploy risks proving the wrong approval surface."
      : "production is stale; running paid-path or proof-call checks before deploy risks proving the wrong code.")),
  `Git remote sync: ${gitRemoteSync}`,
  ...(liveAlreadyCurrent && localCommit
    ? [
        `Stripe approval artifact commit: ${localCommit}`,
        "Stripe approval artifact current: yes",
        `Commit: ${localCommit}`,
      ]
    : ["Stripe approval artifact current:"]),
  expectedDeployStateLine,
  `Deploy blocker detail: ${deployBundle.blockerDetail || "Pending deploy approval is required before paid-path or proof-call checks."}`,
  "## Approval 1: Production Deploy",
  "## Approval 2: Stripe Webhook Smoke",
  "## Approval 3: Smoke Cleanup Apply",
  "## Approval 4: Stage Pending Live Railway Environment (No Deploy)",
  liveEnvApprovalPhrase,
  "This authority applies only the reviewed digest-bound Railway variable set.",
  "It does not restart production, expose checkout, or require real-checkout authority",
  "## Approval 4A: Stripe Legacy Payment Link Deactivation (Conditional)",
  legacyLinkDeactivationApprovalTemplate,
  "After any approved deactivation, rerun `npm run -s check:first-dollar-payment-link-exclusivity` and require a pass before staging or activation.",
  "## Approval 5: Deploy and Activate Real Starter Checkout",
  starterCheckoutApprovalPhrase,
  starterCheckoutMachineConfirmation,
  activationDeployApprovalPhrase,
  "existing deploy authority, exact commit, same digest, distinct activation-deploy authority, and real Starter checkout authority",
  "requires the new successful nonce-bound reviewed upload before live commit and ship checks may continue",
  "records the activated digest with `--skip-deploys` while preserving pending-manifest evidence",
  "## Approval 6: One Pinned Real Proof Call",
  proofCallApprovalPhrase,
  proofCallCommand,
  "Readiness, deploy, Stripe smoke, environment-write, or checkout authority does not authorize a proof call.",
  "## Approval 7: Outreach Batch",
  outreachApprovalTemplate,
  "This packet never sends or queues outreach.",
  "This is the next money-path proof after deploy and live checks.",
  stripeSmokeCommand,
  stripeSmokeApprovalPhrase,
  smokeCleanupApprovalPhrase,
  "Deploy approval does not authorize the signed Stripe webhook smoke.",
  "checkout-status acknowledges the checkout reference without exposing the raw Stripe checkout session ID",
  "Do not apply confirmed smoke cleanup without separate explicit cleanup approval.",
  "Do not place a proof call without a same-number readiness pass and explicit call approval.",
  "Do not send, queue, or begin outreach without a separate target/channel/copy/batch approval; proof or manual-fallback disclosure is not outreach authority.",
  "Do not enable recurring real-customer checkout until the first-dollar policy decisions are explicitly approved and published consistently.",
  "## After Approval Sequence",
  "## Deploy Preflight Evidence Required",
  ...(requiredPassesLine ? [requiredPassesLine] : ["Required passes:", "smirkOpsCopy"]),
  "If outreach is desired, request a separate approval naming the exact targets, channel, reviewed copy, and batch count. Do not send or queue anything automatically.",
  ...(requiresBranchReconcile
    ? [
        "## Approval 0: Branch Reconciliation",
        "This is the only safe next approval. It does not authorize deploy, Stripe smoke, cleanup apply, proof call, secret access, paid spend, or outreach.",
        "Approval token: `APPROVE_SMIRK_BRANCH_RECONCILE`",
        "npm run -s print:branch-reconcile-approval",
        "Run the conflict forecast before branch reconciliation and respect a failure:",
        "npm run -s check:branch-sync-conflict-forecast",
        "Authorized command after Cameron approves the token:",
        "If rebase or `git stash pop` produces conflicts, stop and preserve the conflicted state for inspection. Do not deploy, run Stripe smoke, or run proof calls under branch-reconciliation approval.",
        "Do not continue branch reconciliation after a failing conflict forecast or conflicted rebase/stash-pop without inspection.",
        "Do not run a production deploy from this packet. Deploy approval comes only after branch synchronization and regenerated readiness pass.",
        "Deploy command intentionally withheld from the recommended action until synchronization is complete and this packet is regenerated.",
      ]
    : (liveAlreadyCurrent
      ? [
        "Run these non-mutating checks before using the Stripe approval phrase:",
        "npm run -s check:ship-live",
        "WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag",
        "npm run -s check:stripe-webhook-smoke-approval-ready",
        "No production deploy approval is needed right now because live already matches the reviewed commit and the deploy-relevant working tree is clean.",
        "Deploy command intentionally omitted from the recommended action because this packet is for the current live commit.",
        "Run `npm run -s check:ship-live` and `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` to confirm live and buffer health.",
        "Run `npm run -s check:stripe-webhook-smoke-approval-ready` to confirm the signed Stripe smoke is still approval-ready.",
      ]
      : [
        "After deploy, run `npm run -s check:ship-live`, then `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag`.",
        "If Cameron approves deploy, run only the deploy command, then run `npm run -s check:ship-live`.",
        "Run `WEBHOOK_BUFFER_LAG_MAX_AGE_MINUTES=5 npm run -s check:webhook-buffer-lag` so buffered Twilio events are not silently aging before proof.",
        "If post-deploy live and buffer lag checks pass, request separate approval for the signed Stripe smoke.",
      ])),
]) {
  if (!packet.includes(required)) {
    fail("first-dollar approval packet is missing required approval language", {
      packetPath,
      required,
    });
  }
}

for (const forbidden of [
  "Begin outreach only after proof passes, or after the remaining manual fallback is written plainly into the offer.",
  "If the write would " + "make Starter checkout available",
  "setter enforces both Approval 4 " + "and Approval 5",
  "live environment write that would " + "open Starter checkout",
  "one Starter-only " + "Railway write",
]) {
  if (packet.includes(forbidden)) {
    fail("first-dollar approval packet contains automatic outreach authority", { packetPath, forbidden });
  }
}

process.stdout.write(packet.endsWith("\n") ? packet : `${packet}\n`);
