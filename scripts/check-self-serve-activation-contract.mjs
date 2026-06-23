#!/usr/bin/env node
import fs from "node:fs";

const server = fs.readFileSync("server.ts", "utf8");
const saas = fs.readFileSync("src/saas.ts", "utf8");
const workspaceActivationRoutes = fs.readFileSync("src/routes/workspace-activation-routes.ts", "utf8");
const workspaceProfileRoutes = fs.readFileSync("src/routes/workspace-profile-routes.ts", "utf8");
const provisioningRoutes = fs.readFileSync("src/routes/provisioning-routes.ts", "utf8");
const buyerRoutes = fs.readFileSync("src/routes/buyer-routes.ts", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const wizard = fs.readFileSync("src/components/SetupWizard.tsx", "utf8");
const stripeSmoke = fs.readFileSync("scripts/check-stripe-webhook-handoff-live.mjs", "utf8");
const cleanup = fs.readFileSync("scripts/cleanup-smoke-workspaces.mjs", "utf8");

const failures = [];
function expect(label, condition) {
  if (!condition) failures.push(label);
}

for (const field of ["service_area", "escalation_preference", "proof_call_target"]) {
  expect(`workspace schema has ${field}`, saas.includes(`ADD COLUMN IF NOT EXISTS ${field}`));
  expect(`workspace type has ${field}`, saas.includes(`${field}?: string`));
  expect(`profile write whitelist includes ${field}`, workspaceProfileRoutes.includes(`"${field}"`));
  expect(`setup wizard captures ${field}`, wizard.includes(field));
  expect(`settings profile captures ${field}`, app.includes(field));
}

expect("server builds setup readiness", server.includes("const buildSetupReadiness ="));
expect("server builds activation status", server.includes("const buildActivationStatus ="));
expect("workspace profile returns activation_status", workspaceProfileRoutes.includes("activation_status: activationStatus"));
expect("workspace activation status endpoint exists", workspaceActivationRoutes.includes('app.get("/api/workspace/activation-status", dashboardAuth'));
expect("workspace proof-call request endpoint exists", workspaceActivationRoutes.includes('app.post("/api/workspace/proof-call/request", dashboardAuth'));
expect("workspace proof-call request records activation event", workspaceActivationRoutes.includes("createActivationEvent") && workspaceActivationRoutes.includes("proof_call_requested"));
expect("workspace proof-call request keeps guarded proof command order", workspaceActivationRoutes.includes("First run npm run check:real-call-readiness -- <safe-number>; only after readiness passes, run npm run proof:real-call -- <safe-number>."));
expect("workspace activation events endpoint exists", workspaceActivationRoutes.includes('app.get("/api/workspace/activation-events", dashboardAuth'));
expect("activation events table exists", saas.includes("CREATE TABLE IF NOT EXISTS activation_events"));
expect("activation events helper exists", saas.includes("export async function createActivationEvent"));
expect("activation events dedupe helper exists", saas.includes("export async function createActivationEventIfChanged"));
expect("checkout writes activation events", saas.includes('event_type: "checkout_completed"') && saas.includes('event_type: "workspace_created"'));
expect("checkout session posts activation success URL", buyerRoutes.includes('success_url: `${publicAppUrl}/success?session_id={CHECKOUT_SESSION_ID}`'));
expect("checkout session posts pricing cancel URL", buyerRoutes.includes('cancel_url: `${publicAppUrl}/pricing`'));
expect("checkout session carries buyer activation metadata", buyerRoutes.includes("metadata: {") && buyerRoutes.includes("business_name: businessName") && buyerRoutes.includes("owner_email: ownerEmail") && buyerRoutes.includes("owner_phone: ownerPhone"));
expect("checkout subscription carries buyer activation metadata", buyerRoutes.includes("subscription_data:") && buyerRoutes.includes("metadata: {") && buyerRoutes.includes("business_name: businessName") && buyerRoutes.includes("owner_email: ownerEmail") && buyerRoutes.includes("owner_phone: ownerPhone"));
expect("stripe webhook consumes checkout owner email metadata before Stripe fallbacks", saas.includes('metadata.owner_email || session.customer_details?.email || session.customer_email || ""'));
expect("stripe webhook consumes checkout business metadata before Stripe name fallback", saas.includes('metadata.business_name || session.customer_details?.name || ownerEmail || "Paid SMIRK Workspace"'));
expect("stripe webhook consumes checkout owner phone metadata before Stripe phone fallback", saas.includes('metadata.owner_phone || session.customer_details?.phone || ""'));
expect("stripe webhook normalizes metadata plan", saas.includes("const plan = normalizePlan(metadata.plan);"));
expect("stripe webhook creates manual fallback when owner email is missing", saas.includes("Paid checkout completed without an owner email.") && saas.includes('event: "stripe_missing_owner_email"'));
expect("stripe webhook is idempotent by checkout request id", saas.includes("WHERE request_id = ${requestId}") && saas.includes("if (existingByRequest.length > 0) return;"));
expect("operator exceptions write activation events", saas.includes('event_type: "operator_exception"'));
expect("setup completion writes activation event", workspaceProfileRoutes.includes('event_type: "setup_completed"'));
expect("activation status records stage events", server.includes("recordActivationStageEvent") && server.includes('event_type: eventType'));
expect("checkout-status returns activation_status", provisioningRoutes.includes("activation_status: publicActivationStatus"));
expect("checkout-status returns public request summary", provisioningRoutes.includes("request_summary: requestSummary"));
expect("checkout-status returns public request status label", provisioningRoutes.includes("status_label: formatPublicProvisioningStatus(row.status)") && provisioningRoutes.includes("function formatPublicProvisioningStatus"));
expect("checkout-status returns public next-step label", provisioningRoutes.includes("next_step_label: formatPublicProvisioningNextStep(nextStep)") && provisioningRoutes.includes("function formatPublicProvisioningNextStep"));
expect("checkout-status not-found returns public status label", provisioningRoutes.includes("status_label: formatPublicProvisioningStatus('not_found')"));
expect("checkout-status does not return raw provisioning request", !provisioningRoutes.includes("request: row"));
expect("checkout-status uses blank workspace API key for public activation status", provisioningRoutes.includes('api_key: ""'));
expect("checkout-status strips public invite link from activation status", provisioningRoutes.includes("inviteLink: null"));
expect("checkout-status strips public workspace id from activation status", provisioningRoutes.includes("workspaceId: null"));
expect("checkout-status strips public internal exception reason from activation status", provisioningRoutes.includes("exceptionReason: null"));
const publicRequestStart = provisioningRoutes.indexOf('app.post("/api/provisioning/request"');
const publicRequestEnd = provisioningRoutes.indexOf('app.post("/api/provisioning/checkout-status"');
const publicRequestBlock = publicRequestStart >= 0 && publicRequestEnd > publicRequestStart
  ? provisioningRoutes.slice(publicRequestStart, publicRequestEnd)
  : "";
const publicBookStart = app.indexOf("function PublicBookPage()");
const publicLandingStart = app.indexOf("function PublicLandingPage()");
const publicCompareStart = app.indexOf("function PublicComparePage()");
const publicBookBlock = publicBookStart >= 0 && publicLandingStart > publicBookStart
  ? app.slice(publicBookStart, publicLandingStart)
  : "";
const publicLandingBlock = publicLandingStart >= 0 && publicCompareStart > publicLandingStart
  ? app.slice(publicLandingStart, publicCompareStart)
  : "";
expect("public activation request route found", Boolean(publicRequestBlock));
expect("public activation request does not return invite links", !publicRequestBlock.includes("invite_link: inviteLink"));
expect("public activation request does not return workspace API keys", !publicRequestBlock.includes("workspace_api_key: workspace.api_key") && !publicRequestBlock.includes("api_key: workspace.api_key"));
expect("public activation request points to owner email when invite exists", publicRequestBlock.includes("invite_available: true") && publicRequestBlock.includes("next_step: 'check_owner_email'"));
expect("public activation form does not read raw invite link response", !app.includes("inviteLink: body.invite_link"));
expect("public status lookup does not read raw invite link in app", !app.includes("body.request?.invite_link"));
expect("public setup and activation pages do not render invite links", Boolean(publicBookBlock) && Boolean(publicLandingBlock) && !publicBookBlock.includes("submitState.inviteLink") && !publicLandingBlock.includes("submitState.inviteLink") && !publicLandingBlock.includes("lookupState.inviteLink"));
expect("public book page routes setup through activation status", publicBookBlock.includes("activation status, or setup help") && publicBookBlock.includes("Check the owner email for the next activation step") && !publicBookBlock.includes("checkout, invite access, or setup help"));
expect("public activation next-step copy uses owner email instead of invite links", publicLandingBlock.includes("email the owner address with the next activation step") && !publicLandingBlock.includes("email your next step or invite link"));
expect("public status lookup points invite-ready buyers to activation step", publicLandingBlock.includes("check the owner email for the next activation step") && !publicLandingBlock.includes("check the owner email for your invite"));
expect("public status lookup formats internal request status tokens", app.includes("function formatPublicActivationStatus") && app.includes("Setup needs operator follow-up") && app.includes("Workspace setup is running"));
expect("public status lookup formats internal next-step tokens", app.includes("function formatPublicActivationNextStep") && app.includes("Check the owner email for the next activation step.") && app.includes("SMIRK needs operator follow-up before the workspace is ready."));
expect("public status lookup prefers API-provided public labels", app.includes("body.request_summary?.status_label || formatPublicActivationStatus(currentStatus)") && app.includes("body.next_step_label || formatPublicActivationNextStep(nextStep)"));
expect("public status lookup renders buyer-legible status copy", publicLandingBlock.includes("Status: ${statusLabel}. Next: ${nextStepLabel}") && !publicLandingBlock.includes("Status: ${currentStatus}"));
expect("public owner email field uses activation language", publicLandingBlock.includes("Owner email for updates and activation") && !publicLandingBlock.includes("Owner email for updates and invite access"));
expect("public status helper points to activation step", publicLandingBlock.includes("owner email for the next activation step") && !publicLandingBlock.includes("owner email for the invite"));
expect("public status checker does not promise to show invite links", !app.includes("we’ll show your invite link here"));
expect("login copy does not route invite access through status checker", !app.includes("from your email or the status checker"));
expect("workspace credentials are not accepted from URL query params", !app.includes('params.get("workspaceKey")') && !app.includes('params.get("apiKey")') && !app.includes('params.get("workspaceId")'));
expect("invite route parses token once", (app.match(/const token = pathname\.split\("\/invite\/"\)\[1\]\?\.split\("\/"\)\[0\]\?\.trim\(\);/g) || []).length === 1);
expect("operator queue exposes activation_stage", provisioningRoutes.includes("activation_stage: activationStage"));
expect("activation status includes proof-ready guard", server.includes("readyForProofCall"));
expect("activation status requires owner alert readiness", server.includes("ownerAlertReady"));
expect("activation status requires callback readiness", server.includes("callbackReady"));
expect("signed webhook smoke checks activation status", stripeSmoke.includes("activation_status"));
expect("signed webhook smoke checks public status labels", stripeSmoke.includes("request.status_label") && stripeSmoke.includes("statusBody.next_step_label"));
expect("signed webhook smoke treats public workspace id as a leak", stripeSmoke.includes("statusBody.activation_status?.workspaceId"));
expect("signed webhook smoke treats public exception reason as a leak", stripeSmoke.includes("statusBody.activation_status?.exceptionReason"));
expect("signed webhook smoke treats public request id as a leak", stripeSmoke.includes("request.id ||"));
expect("signed webhook smoke treats public Stripe event id as a leak", stripeSmoke.includes("request.request_id ||"));
expect("signed webhook smoke output reports request id exposure without echoing it", stripeSmoke.includes("request_id_exposed: Boolean(request.id)") && !stripeSmoke.includes("request_id: request.id"));
expect("signed webhook smoke uses cleanup-addressable smoke identity", stripeSmoke.includes("smoke+stripe-") && stripeSmoke.includes("SMIRK Stripe Webhook Smoke"));
expect("cleanup smoke helper exists", cleanup.includes("/api/admin/cleanup-smoke-workspaces"));

if (failures.length > 0) {
  console.error("FAIL self-serve activation contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK self-serve activation contract covers paid workspace, setup fields, activation status, proof readiness, and smoke cleanup hooks");
