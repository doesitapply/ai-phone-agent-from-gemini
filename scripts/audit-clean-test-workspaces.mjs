#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import twilio from "twilio";

const APPLY = process.argv.includes("--apply");
const HELP = process.argv.includes("--help") || process.argv.includes("-h");
const CONFIRM = String(process.env.CONFIRM_TEST_WORKSPACE_CLEANUP || "").trim();
const REQUIRE_CONFIRM = "release-test-phone-numbers";
const OUT_DIR = path.resolve("output");

if (HELP) {
  console.log([
    "Audit likely test/smoke workspaces and orphan provisioning rows.",
    "",
    "Usage:",
    "  node scripts/audit-clean-test-workspaces.mjs",
    "  node scripts/audit-clean-test-workspaces.mjs --apply",
    "",
    "Dry run:",
    "  Writes output/test-workspace-cleanup-dry-run.json and does not modify live resources.",
    "",
    "Apply:",
    `  Requires CONFIRM_TEST_WORKSPACE_CLEANUP=${REQUIRE_CONFIRM}.`,
    "  Releases matched Twilio phone numbers, closes matched subaccounts, and deletes matched DB rows.",
    "",
    "Inputs:",
    "  Uses DATABASE_URL/TWILIO_* from the environment, or falls back to Railway variables.",
  ].join("\n"));
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

function loadRailwayVariables() {
  const envVars = {
    DATABASE_URL: process.env.DATABASE_URL,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  };
  if (envVars.DATABASE_URL) return envVars;

  const raw = execFileSync(
    "bash",
    ["-lc", "source ./scripts/load-railway-auth.sh >/dev/null 2>&1 || true; railway variable list --json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(raw);
}

function redactPhone(value) {
  const text = String(value || "");
  const digits = text.replace(/\D/g, "");
  if (digits.length < 4) return text ? "***" : null;
  return `***${digits.slice(-4)}`;
}

function redactEmail(value) {
  const email = String(value || "").trim();
  if (!email) return null;
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  return `${user.slice(0, 3)}***@${domain}`;
}

function redactSid(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  return `${text.slice(0, 4)}…${text.slice(-6)}`;
}

function isLikelyTest(row) {
  const haystack = [
    row.name,
    row.slug,
    row.owner_email,
    row.business_name,
    row.notification_email,
    row.source,
    row.status,
  ].filter(Boolean).join(" ").toLowerCase();

  if (row.id === 1 || row.slug === "default") return false;
  if (/smirk\s+(smoke|stripe webhook smoke)/i.test(haystack)) return true;
  if (/\b(smoke|test|testing|stripe-\d+|buyer-auth-smoke|webhook smoke)\b/i.test(haystack)) return true;
  if (/@example\.com\b/i.test(haystack)) return true;
  return false;
}

function cleanupPlanFromRows(rows) {
  return rows.filter(isLikelyTest);
}

async function main() {
  if (APPLY && CONFIRM !== REQUIRE_CONFIRM) {
    console.error(JSON.stringify({
      ok: false,
      error: "missing-confirmation",
      message: `Rerun with CONFIRM_TEST_WORKSPACE_CLEANUP=${REQUIRE_CONFIRM} to release Twilio resources and delete test DB rows.`,
    }, null, 2));
    process.exit(1);
  }

  const vars = loadRailwayVariables();
  const databaseUrl = String(vars.DATABASE_URL || "").trim();
  const twilioAccountSid = String(vars.TWILIO_ACCOUNT_SID || "").trim();
  const twilioAuthToken = String(vars.TWILIO_AUTH_TOKEN || "").trim();

  if (!databaseUrl) throw new Error("DATABASE_URL missing from Railway variables");

  const sql = postgres(databaseUrl, { max: 1 });

  const workspaceRows = await sql`
    SELECT
      w.id, w.slug, w.name, w.owner_email, w.plan, w.subscription_status,
      w.business_name, w.notification_email, w.twilio_account_sid,
      w.twilio_phone_number, w.created_at, w.updated_at,
      COALESCE(wpn.phone_number, w.twilio_phone_number) AS mapped_phone_number,
      wpn.twilio_sid AS phone_number_sid,
      wpn.enabled AS phone_number_enabled,
      pr.id AS provisioning_request_id,
      pr.business_name AS provisioning_business_name,
      pr.owner_email AS provisioning_owner_email,
      pr.status AS provisioning_status,
      pr.source AS provisioning_source
    FROM workspaces w
    LEFT JOIN workspace_phone_numbers wpn ON wpn.workspace_id = w.id
    LEFT JOIN provisioning_requests pr ON pr.workspace_id = w.id
    ORDER BY w.created_at DESC, w.id DESC
  `;

  const orphanProvisioningRows = await sql`
    SELECT id, workspace_id, business_name, owner_email, requested_plan, status, source, created_at, updated_at
    FROM provisioning_requests
    WHERE workspace_id IS NULL
    ORDER BY created_at DESC
  `;

  const plan = cleanupPlanFromRows(workspaceRows);
  const orphanPlan = orphanProvisioningRows.filter(isLikelyTest);

  const summary = {
    ok: true,
    apply: APPLY,
    matched_workspaces: plan.length,
    matched_orphan_provisioning_requests: orphanPlan.length,
    twilio_configured: Boolean(twilioAccountSid && twilioAuthToken),
    workspaces: plan.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      owner_email: redactEmail(row.owner_email),
      plan: row.plan,
      subscription_status: row.subscription_status,
      business_name: row.business_name,
      twilio_subaccount_sid: redactSid(row.twilio_account_sid),
      phone_number: redactPhone(row.mapped_phone_number),
      phone_number_sid: redactSid(row.phone_number_sid),
      provisioning_request_id: row.provisioning_request_id,
      provisioning_status: row.provisioning_status,
      provisioning_source: row.provisioning_source,
      created_at: row.created_at,
    })),
    orphan_provisioning_requests: orphanPlan.map((row) => ({
      id: row.id,
      business_name: row.business_name,
      owner_email: redactEmail(row.owner_email),
      requested_plan: row.requested_plan,
      status: row.status,
      source: row.source,
      created_at: row.created_at,
    })),
    actions: [],
  };

  if (!APPLY) {
    await sql.end();
    fs.writeFileSync(path.join(OUT_DIR, "test-workspace-cleanup-dry-run.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const twilioClient = twilioAccountSid && twilioAuthToken ? twilio(twilioAccountSid, twilioAuthToken) : null;

  for (const row of plan) {
    const workspaceId = Number(row.id);
    const subaccountSid = String(row.twilio_account_sid || "").trim();
    const phoneSid = String(row.phone_number_sid || "").trim();

    if (twilioClient && subaccountSid && phoneSid && phoneSid.startsWith("PN")) {
      try {
        await twilioClient.api.v2010.accounts(subaccountSid).incomingPhoneNumbers(phoneSid).remove();
        summary.actions.push({ action: "twilio_phone_released", workspace_id: workspaceId, phone_number_sid: redactSid(phoneSid) });
      } catch (err) {
        summary.actions.push({ action: "twilio_phone_release_failed", workspace_id: workspaceId, phone_number_sid: redactSid(phoneSid), error: err?.message || String(err) });
      }
    }

    if (twilioClient && subaccountSid && subaccountSid.startsWith("AC") && subaccountSid !== twilioAccountSid) {
      try {
        await twilioClient.api.v2010.accounts(subaccountSid).update({ status: "closed" });
        summary.actions.push({ action: "twilio_subaccount_closed", workspace_id: workspaceId, subaccount_sid: redactSid(subaccountSid) });
      } catch (err) {
        summary.actions.push({ action: "twilio_subaccount_close_failed", workspace_id: workspaceId, subaccount_sid: redactSid(subaccountSid), error: err?.message || String(err) });
      }
    }

    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    summary.actions.push({ action: "workspace_deleted", workspace_id: workspaceId });
  }

  for (const row of orphanPlan) {
    await sql`DELETE FROM provisioning_requests WHERE id = ${Number(row.id)}`;
    summary.actions.push({ action: "orphan_provisioning_request_deleted", provisioning_request_id: Number(row.id) });
  }

  await sql.end();
  fs.writeFileSync(path.join(OUT_DIR, "test-workspace-cleanup-apply.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
  process.exit(1);
});
