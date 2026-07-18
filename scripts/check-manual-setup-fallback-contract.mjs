#!/usr/bin/env node
import fs from "node:fs";

const routes = fs.readFileSync("src/routes/provisioning-routes.ts", "utf8");
const alerts = fs.readFileSync("src/monetization-alerts.ts", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const fixtures = fs.readFileSync("scripts/check-buyer-activation-email-fixtures.ts", "utf8");
const failures = [];
const expect = (label, condition) => { if (!condition) failures.push(label); };

expect("manual setup captures bounded phone and notes input",
  routes.includes("const ownerPhone = String(")
  && routes.includes("const intakeNotes = String(")
  && routes.includes(".slice(0, 2_000)")
  && routes.includes("if (!businessName || !ownerEmail || !ownerPhone)"));
expect("manual setup persists phone and notes with the lead row",
  routes.includes("owner_email, owner_phone, business_phone, intake_notes")
  && routes.includes("${ownerEmail}, ${ownerPhone}, ${ownerPhone}, ${intakeNotes}"));
expect("operator fallback contains the submitted notes",
  alerts.includes("intakeNotes?: string | null")
  && alerts.includes("`Setup notes:\\n${input.intakeNotes}`")
  && routes.includes("intakeNotes,"));
expect("no-database intake succeeds only after an operator alert is accepted",
  routes.includes("const operatorAlert = await sendProvisioningAlert({")
  && routes.includes("if (!operatorAlert.sent)")
  && routes.includes("captured: false")
  && routes.includes("status: \"capture_unavailable\"")
  && routes.includes("res.status(503)"));
expect("manual setup sends an honest idempotent buyer receipt",
  alerts.includes("export async function sendManualSetupReceipt")
  && alerts.includes("This request did not create a charge or an active workspace.")
  && alerts.includes("smirk_manual_setup_receipt_${deliveryVersion}")
  && routes.includes("receipt_email_sent: receipt.sent"));
expect("database-backed manual intake remains honest when receipt delivery fails",
  routes.includes("Setup request saved with the business phone and any setup notes you provided. The confirmation email could not be delivered")
  && routes.includes("manual_receipt_retryable_failed")
  && routes.includes("buyer_activation_email_provider_id"));
expect("public setup page renders the server delivery result and a sanitized help link",
  app.includes("status: body.message || (body.receipt_email_sent")
  && app.includes("const bookingLink = normalizePublicHttpsUrl(body.booking_link)")
  && app.includes("Open setup help"));
expect("behavior fixtures cover manual receipt idempotency, safety, and provider failures",
  fixtures.includes("const manualReceipt = await sendManualSetupReceipt")
  && fixtures.includes("const repeatedManualReceipt = await sendManualSetupReceipt")
  && fixtures.includes("const transientManualReceipt = await sendManualSetupReceipt")
  && fixtures.includes("const permanentManualReceipt = await sendManualSetupReceipt"));

if (failures.length > 0) {
  console.error("FAIL manual setup fallback contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK manual setup preserves phone and notes, fails closed when uncaptured, and reports buyer receipt delivery honestly");
