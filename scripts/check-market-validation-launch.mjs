#!/usr/bin/env node
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const failures = [];

function expect(label, condition) {
  if (!condition) failures.push(label);
}

function componentSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) return "";
  return source.slice(start, end);
}

function csvRows(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

const app = read("src/App.tsx");
const server = read("server.ts");
const db = read("src/db.ts");
const buyerRoutes = read("src/routes/buyer-routes.ts");
const launchRoutes = read("src/routes/launch-routes.ts");
const launchApproval = read("src/launch-approval.ts");
const telegramApprovalRoutes = read("src/routes/telegram-approval-routes.ts");
const packageJson = read("package.json");
const marketStatusScript = read("scripts/check-market-validation-status.mjs");
const launchSegmentDecisionScript = read("scripts/check-launch-segment-decisions.mjs");
const analyticsSmokeScript = read("scripts/check-launch-analytics-smoke.mjs");
const importScript = read("scripts/import-launch-ledger-csv.mjs");
const launchProspectReadinessScript = read("scripts/check-launch-prospect-readiness.mjs");
const launchProspectReadinessFixtures = read("scripts/check-launch-prospect-readiness-fixtures.mjs");
const launchProspectReadinessHelper = read("scripts/lib/launch-prospect-readiness.mjs");
const launchLedgerReconciliationHelper = read("scripts/lib/launch-ledger-reconciliation.mjs");
const launchLedgerReconciliationFixtures = read("scripts/check-launch-ledger-reconciliation-fixtures.mjs");
const launchAssetScript = read("scripts/capture-launch-assets.mjs");
const launchProtectedAssetScript = read("scripts/capture-launch-protected-assets.mjs");
const launchWalkthroughScript = read("scripts/capture-launch-walkthrough.mjs");
const launchTouchPacketScript = read("scripts/write-launch-touch-packet.mjs");
const launchTouchExecutionScript = read("scripts/check-launch-touch-execution.mjs");
const launchTouchExecutionImportScript = read("scripts/import-launch-touch-execution.mjs");
const launchTouchApprovalHelper = read("scripts/lib/launch-touch-approval.mjs");
const launchTouchApprovalFixtures = read("scripts/check-launch-touch-approval-integrity-fixtures.mjs");
const telegramApprovalSafetyScript = read("scripts/check-telegram-approval-safety.ts");
const launchDoc = read("docs/SMIRK_30_DAY_MARKET_VALIDATION_GOAL.md");
const historicalOutreachPlaybook = read("docs/AI_SALES_OUTREACH_PLAYBOOK.md");
const ledger = read("docs/launch/traction-ledger-template.csv");
const prospectBatch = read("docs/launch/prospect-batch-001-reno.csv");
const prospectBatch2 = read("docs/launch/prospect-batch-002-sacramento.csv");
const prospectBatch3 = read("docs/launch/prospect-batch-003-boise.csv");
const prospectBatch4 = read("docs/launch/prospect-batch-004-reno-expansion.csv");
const prospectBatch5 = read("docs/launch/prospect-batch-005-sacramento-expansion.csv");
const prospectBatch6 = read("docs/launch/prospect-batch-006-boise-expansion.csv");
const prospectBatch7 = read("docs/launch/prospect-batch-007-salt-lake-expansion.csv");
const prospectBatch8 = read("docs/launch/prospect-batch-008-fresno-expansion.csv");
const contentCalendar = read("docs/launch/content-calendar.csv");
const productHunt = read("docs/launch/product-hunt-kit.md");
const platformKit = read("docs/launch/platform-submission-kit.md");
const platformTracker = read("docs/launch/platform-submission-tracker.csv");
const platformTrackerScript = read("scripts/check-platform-submission-tracker.mjs");
const outboundPlaybook = read("docs/launch/manual-outbound-playbook.md");
const competitorMatrix = read("docs/launch/competitive-positioning-matrix.md");
const paidBrief = read("docs/launch/paid-test-brief.md");
const paidTracker = read("docs/launch/paid-test-tracker.csv");
const paidTrackerScript = read("scripts/check-paid-test-tracker.mjs");
const billingLifecycleScript = read("scripts/check-billing-lifecycle-contract.mjs");
const socialPostPack = read("docs/launch/social-post-pack.md");
const smsRunbook = read("docs/launch/sms-guarded-enablement-runbook.md");
const smsGuardrailScript = read("scripts/check-sms-guardrails-contract.mjs");
const smsGuardrails = read("src/sms-guardrails.ts");
const publicLaunchPage = componentSource(app, "function PublicLaunchPage()", "function PublicIndustryPage");
const operatorLaunchPage = app.slice(app.indexOf("function LaunchSprintPage()"));
const proofRoutes = read("src/routes/proof-routes.ts");
const publicLandingPage = componentSource(app, "function PublicLandingPage()", "function PublicComparePage()");

expect("public launch page component exists", app.includes("function PublicLaunchPage()"));
expect("public /launch route is wired", app.includes('pathname === "/launch"') && app.includes("<PublicLaunchPage />"));
expect("public navigation links to buyer proof", app.includes('href="/launch"') && app.includes(">Proof</a>"));
expect("public launch page is buyer-facing proof", publicLaunchPage.includes("Buyer-facing proof loop") && publicLaunchPage.includes("See how a missed call becomes a callback-ready job record."));
expect("public launch page preserves human control", publicLaunchPage.includes("SMIRK works alongside the people already running the business.") && publicLaunchPage.includes("Your team decides what happens next."));
expect("public launch page uses designated proof snapshot", publicLaunchPage.includes('fetch("/api/public-proof-snapshot")') && publicLaunchPage.includes("Complete proof loops"));
expect("public launch page labels designated proof honestly", publicLaunchPage.includes("explicitly designated proof workspace") && publicLaunchPage.includes("not a revenue, conversion, or customer-savings claim"));
expect("public dashboard preview is explicitly illustrative", app.includes("Illustrative example") && app.includes("Fictional example data") && !app.includes(">Live demo</"));
expect("public proof never falls back to a customer workspace", proofRoutes.includes("PUBLIC_PROOF_WORKSPACE_ID || 0") && !proofRoutes.includes("PUBLIC_PROOF_WORKSPACE_ID || process.env.DEFAULT_WORKSPACE_ID") && proofRoutes.includes('source: "designated-proof-workspace"'));
expect("public launch page excludes cold texting and phone spam", publicLaunchPage.includes("No cold SMS, no automated phone spam"));
expect("public launch page excludes internal validation targets", !publicLaunchPage.includes("30-day market validation") && !publicLaunchPage.includes("500 touches + $500 spend") && !publicLaunchPage.includes("Product Hunt") && !publicLaunchPage.includes("AppSumo"));
expect("operator launch page retains internal validation plan", operatorLaunchPage.includes("30-day home-services validation ledger") && operatorLaunchPage.includes("Target: {item.target}") && operatorLaunchPage.includes("Manual touch workbench"));
expect("operator launch page retains outreach guardrails", operatorLaunchPage.includes("No automated sends") && operatorLaunchPage.includes("No cold SMS") && operatorLaunchPage.includes("Touch logs after human action"));
expect("first-dollar strategy is Starter-only", launchDoc.includes("First-dollar operating scope: Starter only") && launchDoc.includes("Keep Pro and Agency/Enterprise checkout disabled"));
expect("manual outbound revenue goal is Starter-only", outboundPlaybook.includes("1 paid Starter $197/month activation") && !outboundPlaybook.includes("1 paid Starter or Pro activation"));
expect("historical outreach snapshot cannot be quoted as current", historicalOutreachPlaybook.includes("Historical reference only") && historicalOutreachPlaybook.includes("do not execute or quote") && historicalOutreachPlaybook.includes("do not reuse as current evidence"));
expect("public launch page tracks page view", publicLaunchPage.includes('trackLaunchEvent("launch_page_view"'));
expect("public landing page tracks page view", app.includes('trackLaunchEvent("landing_page_view"'));
expect("public pricing page tracks page view", app.includes('trackLaunchEvent("pricing_page_view"'));
expect("public launch page tracks CTA clicks", app.includes('trackLaunchEvent("cta_clicked"'));
expect("public checkout flow tracks checkout starts", app.includes('trackLaunchEvent("checkout_started"'));
expect("public checkout carries launch attribution into checkout create", app.includes("const attribution = getLaunchAttribution()") && app.includes("source: attribution.source || 'public_landing'") && app.includes("campaign: attribution.campaign") && app.includes("page_path: attribution.page_path"));
expect("buyer checkout metadata preserves campaign attribution", buyerRoutes.includes("const checkoutMetadata: Record<string, string>") && buyerRoutes.includes('addMetadataValue(checkoutMetadata, "campaign"') && buyerRoutes.includes('addMetadataValue(checkoutMetadata, "page_path"') && buyerRoutes.includes("subscription_data") && buyerRoutes.includes("metadata: checkoutMetadata"));
const paidCheckoutAttempt = publicLandingPage.indexOf("await startCheckout(selected, { businessName, ownerEmail, ownerPhone })");
const manualFallbackCapture = publicLandingPage.indexOf("const body = await captureProvisioningRequest();", paidCheckoutAttempt);
expect("paid landing funnel attempts Stripe before creating manual fallback work", paidCheckoutAttempt >= 0 && manualFallbackCapture > paidCheckoutAttempt && publicLandingPage.includes("if (selected && !promoApplied)"));

expect("launch events schema exists", db.includes("CREATE TABLE IF NOT EXISTS launch_events"));
expect("launch events schema indexes event source", db.includes("idx_launch_events_name_source"));
expect("launch ledger schema exists", db.includes("CREATE TABLE IF NOT EXISTS launch_ledger"));
expect("launch ledger schema indexes state", db.includes("idx_launch_ledger_state"));
expect("launch outreach approvals schema exists", db.includes("CREATE TABLE IF NOT EXISTS launch_outreach_approvals"));
expect("launch outreach approvals use opaque approval id", db.includes("approval_id                   TEXT UNIQUE NOT NULL"));
expect("launch outreach approvals distinguish prepared approved sending sent failed", db.includes("'PREPARED', 'APPROVED', 'SENDING', 'SENT', 'FAILED'"));
expect("launch outreach approval audit schema exists", db.includes("CREATE TABLE IF NOT EXISTS launch_outreach_approval_audit"));
expect("launch outreach approval audit records actor and payload hash", db.includes("actor_telegram_user_id") && db.includes("actor_chat_id") && db.includes("payload_hash") && db.includes("intended_action"));
expect("launch routes are registered", server.includes("registerLaunchRoutes(app"));
expect("telegram approval routes are registered", server.includes("registerTelegramApprovalRoutes(app"));
expect("telegram approval env keys are recognized", server.includes("TELEGRAM_WEBHOOK_SECRET") && server.includes("TELEGRAM_ALLOWED_USER_IDS") && server.includes("TELEGRAM_ALLOWED_CHAT_IDS"));
expect("public launch tracking endpoint exists", launchRoutes.includes('app.post("/api/launch/events"'));
expect("operator launch summary endpoint exists", launchRoutes.includes('app.get("/api/launch/summary"') && launchRoutes.includes("dashboardAuth") && launchRoutes.includes("requireOperator"));
expect("operator launch ledger list endpoint exists", launchRoutes.includes('app.get("/api/launch/ledger"') && launchRoutes.includes("dashboardAuth") && launchRoutes.includes("requireOperator"));
expect("operator launch ledger create endpoint exists", launchRoutes.includes('app.post("/api/launch/ledger"') && launchRoutes.includes("dashboardAuth") && launchRoutes.includes("requireOperator"));
expect("operator launch ledger update endpoint exists", launchRoutes.includes('app.patch("/api/launch/ledger/:id"') && launchRoutes.includes("dashboardAuth") && launchRoutes.includes("requireOperator"));
expect("operator launch summary exposes spend gate", launchRoutes.includes("spend_gate") && launchRoutes.includes("paid_spend_allowed: false"));
expect("operator launch summary exposes traction hard-stop metrics", launchRoutes.includes("qualified_conversations") && launchRoutes.includes("proof_walkthroughs") && launchRoutes.includes("paid_activations") && launchRoutes.includes("negative_signal"));
expect("launch tracking allows checkout started", launchRoutes.includes('"checkout_started"'));
expect("launch tracking avoids raw buyer email fields", !/owner_email|buyer_email|email_address/.test(launchRoutes));
expect("operator launch sprint page exists", app.includes("function LaunchSprintPage()"));
expect("operator launch sprint route is wired", app.includes("<LaunchSprintPage />") && app.includes('launch: "/dashboard/launch"'));
expect("operator launch sprint reads ledger API", app.includes('"/api/launch/ledger?days=30&limit=200"') && app.includes('"/api/launch/ledger"'));
expect("operator launch sprint displays paid activation metric", app.includes("paid_activations"));
expect("operator launch sprint default prospect form starts at zero touches", app.includes('touch_count: "0"') && app.includes('next_state: "researched"'));
expect("operator launch sprint has manual touch workbench", app.includes("Manual touch workbench") && app.includes("researched prospects are ready for human-reviewed contact-form, email, or LinkedIn touches"));
expect("operator launch sprint extracts public source and contact urls", app.includes('launchNoteValue(row.notes, "contact_url")') && app.includes('launchNoteValue(row.notes, "source_url")'));
expect("operator launch sprint copies outreach drafts only", app.includes("buildLaunchManualTouchDraft") && app.includes("navigator.clipboard.writeText(buildLaunchManualTouchDraft(row))") && app.includes("Copy draft"));
expect("operator launch sprint logs touches only after human action", app.includes("Log human touch") && app.includes("send_mode=human_manual") && app.includes('next_state: "contacted"'));
expect("operator launch sprint does not auto-send outreach", !/sendEmail|submitContactForm|autoSendOutreach|sendSms|sendSMS/.test(app));
expect("market validation status package script exists", packageJson.includes('"check:market-validation-status": "node scripts/check-market-validation-status.mjs"'));
expect("launch segment decision package script exists", packageJson.includes('"check:launch-segment-decisions": "node scripts/check-launch-segment-decisions.mjs"'));
expect("billing lifecycle package script exists", packageJson.includes('"check:billing-lifecycle": "node scripts/check-billing-lifecycle-contract.mjs"'));
expect("billing lifecycle check covers payment failure, cancellation, and refund", billingLifecycleScript.includes("invoice.payment_failed") && billingLifecycleScript.includes("customer.subscription.deleted") && billingLifecycleScript.includes("charge.refunded"));
expect("billing lifecycle check is non-mutating", billingLifecycleScript.includes("static and non-mutating"));
expect("market validation status script checks live parity", marketStatusScript.includes("check:live-is-current"));
expect("market validation status script checks failed deploys", marketStatusScript.includes("check:latest-failed-deploy"));
expect("market validation status script reads launch summary", marketStatusScript.includes("/api/launch/summary"));
expect("market validation status script reads launch ledger", marketStatusScript.includes("/api/launch/ledger"));
expect("market validation status script avoids printing ledger rows", marketStatusScript.includes("Ledger row details are intentionally omitted"));
expect("market validation status script writes snapshot", marketStatusScript.includes("market-validation-status.json"));
expect("market validation status script requires provider verification for reported paid activation", marketStatusScript.includes("provider_verification_required") && marketStatusScript.includes("check:qualifying-revenue-live") && marketStatusScript.includes("success_interaction") && marketStatusScript.includes("negative_signal"));
expect("launch summary does not treat operator-edited activation as provider revenue", launchRoutes.includes("revenue: false") && launchRoutes.includes("reported_paid_activation: paidActivations >= 1"));
expect("operator launch sprint labels reported activation separately from provider revenue", app.includes("Reported paid activations") && app.includes("Provider revenue proof"));
expect("launch segment decision script reads live ledger", launchSegmentDecisionScript.includes("/api/launch/ledger?days=") && launchSegmentDecisionScript.includes("DASHBOARD_API_KEY"));
expect("launch segment decision script writes safe aggregate output", launchSegmentDecisionScript.includes("launch-segment-decisions.json") && launchSegmentDecisionScript.includes("company, owner, contact path, and notes are intentionally omitted"));
expect("launch segment decision script enforces keep/rewrite/pause rules", launchSegmentDecisionScript.includes("qualifiedRate >= 0.03") && launchSegmentDecisionScript.includes("bucket.touches >= 100") && launchSegmentDecisionScript.includes("bucket.touches >= 200"));
expect("launch segment decision script treats checkout without activation as product fix", launchSegmentDecisionScript.includes("checkout_without_activation") && launchSegmentDecisionScript.includes("product_fix"));
expect("launch segment decision script is no-send no-spend", launchSegmentDecisionScript.includes("No outreach, SMS, calls, payments, paid spend, or production writes are triggered by this check."));
expect("SMS guardrail check package script exists", packageJson.includes('"check:sms-guardrails": "node scripts/check-sms-guardrails-contract.mjs"'));
expect("launch analytics smoke package script exists", packageJson.includes('"check:launch-analytics-smoke": "node scripts/check-launch-analytics-smoke.mjs"'));
expect("launch analytics smoke posts synthetic checkout tracking only", analyticsSmokeScript.includes('"checkout_started"') && analyticsSmokeScript.includes("creates_checkout_session: false") && analyticsSmokeScript.includes("stripe_session_created: false"));
expect("launch analytics smoke verifies source and campaign events", analyticsSmokeScript.includes("missing_from_source_summary") && analyticsSmokeScript.includes("missing_from_recent_campaign"));
expect("launch analytics smoke does not touch outreach or SMS", analyticsSmokeScript.includes("does not create checkout sessions, payments, ledger touches, SMS, or outreach"));
expect("launch asset capture package script exists", packageJson.includes('"capture:launch-assets": "node scripts/capture-launch-assets.mjs"'));
expect("launch asset check package script exists", packageJson.includes('"check:launch-assets": "node scripts/capture-launch-assets.mjs --check-existing"'));
expect("protected launch asset capture package script exists", packageJson.includes('"capture:launch-protected-assets": "node scripts/capture-launch-protected-assets.mjs"'));
expect("protected launch asset check package script exists", packageJson.includes('"check:launch-protected-assets": "node scripts/capture-launch-protected-assets.mjs --check-existing"'));
expect("launch walkthrough capture package script exists", packageJson.includes('"capture:launch-walkthrough": "node scripts/capture-launch-walkthrough.mjs"'));
expect("launch walkthrough check package script exists", packageJson.includes('"check:launch-walkthrough": "node scripts/capture-launch-walkthrough.mjs --check-existing"'));
expect("market validation gate verifies readiness and actual current launch assets", packageJson.includes('"check:market-validation-launch": "node scripts/check-market-validation-launch.mjs && npm run -s check:launch-prospect-readiness && npm run -s check:launch-ledger-reconciliation && npm run -s check:launch-touch-approval-integrity && npm run -s check:launch-asset-provenance && npm run -s check:launch-assets && npm run -s check:launch-protected-assets && npm run -s check:launch-walkthrough"'));
expect("platform submission tracker check package script exists", packageJson.includes('"check:platform-submissions": "node scripts/check-platform-submission-tracker.mjs"'));
expect("paid test plan check package script exists", packageJson.includes('"check:paid-test-plan": "node scripts/check-paid-test-tracker.mjs"'));
expect("launch asset capture writes to output/playwright", launchAssetScript.includes("output/playwright/launch-assets") && launchAssetScript.includes("manifest.json"));
expect("launch asset capture keeps Product Hunt blocked until redacted proof assets", launchAssetScript.includes("product_hunt_submission_ready: false") && launchAssetScript.includes("redacted-proof-dashboard") && launchAssetScript.includes("redacted-callback-task-queue"));
expect("launch asset capture checks public launch/pricing/industry/compare pages", launchAssetScript.includes('path: "/launch"') && launchAssetScript.includes('path: "/pricing"') && launchAssetScript.includes('path: "/industries/plumbing"') && launchAssetScript.includes('path: "/compare"'));
expect("protected launch asset capture writes redacted proof screenshots", launchProtectedAssetScript.includes("06-redacted-proof-dashboard.png") && launchProtectedAssetScript.includes("07-redacted-callback-task-queue.png"));
expect("protected launch asset capture uses live operator auth", launchProtectedAssetScript.includes("/api/operator/session") && launchProtectedAssetScript.includes("DASHBOARD_API_KEY") && launchProtectedAssetScript.includes("readRailwayEnvValue"));
expect("protected launch asset capture removes raw caller data", launchProtectedAssetScript.includes("caller names, phone numbers, transcripts, recordings, emails, and task notes are not rendered"));
expect("protected launch asset capture keeps submission blocked by self-serve proof", launchProtectedAssetScript.includes("Self-serve paid activation proof must pass before claiming fully automated SaaS."));
expect("launch walkthrough renders an MP4 from safe assets", launchWalkthroughScript.includes("08-smirk-short-proof-walkthrough.mp4") && launchWalkthroughScript.includes("ffmpeg") && launchWalkthroughScript.includes("current_public_and_redacted_launch_assets"));
expect("launch walkthrough clears only the demo blocker", launchWalkthroughScript.includes("ok_current_redacted_walkthrough") && launchWalkthroughScript.includes("Self-serve paid activation proof must pass before claiming fully automated SaaS."));
expect("launch walkthrough avoids live side effects", launchWalkthroughScript.includes("No outreach, SMS, paid ads, Stripe smoke, or real calls are triggered by this capture."));
expect("launch ledger batch import package script exists", packageJson.includes('"import:launch-ledger:batch": "node scripts/import-launch-ledger-csv.mjs"'));
expect("launch ledger batch apply script exists", packageJson.includes('"import:launch-ledger:batch:apply": "node scripts/import-launch-ledger-csv.mjs --apply"'));
expect("launch ledger all-batch validate script exists", packageJson.includes('"import:launch-ledger:all:validate": "node scripts/import-launch-ledger-csv.mjs --all --validate-only"'));
expect("launch ledger all-batch apply script exists", packageJson.includes('"import:launch-ledger:all:apply": "node scripts/import-launch-ledger-csv.mjs --all --apply"'));
expect("launch zip builder package script exists", packageJson.includes('"build:launch-zip": "node scripts/build-launch-zip.mjs"'));
expect("telegram approval safety package script exists", packageJson.includes('"check:telegram-approval-safety": "tsx scripts/check-telegram-approval-safety.ts"'));
expect("npm test includes telegram approval safety", packageJson.includes("check:telegram-approval-safety"));
expect("launch touch packet write script exists", packageJson.includes('"write:launch-touch-packet": "node scripts/write-launch-touch-packet.mjs"'));
expect("launch touch packet check script exists", packageJson.includes('"check:launch-touch-packet": "node scripts/write-launch-touch-packet.mjs --check"'));
expect("launch prospect readiness scripts exist", packageJson.includes('"check:launch-prospect-readiness":') && packageJson.includes('"check:launch-prospect-readiness:fixtures":'));
expect("launch ledger reconciliation fixture script exists", packageJson.includes('"check:launch-ledger-reconciliation": "node scripts/check-launch-ledger-reconciliation-fixtures.mjs"'));
expect("market validation launch runs offline prospect and live-ledger contracts", packageJson.includes("check:launch-prospect-readiness && npm run -s check:launch-ledger-reconciliation && npm run -s check:launch-touch-approval-integrity"));
expect("npm test protects prospect readiness and ledger reconciliation fixtures", packageJson.includes("lint && npm run -s check:launch-prospect-readiness:fixtures && npm run -s check:launch-ledger-reconciliation"));
expect("launch touch approval integrity fixture script exists", packageJson.includes('"check:launch-touch-approval-integrity": "node scripts/check-launch-touch-approval-integrity-fixtures.mjs"'));
expect("launch 200-touch packet scripts exist", packageJson.includes('"write:launch-touch-packet:200": "node scripts/write-launch-touch-packet.mjs --limit=200"') && packageJson.includes('"check:launch-touch-packet:200": "node scripts/write-launch-touch-packet.mjs --limit=200 --check"'));
expect("launch touch execution check script exists", packageJson.includes('"check:launch-touch-execution": "node scripts/check-launch-touch-execution.mjs"'));
expect("launch touch execution import scripts exist", packageJson.includes('"import:launch-touch-execution": "node scripts/import-launch-touch-execution.mjs"') && packageJson.includes('"import:launch-touch-execution:validate": "node scripts/import-launch-touch-execution.mjs --validate-only"') && packageJson.includes('"import:launch-touch-execution:apply": "node scripts/import-launch-touch-execution.mjs --apply"'));
expect("launch touch packet is local no-send", launchTouchPacketScript.includes("No outreach is sent by this packet generator.") && launchTouchPacketScript.includes("output/launch-touch-packets"));
expect("launch touch packet can cover the 200-touch sprint batch", launchTouchPacketScript.includes("const maxPacketRows = 200") && launchTouchPacketScript.includes("max_packet_rows"));
expect("launch touch packet refuses touched or spent rows", launchTouchPacketScript.includes("touch packet may only use researched zero-touch zero-spend rows") && launchTouchPacketScript.includes("spend_cents"));
expect("launch touch packet balances first touches across launch regions", launchTouchPacketScript.includes("primaryLaunchRegionOrder") && launchTouchPacketScript.includes("launchRegionKey") && launchTouchPacketScript.includes("by_launch_region"));
expect("launch touch packet writes human execution sheet", launchTouchPacketScript.includes("executionCsvPath") && launchTouchPacketScript.includes("-execution.csv") && launchTouchPacketScript.includes("response_status") && launchTouchPacketScript.includes("qualified_reason") && launchTouchPacketScript.includes("skip_reason"));
expect("launch touch packet supports one-company first send packets", launchTouchPacketScript.includes("--company=") && launchTouchPacketScript.includes("companyNameFilter") && launchTouchPacketScript.includes("packetNameSuffix") && launchTouchPacketScript.includes("slugForFile"));
expect("launch touch packet supports exact multi-company batches", launchTouchPacketScript.includes("companyNameFilters") && launchTouchPacketScript.includes("explicit company filters must match the requested packet limit") && launchTouchPacketScript.includes("company filters must be unique"));
expect("launch touch packet filters researched rows through structured execution readiness", launchTouchPacketScript.includes("summarizeLaunchProspectReadiness") && launchTouchPacketScript.includes("executionReadyRows") && launchTouchPacketScript.includes("not enough execution-ready researched prospects"));
expect("explicit launch touch packets fail closed on researched-only targets", launchTouchPacketScript.includes("explicit company filters include researched-only prospects that are not execution-ready") && launchTouchPacketScript.includes("evaluateLaunchProspectReadiness"));
expect("launch touch packets reconcile selected companies against canonical production", launchTouchPacketScript.includes("fetchProductionLaunchLedger") && launchTouchPacketScript.includes("reconcileSelectedProspectsWithProductionLedger") && launchTouchPacketScript.includes("productionAppUrl = \"https://ai-phone-agent-production-6811.up.railway.app\""));
expect("launch touch packets reject unavailable or changed production ledger state", launchTouchPacketScript.includes("could not read the current production launch ledger") && launchTouchPacketScript.includes("selected prospects do not match an untouched current production ledger snapshot") && launchTouchPacketScript.includes("launch touch packet is stale relative to the current production ledger"));
expect("launch touch packets record production snapshot source and time", launchTouchPacketScript.includes("Production Ledger Reconciliation") && launchTouchPacketScript.includes("production_ledger_snapshot") && launchTouchPacketScript.includes("selected_state_sha256"));
expect("production ledger reconciliation is GET-only and no-write", launchLedgerReconciliationHelper.includes('method: "GET"') && launchLedgerReconciliationHelper.includes('request_method: "GET"') && launchLedgerReconciliationHelper.includes("write_performed: false"));
expect("production ledger reconciliation rejects missing duplicate touched progressed and DNC state", ["production-ledger-company-missing", "production-ledger-company-duplicate", "production-ledger-already-touched", "production-ledger-state-progressed", "production-ledger-do-not-contact"].every((needle) => launchLedgerReconciliationHelper.includes(needle)));
expect("production ledger reconciliation fixtures cover live-state adversaries", ["missing", "duplicate", "last touch", "progressed state", "do not contact state", "cacheable", "incomplete"].every((needle) => launchLedgerReconciliationFixtures.includes(needle)));
expect("prospect readiness is offline and evidence-backed", launchProspectReadinessScript.includes("offline: true") && launchProspectReadinessScript.includes("execution_ready_prospects") && launchProspectReadinessScript.includes("no network access"));
expect("prospect readiness requires current direct contact and fit evidence", launchProspectReadinessHelper.includes("direct-contact-path-unverified") && launchProspectReadinessHelper.includes("research-verification-not-current") && launchProspectReadinessHelper.includes("owner-or-phone-demand-evidence-missing"));
expect("prospect readiness fixtures reject researched-only rows", launchProspectReadinessFixtures.includes("genericResearch") && launchProspectReadinessFixtures.includes("homepageOnly") && launchProspectReadinessFixtures.includes("stale") && launchProspectReadinessFixtures.includes("unsupportedChannel"));
expect("market status separates execution-ready researched-only and progressed totals", marketStatusScript.includes("prospect_readiness") && marketStatusScript.includes("execution_ready_prospects") && marketStatusScript.includes("researched_only_prospects") && marketStatusScript.includes("progressed_or_non_candidate_prospects"));
expect("market status does not label all live companies as researched", marketStatusScript.includes("researched_companies: ledgerSummary.researched_candidate_count") && marketStatusScript.includes("progressed_or_non_candidate_companies: ledgerSummary.progressed_or_non_candidate_prospect_count") && !marketStatusScript.includes("researched_companies: asNumber(traction.companies)"));
expect("launch touch packet cryptographically binds exact outreach approval and live state", launchTouchPacketScript.includes("buildLaunchTouchApproval") && launchTouchApprovalHelper.includes('smirk.outreach-batch-approval.v3') && launchTouchApprovalHelper.includes('APPROVE_SMIRK_OUTREACH_BATCH:') && launchTouchApprovalHelper.includes("production_ledger_binding") && launchTouchApprovalHelper.includes("ledger=sha256:") && launchTouchPacketScript.includes('approval_payload_sha256'));
expect("launch touch packet writes approval hashes into execution evidence", launchTouchPacketScript.includes("approvalManifestPath") && launchTouchPacketScript.includes("draft_sha256") && launchTouchPacketScript.includes("approval_batch_sha256") && launchTouchApprovalHelper.includes("prepared_not_approved"));
expect("launch touch packet check validates existing manifest and execution evidence", launchTouchPacketScript.includes("validateLaunchTouchExecutionApproval") && launchTouchPacketScript.includes("launch touch packet is stale relative to current researched inputs or draft code") && launchTouchPacketScript.includes("owner_approval_proven: false"));
expect("launch touch approval helper validates canonical hash order and contact path", launchTouchApprovalHelper.includes("approval-canonical-payload-mismatch") && launchTouchApprovalHelper.includes("execution-send-order-mismatch") && launchTouchApprovalHelper.includes("execution-actual-contact-path-not-approved") && launchTouchApprovalHelper.includes("ownerApprovalProven: false"));
expect("launch touch approval fixtures cover integrity bypasses", launchTouchApprovalFixtures.includes("execution-contact-path-mismatch") && launchTouchApprovalFixtures.includes("execution-batch-hash-mismatch") && launchTouchApprovalFixtures.includes("approval-manifest-missing"));
expect("launch touch drafts do not claim unsupported forwarding", !launchTouchPacketScript.includes("missed or forwarded") && launchTouchPacketScript.includes("call to the dedicated recovery number"));
expect("launch touch packet defaults draft rows to zero-touch researched", launchTouchPacketScript.includes('next_state_after_send: "researched"') && launchTouchPacketScript.includes('touch_count_delta: "0"') && launchTouchPacketScript.includes("After human-reviewed send"));
expect("launch touch packet uses human-readable vertical phrases", launchTouchPacketScript.includes("function verticalPhrase") && launchTouchPacketScript.includes('plumbing_hvac_electric: "home-service"') && launchTouchPacketScript.includes('plumbing_hvac: "plumbing and HVAC"'));
expect("launch touch packet personalizes researched owner greetings", launchTouchPacketScript.includes('const greeting = firstName === "team"') && launchTouchPacketScript.includes('`Hi ${greeting},`'));
expect("launch zip builder packages latest handoff and exact approval manifest without sending", read("scripts/build-launch-zip.mjs").includes("smirk-launch-packet.zip") && read("scripts/build-launch-zip.mjs").includes("No outreach was sent.") && read("scripts/build-launch-zip.mjs").includes("telegram-handoff.txt") && read("scripts/build-launch-zip.mjs").includes("-approval.json") && read("scripts/build-launch-zip.mjs").includes("prepared_not_approved"));
expect("launch zip builder pauses telegram handoff", read("scripts/build-launch-zip.mjs").includes("PAUSED") && read("scripts/build-launch-zip.mjs").includes("Do not upload this zip to Hermes"));
expect("telegram approval callback validates secret header", telegramApprovalRoutes.includes("x-telegram-bot-api-secret-token") && telegramApprovalRoutes.includes("telegramWebhookSecretMatches"));
expect("telegram approval callback requires allowlisted user and chat", telegramApprovalRoutes.includes("TELEGRAM_ALLOWED_USER_IDS") && telegramApprovalRoutes.includes("TELEGRAM_ALLOWED_CHAT_IDS") && telegramApprovalRoutes.includes("isTelegramActorAllowed"));
expect("telegram approval callback uses opaque callback data", launchApproval.includes("smirk_launch") && launchApproval.includes("opaqueApprovalIdPattern") && launchApproval.includes("non-opaque-approval-id"));
expect("telegram approval path records audit rows", telegramApprovalRoutes.includes("launch_outreach_approval_audit") && launchApproval.includes("recordAudit"));
expect("telegram approval path is single-use by status transition", telegramApprovalRoutes.includes("AND status = ANY") && launchApproval.includes("approval-not-in-expected-state"));
expect("telegram approval path separates approved from sent", launchApproval.includes("Approved for sending. Delivery has not started and no outreach was sent.") && launchApproval.includes("delivery_status: \"not_sent\""));
expect("telegram approval path has preview reject expire cancel controls", telegramApprovalRoutes.includes("preview: buildTelegramApprovalCallbackData") && telegramApprovalRoutes.includes("reject: buildTelegramApprovalCallbackData") && telegramApprovalRoutes.includes("expire: buildTelegramApprovalCallbackData") && telegramApprovalRoutes.includes("cancel: buildTelegramApprovalCallbackData"));
expect("telegram approval tests cover forged replay missing malformed and db failure", telegramApprovalSafetyScript.includes("wrong-secret") && telegramApprovalSafetyScript.includes("replayed") && telegramApprovalSafetyScript.includes("approval-row-missing") && telegramApprovalSafetyScript.includes("malformed") && telegramApprovalSafetyScript.includes("database offline"));
expect("launch touch execution check is offline and no-send", launchTouchExecutionScript.includes("Offline integrity validation only") && launchTouchExecutionScript.includes("no Railway writes, outreach, SMS, calls, payments, or spend"));
expect("launch touch execution check requires manifest hash fields", launchTouchExecutionScript.includes('"draft_sha256"') && launchTouchExecutionScript.includes('"approval_batch_sha256"') && launchTouchExecutionScript.includes("execution-approval-integrity-invalid") && launchTouchExecutionScript.includes("owner_approval_proven: false"));
expect("launch touch execution check validates qualification and skip rules", launchTouchExecutionScript.includes("qualified response requires qualified_reason") && launchTouchExecutionScript.includes("skipped rows must use touch_count_delta=0") && launchTouchExecutionScript.includes("spend_cents_delta must stay 0"));
expect("launch touch execution check prevents unsent touch counting", launchTouchExecutionScript.includes("unsent rows must keep touch_count_delta=0") && launchTouchExecutionScript.includes("unsent rows must remain researched") && launchTouchExecutionScript.includes("unsent rows must not have human_sender"));
expect("launch touch execution import requires confirmation to apply", launchTouchExecutionImportScript.includes("CONFIRM_SMIRK_LAUNCH_TOUCH_IMPORT") && launchTouchExecutionImportScript.includes("log-human-launch-touches"));
expect("launch touch execution import validates offline without live writes", launchTouchExecutionImportScript.includes("const validateOnly = args.includes(\"--validate-only\")") && launchTouchExecutionImportScript.includes("Offline integrity validation only") && launchTouchExecutionImportScript.includes("no Railway writes, outreach, SMS, calls, payments, or spend"));
expect("launch touch execution import requires manifest hash integrity", launchTouchExecutionImportScript.includes('"draft_sha256"') && launchTouchExecutionImportScript.includes('"approval_batch_sha256"') && launchTouchExecutionImportScript.includes("validateLaunchTouchExecutionApproval") && launchTouchExecutionImportScript.includes("owner_approval_proven: false"));
expect("launch touch execution import only patches existing ledger rows", launchTouchExecutionImportScript.includes("/api/launch/ledger?days=90&limit=500") && launchTouchExecutionImportScript.includes("launch-touch-existing-row-missing") && launchTouchExecutionImportScript.includes("Import researched prospects before importing sent touch logs"));
expect("launch touch execution import bumps touch once under human fields", launchTouchExecutionImportScript.includes("bump_touch: true") && launchTouchExecutionImportScript.includes("sent_at requires human_sender") && launchTouchExecutionImportScript.includes("sent_at requires actual_contact_path") && launchTouchExecutionImportScript.includes("sent rows must use touch_count_delta=1"));
expect("launch touch execution import avoids outreach", launchTouchExecutionImportScript.includes("No outreach is sent by this importer") && launchTouchExecutionImportScript.includes("does not send outreach"));
expect("launch ledger import requires confirmation to apply", importScript.includes("CONFIRM_SMIRK_LAUNCH_LEDGER_IMPORT") && importScript.includes("import-researched-launch-prospects"));
expect("launch ledger import is dry-run by default", importScript.includes("const apply = process.argv.includes(\"--apply\")") && importScript.includes("No outreach is sent by this importer"));
expect("launch ledger import supports offline validation", importScript.includes("const validateOnly = process.argv.includes(\"--validate-only\")") && importScript.includes("Offline validation only"));
expect("launch ledger import supports all researched batches", importScript.includes("const allBatchInput = process.argv.includes(\"--all\")") && importScript.includes("prospect-batch-.*\\.csv"));
expect("launch ledger import enforces researched-only batches", importScript.includes("batch-import-must-be-researched-only") && importScript.includes("touch_count !== 0") && importScript.includes("spend_cents !== 0"));
expect("launch ledger import blocks forbidden outreach channels", importScript.includes("batch-import-forbidden-outreach-channel") && importScript.includes("voicemail[-_\\s]?drop"));
expect("launch ledger import deduplicates by company", importScript.includes("skipped_existing") && importScript.includes("existingCompanies"));
expect("launch ledger import labels the selected research batch", importScript.includes('path.basename(inputFile, ".csv")') && importScript.includes("research_batch=${batchSlug}"));

for (const needle of [
  "1 paid Starter account completes the $197/month checkout",
  "10 qualified owner/operator conversations",
  "500 researched outbound touches plus $500 paid spend",
  "SMS is not part of the launch acquisition motion",
  "Never use texting to cold-prospect this sprint",
  "docs/launch/sms-guarded-enablement-runbook.md",
  "Landing page analytics are working",
  "Checkout and activation events are trackable",
  "npm run check:market-validation-status",
  "docs/launch/prospect-batch-001-reno.csv",
  "docs/launch/prospect-batch-002-sacramento.csv",
  "docs/launch/prospect-batch-003-boise.csv",
  "docs/launch/prospect-batch-004-reno-expansion.csv",
  "docs/launch/prospect-batch-005-sacramento-expansion.csv",
  "docs/launch/prospect-batch-006-boise-expansion.csv",
  "docs/launch/prospect-batch-007-salt-lake-expansion.csv",
  "docs/launch/prospect-batch-008-fresno-expansion.csv",
  "npm run import:launch-ledger:batch",
  "npm run import:launch-ledger:all:validate",
  "npm run capture:launch-assets",
  "npm run capture:launch-walkthrough",
  "output/playwright/launch-assets/manifest.json",
  "docs/launch/social-post-pack.md",
  "docs/launch/competitive-positioning-matrix.md",
  "docs/launch/platform-submission-tracker.csv",
  "docs/launch/paid-test-tracker.csv",
  "npm run write:launch-touch-packet",
  "npm run write:launch-touch-packet:200",
  "first-200-manual-touch-execution.csv",
  "npm run check:launch-touch-execution",
  "npm run check:platform-submissions",
  "npm run check:paid-test-plan",
  "does not send outreach",
  "first-20-manual-touch-execution.csv",
  "AppSumo",
  "Do not offer unlimited or lifetime voice usage",
]) {
  expect(`launch runbook contains: ${needle}`, launchDoc.includes(needle));
}

for (const source of [
  "https://smith.ai/pricing/ai-receptionist",
  "https://www.goodcall.com/pricing",
  "https://www.bland.ai/pricing",
  "https://www.retellai.com/pricing",
  "https://vapi.ai/pricing",
  "https://synthflow.ai/pricing",
  "https://www.producthunt.com/launch/preparing-for-launch",
  "https://sell.g2.com/create-a-profile",
  "https://www.capterra.com/legal/listing-guidelines/",
  "https://sell.appsumo.com/",
]) {
  expect(`launch runbook cites ${source}`, launchDoc.includes(source));
}

const ledgerRows = csvRows(ledger);
const ledgerHeader = new Set(ledgerRows[0] || []);
for (const column of [
  "source",
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "response",
  "objection",
  "proof_walkthrough_status",
  "checkout_status",
  "activation_status",
  "next_state",
]) {
  expect(`traction ledger has ${column}`, ledgerHeader.has(column));
}
expect("traction ledger has template rows", ledgerRows.length >= 5);

const prospectRows = csvRows(prospectBatch);
expect("first researched prospect batch has at least 25 rows", prospectRows.length >= 26);
const prospectHeader = new Set(prospectRows[0] || []);
for (const column of [
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "next_state",
  "touch_count",
  "spend_cents",
  "source_url",
  "contact_url",
]) {
  expect(`first researched prospect batch has ${column}`, prospectHeader.has(column));
}
expect("first researched prospect batch is researched not contacted", prospectBatch.includes(",researched,0,0,") && !/,contacted,[1-9]/.test(prospectBatch));
expect("first researched prospect batch uses public web/contact channels", prospectBatch.includes("website_form") && prospectBatch.includes("Public official site from launch research; no message sent"));
expect("first researched prospect batch avoids cold SMS", !/sms|text|cold\s*text|auto[- ]?dial/i.test(prospectBatch));

const prospectRows2 = csvRows(prospectBatch2);
expect("second researched prospect batch has at least 25 rows", prospectRows2.length >= 26);
const prospectHeader2 = new Set(prospectRows2[0] || []);
for (const column of [
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "next_state",
  "touch_count",
  "spend_cents",
  "source_url",
  "contact_url",
]) {
  expect(`second researched prospect batch has ${column}`, prospectHeader2.has(column));
}
expect("second researched prospect batch is researched not contacted", prospectBatch2.includes(",researched,0,0,") && !/,contacted,[1-9]/.test(prospectBatch2));
expect("second researched prospect batch uses public web/contact channels", prospectBatch2.includes("website_form") && prospectBatch2.includes("Public official site from launch research; no message sent"));
expect("second researched prospect batch avoids cold SMS", !/sms|text|cold\s*text|auto[- ]?dial/i.test(prospectBatch2));

const prospectRows3 = csvRows(prospectBatch3);
expect("third researched prospect batch has at least 25 rows", prospectRows3.length >= 26);
const prospectHeader3 = new Set(prospectRows3[0] || []);
for (const column of [
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "next_state",
  "touch_count",
  "spend_cents",
  "source_url",
  "contact_url",
]) {
  expect(`third researched prospect batch has ${column}`, prospectHeader3.has(column));
}
expect("third researched prospect batch is researched not contacted", prospectBatch3.includes(",researched,0,0,") && !/,contacted,[1-9]/.test(prospectBatch3));
expect("third researched prospect batch uses public web/contact channels", prospectBatch3.includes("website_form") && prospectBatch3.includes("Public official site from launch research; no message sent"));
expect("third researched prospect batch avoids cold SMS", !/sms|text|cold\s*text|auto[- ]?dial/i.test(prospectBatch3));

const prospectRows4 = csvRows(prospectBatch4);
expect("fourth researched prospect batch has at least 25 rows", prospectRows4.length >= 26);
const prospectHeader4 = new Set(prospectRows4[0] || []);
for (const column of [
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "next_state",
  "touch_count",
  "spend_cents",
  "source_url",
  "contact_url",
]) {
  expect(`fourth researched prospect batch has ${column}`, prospectHeader4.has(column));
}
expect("fourth researched prospect batch is researched not contacted", prospectBatch4.includes(",researched,0,0,") && !/,contacted,[1-9]/.test(prospectBatch4));
expect("fourth researched prospect batch uses public web/contact channels", prospectBatch4.includes("website_form") && prospectBatch4.includes("Public official site from launch research; no message sent"));
expect("fourth researched prospect batch avoids cold SMS", !/sms|text|cold\s*text|auto[- ]?dial/i.test(prospectBatch4));

const prospectRows5 = csvRows(prospectBatch5);
expect("fifth researched prospect batch has at least 25 rows", prospectRows5.length >= 26);
const prospectHeader5 = new Set(prospectRows5[0] || []);
for (const column of [
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "next_state",
  "touch_count",
  "spend_cents",
  "source_url",
  "contact_url",
]) {
  expect(`fifth researched prospect batch has ${column}`, prospectHeader5.has(column));
}
expect("fifth researched prospect batch is researched not contacted", prospectBatch5.includes(",researched,0,0,") && !/,contacted,[1-9]/.test(prospectBatch5));
expect("fifth researched prospect batch uses public web/contact channels", prospectBatch5.includes("website_form") && prospectBatch5.includes("Public official site from launch research; no message sent"));
expect("fifth researched prospect batch avoids cold SMS", !/sms|text|cold\s*text|auto[- ]?dial/i.test(prospectBatch5));

const prospectRows6 = csvRows(prospectBatch6);
expect("sixth researched prospect batch has at least 25 rows", prospectRows6.length >= 26);
const prospectHeader6 = new Set(prospectRows6[0] || []);
for (const column of [
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "next_state",
  "touch_count",
  "spend_cents",
  "source_url",
  "contact_url",
]) {
  expect(`sixth researched prospect batch has ${column}`, prospectHeader6.has(column));
}
expect("sixth researched prospect batch is researched not contacted", prospectBatch6.includes(",researched,0,0,") && !/,contacted,[1-9]/.test(prospectBatch6));
expect("sixth researched prospect batch uses public web/contact channels", prospectBatch6.includes("website_form") && prospectBatch6.includes("Public official site from launch research; no message sent"));
expect("sixth researched prospect batch avoids cold SMS", !/sms|text|cold\s*text|auto[- ]?dial/i.test(prospectBatch6));

const prospectRows7 = csvRows(prospectBatch7);
expect("seventh researched prospect batch has at least 25 rows", prospectRows7.length >= 26);
const prospectHeader7 = new Set(prospectRows7[0] || []);
for (const column of [
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "next_state",
  "touch_count",
  "spend_cents",
  "source_url",
  "contact_url",
]) {
  expect(`seventh researched prospect batch has ${column}`, prospectHeader7.has(column));
}
expect("seventh researched prospect batch is researched not contacted", prospectBatch7.includes(",researched,0,0,") && !/,contacted,[1-9]/.test(prospectBatch7));
expect("seventh researched prospect batch uses public web/contact channels", prospectBatch7.includes("website_form") && prospectBatch7.includes("Public official site from launch research; no message sent"));
expect("seventh researched prospect batch avoids cold SMS", !/sms|text|cold\s*text|auto[- ]?dial/i.test(prospectBatch7));

const prospectRows8 = csvRows(prospectBatch8);
expect("eighth researched prospect batch has at least 25 rows", prospectRows8.length >= 26);
const prospectHeader8 = new Set(prospectRows8[0] || []);
for (const column of [
  "company",
  "vertical",
  "region",
  "owner_contact",
  "channel",
  "message_variant",
  "next_state",
  "touch_count",
  "spend_cents",
  "source_url",
  "contact_url",
]) {
  expect(`eighth researched prospect batch has ${column}`, prospectHeader8.has(column));
}
expect("eighth researched prospect batch is researched not contacted", prospectBatch8.includes(",researched,0,0,") && !/,contacted,[1-9]/.test(prospectBatch8));
expect("eighth researched prospect batch uses public web/contact channels", prospectBatch8.includes("website_form") && prospectBatch8.includes("Public official site from launch research; no message sent"));
expect("eighth researched prospect batch avoids cold SMS", !/sms|text|cold\s*text|auto[- ]?dial/i.test(prospectBatch8));

const contentRows = csvRows(contentCalendar);
expect("content calendar has 20 planned posts", contentRows.length === 21);
expect("content calendar has CTA column", (contentRows[0] || []).includes("cta"));
expect("content calendar avoids cold texting", !/cold\s+text|text\s+back|send\s+texts/i.test(contentCalendar));
expect("content calendar uses launch CTA", contentCalendar.includes("/launch"));
const socialPosts = socialPostPack.match(/^### Post \d+ - /gm) || [];
expect("social post pack has 20 publish-ready posts", socialPosts.length === 20);
expect("social post pack includes tracking UTMs", socialPostPack.includes("utm_source=linkedin") && socialPostPack.includes("utm_source=x") && socialPostPack.includes("utm_source=short_video"));
expect("social post pack includes log variants", socialPostPack.includes("Log as: `linkedin_missed_call_wedge`") && socialPostPack.includes("Log as: `x_results_prompt`"));
expect("social post pack keeps activation guardrail", socialPostPack.includes("Do not claim fully automated SaaS until the self-serve activation proof passes"));
expect("social post pack avoids replacement positioning", socialPostPack.includes("not replacing the office") && socialPostPack.includes("not being launched as a staff replacement pitch"));
expect("social post pack avoids cold outreach channels", !/cold\s+SMS|automated\s+DMs|purchased-list outreach/i.test(socialPostPack.replace("Do not use it for cold SMS, automated DMs, purchased-list outreach, or paid spend without the paid-test approval gate.", "")));

expect("Product Hunt kit has a tagline", productHunt.includes("Missed-call recovery for home-service businesses"));
expect("Product Hunt kit has first comment", productHunt.includes("## First Comment"));
expect("Product Hunt kit asks for buyer feedback", productHunt.includes("Would this be enough to try one proof call?"));
expect("Product Hunt kit keeps texting guarded", productHunt.includes("not part of the first-dollar launch motion"));
expect("Product Hunt kit documents asset capture workflow", productHunt.includes("npm run capture:launch-assets") && productHunt.includes("output/playwright/launch-assets/manifest.json"));
expect("Product Hunt kit documents protected redacted capture workflow", productHunt.includes("npm run capture:launch-protected-assets") && productHunt.includes("06-redacted-proof-dashboard.png") && productHunt.includes("07-redacted-callback-task-queue.png"));
expect("Product Hunt kit documents walkthrough capture workflow", productHunt.includes("npm run capture:launch-walkthrough") && productHunt.includes("08-smirk-short-proof-walkthrough.mp4"));

for (const needle of [
  "docs/launch/manual-outbound-playbook.md",
  "docs/launch/platform-submission-kit.md",
  "docs/launch/paid-test-brief.md",
]) {
  expect(`launch runbook links ${needle}`, launchDoc.includes(needle));
}

for (const needle of [
  "https://www.producthunt.com/launch/preparing-for-launch",
  "https://sell.g2.com/create-a-profile",
  "https://www.capterra.com/legal/listing-guidelines/",
  "https://sell.appsumo.com/",
  "Missed-call recovery for home-service teams",
  "Do not offer unlimited lifetime voice or SMS",
]) {
  expect(`platform submission kit contains: ${needle}`, platformKit.includes(needle));
}
expect("platform kit includes support response plan", platformKit.includes("Support response plan"));
expect("platform kit includes redacted screenshot checklist", platformKit.includes("caller details removed"));
expect("platform kit includes launch asset manifest workflow", platformKit.includes("npm run check:launch-protected-assets") && platformKit.includes("product_hunt_submission_ready=false"));
expect("platform kit includes walkthrough capture workflow", platformKit.includes("npm run check:launch-walkthrough") && platformKit.includes("08-smirk-short-proof-walkthrough.mp4"));
expect("platform kit includes platform submission tracker workflow", platformKit.includes("docs/launch/platform-submission-tracker.csv") && platformKit.includes("npm run check:platform-submissions"));
expect("platform kit references social post pack", platformKit.includes("docs/launch/social-post-pack.md"));
expect("platform kit delays AppSumo", platformKit.includes("Status: delayed"));

for (const needle of [
  "missed-call recovery for home-service businesses",
  "not as a generic AI receptionist",
  "Smith.ai trust packaging",
  "Goodcall-style buying simplicity",
  "Usage caps learned from infrastructure platforms",
  "Generic receptionist positioning",
  "Developer-platform messaging",
  "SMS-first or cold-SMS growth",
]) {
  expect(`competitive positioning matrix contains: ${needle}`, competitorMatrix.includes(needle));
}

for (const source of [
  "https://smith.ai/pricing/ai-receptionist",
  "https://www.goodcall.com/pricing",
  "https://www.bland.ai/pricing",
  "https://www.retellai.com/pricing",
  "https://vapi.ai/pricing",
  "https://synthflow.ai/pricing",
  "https://www.techradar.com/pro/zoom-will-let-you-add-an-ai-receptionist-at-work-as-businesses-shouldnt-have-to-replace-their-phone-system-to-benefit-from-ai",
  "https://www.producthunt.com/launch",
  "https://sell.g2.com/create-a-profile",
  "https://www.capterra.com/legal/listing-guidelines/",
  "https://appsumo.com/partner-apply/",
  "https://www.facebook.com/business/help/761812391313386",
  "https://support.google.com/google-ads/answer/7684791",
  "https://business.google.com/us/ad-solutions/local-service-ads/",
  "https://business.linkedin.com/advertise/ads/sponsored-content/lead-gen-ads",
]) {
  expect(`competitive positioning matrix cites ${source}`, competitorMatrix.includes(source));
}

for (const needle of [
  "product_hunt",
  "g2",
  "capterra",
  "appsumo",
  "prepared_blocked",
  "self_serve_activation_required",
  "active_selling_required",
  "usage_caps_and_margin_required",
  "assets_ready_for_feedback",
  "delayed",
]) {
  expect(`platform submission tracker contains: ${needle}`, platformTracker.includes(needle));
}
expect("platform submission tracker checker is offline and no-submit", platformTrackerScript.includes("Offline validation only") && platformTrackerScript.includes("No platform submissions, paid spend, outreach, SMS, Stripe smoke, or production writes"));
expect("platform submission tracker checker keeps AppSumo delayed", platformTrackerScript.includes("AppSumo must remain delayed") && platformTrackerScript.includes("usage caps, margins, support load, and self-serve proof"));
expect("platform submission tracker checker gates Product Hunt", platformTrackerScript.includes("Product Hunt cannot be submitted") && platformTrackerScript.includes("approved_preproof_feedback_launch"));

for (const needle of [
  "meta_instagram_lead_demo",
  "google_search_long_tail",
  "retargeting_proof_loop",
  "reserve_creative_tooling",
  "APPROVE_SMIRK_PAID_TEST plus live tracking and activation proof",
  "analytics_checkout_activation_required",
  "self_serve_activation_required",
  "blocked",
]) {
  expect(`paid test tracker contains: ${needle}`, paidTracker.includes(needle));
}
expect("paid test tracker uses exact $500 budget", paidTracker.includes("20000") && paidTracker.includes("15000") && paidTracker.includes("10000") && paidTracker.includes("5000"));
expect("paid test tracker checker is offline and no-spend", paidTrackerScript.includes("Offline validation only") && paidTrackerScript.includes("No ad campaigns, paid spend, outreach, SMS, Stripe smoke, platform submissions, or production writes"));
expect("paid test tracker checker enforces zero spend", paidTrackerScript.includes("total spend must stay 0") && paidTrackerScript.includes("spend_cents must stay 0"));
expect("paid test tracker checker enforces $500 cap", paidTrackerScript.includes("total budget must equal 50000") && paidTrackerScript.includes("expectedBudgets"));
expect("paid test tracker checker keeps creative blocked by activation proof", paidTrackerScript.includes("paid creative must remain blocked") && paidTrackerScript.includes("Self-serve paid activation proof"));

for (const needle of [
  "200 researched manual touches",
  "No cold SMS",
  "Automated dialing",
  "100 touches and 0 qualified replies",
  "3% qualified reply rate",
  "Checkout starts without activation",
]) {
  expect(`manual outbound playbook contains: ${needle}`, outboundPlaybook.includes(needle));
}
expect("manual outbound playbook has message variants", outboundPlaybook.includes("Variant A") && outboundPlaybook.includes("Variant B") && outboundPlaybook.includes("Variant C"));
expect("manual outbound playbook logs social reply variants", outboundPlaybook.includes("docs/launch/social-post-pack.md") && outboundPlaybook.includes("message variant"));
expect("manual outbound playbook documents all-batch validation", outboundPlaybook.includes("npm run import:launch-ledger:all:validate") && outboundPlaybook.includes("zero touches") && outboundPlaybook.includes("zero spend"));
expect("manual outbound playbook documents first touch packet and GET-only production reconciliation", outboundPlaybook.includes("npm run write:launch-touch-packet") && outboundPlaybook.includes("read-only `GET /api/launch/ledger`") && outboundPlaybook.includes("never sends outreach or writes to the live ledger"));
expect("manual outbound playbook documents immutable outreach approval", outboundPlaybook.includes("approval payload SHA-256") && outboundPlaybook.includes("APPROVE_SMIRK_OUTREACH_BATCH") && outboundPlaybook.includes("repeated `--company=`"));
expect("manual outbound playbook documents first touch execution sheet", outboundPlaybook.includes("first-20-manual-touch-execution.csv") && outboundPlaybook.includes("response_status") && outboundPlaybook.includes("qualified_reason") && outboundPlaybook.includes("skip_reason"));
expect("manual outbound playbook documents offline execution validation", outboundPlaybook.includes("npm run check:launch-touch-execution") && outboundPlaybook.includes("offline validation only") && outboundPlaybook.includes("does not write to Railway"));
expect("manual outbound playbook avoids cold texting", !/text\s+back|cold\s+texting\s+approved/i.test(outboundPlaybook));

for (const needle of [
  "$500 total",
  "$200",
  "$150",
  "$100",
  "$50",
  "APPROVE_SMIRK_PAID_TEST",
  "no Local Services Ads provider impersonation",
  "Google Search long-tail test",
  "LinkedIn Lead Gen",
  "https://support.google.com/google-ads/answer/6167122",
  "https://business.linkedin.com/advertise/ads/sponsored-content/lead-gen-ads",
]) {
  expect(`paid test brief contains: ${needle}`, paidBrief.includes(needle));
}
expect("paid test brief blocks unsupported claims", paidBrief.includes("Not allowed") && paidBrief.includes("Guaranteed recovered revenue"));
expect("paid test brief references paid tracker", paidBrief.includes("docs/launch/paid-test-tracker.csv") && paidBrief.includes("npm run check:paid-test-plan"));

expect("SMS guardrail default mode is dry_run", smsGuardrails.includes('SMS_SEND_MODE || "dry_run"'));
expect("SMS guardrails require live confirmation phrase", smsGuardrails.includes('SMS_LIVE_CONFIRMATION = "send guarded sms"'));
expect("SMS guardrails require A2P approval for live sends", smsGuardrails.includes("SMS_A2P_CAMPAIGN_APPROVED"));
expect("SMS guardrails cap workspace daily sends", smsGuardrails.includes('readPositiveInt("SMS_MAX_PER_WORKSPACE_PER_DAY", 20)'));
expect("SMS guardrails cap recipient daily sends", smsGuardrails.includes('readPositiveInt("SMS_MAX_PER_RECIPIENT_PER_DAY", 2)'));
expect("SMS guardrails cap estimated daily spend", smsGuardrails.includes('readPositiveInt("SMS_DAILY_SPEND_CAP_CENTS", 200)'));
expect("SMS guardrails enforce recipient cooldown", smsGuardrails.includes('readPositiveInt("SMS_MIN_SECONDS_BETWEEN_RECIPIENT", 300)'));
expect("SMS guardrails support allowlisted testing", smsGuardrails.includes("SMS_ALLOWED_NUMBERS"));
expect("SMS guardrail checker is specific to burst/spend controls", smsGuardrailScript.includes("Stop after one message.") && smsGuardrailScript.includes("SMS_DAILY_SPEND_CAP_CENTS=50") && smsGuardrailScript.includes("operator-only routes"));
for (const needle of [
  "SMS is not part of first-dollar acquisition.",
  "SMS_SEND_MODE=dry_run",
  "SMS_MAX_PER_WORKSPACE_PER_DAY=3",
  "SMS_MAX_PER_RECIPIENT_PER_DAY=1",
  "SMS_DAILY_SPEND_CAP_CENTS=50",
  '"confirm": "send guarded sms"',
  "Stop after one message.",
  "Do not raise caps because a test \"looks fine.\"",
]) {
  expect(`SMS guarded enablement runbook contains: ${needle}`, smsRunbook.includes(needle));
}

if (failures.length > 0) {
  console.error("FAIL market validation launch implementation drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK market validation launch page, assets, hard goals, paid-spend cap, channel plan, and SMS guardrails are in place");
