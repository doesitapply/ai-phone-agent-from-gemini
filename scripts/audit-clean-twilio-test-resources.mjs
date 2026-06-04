#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import twilio from "twilio";

const APPLY = process.argv.includes("--apply");
const HELP = process.argv.includes("--help") || process.argv.includes("-h");
const CONFIRM = String(process.env.CONFIRM_TWILIO_TEST_CLEANUP || "").trim();
const REQUIRE_CONFIRM = "close-test-subaccounts";
const OUT_DIR = path.resolve("output");

if (HELP) {
  console.log([
    "Audit likely test/smoke Twilio subaccounts and phone numbers.",
    "",
    "Usage:",
    "  node scripts/audit-clean-twilio-test-resources.mjs",
    "  node scripts/audit-clean-twilio-test-resources.mjs --apply",
    "",
    "Dry run:",
    "  Writes output/twilio-test-resource-cleanup-dry-run.json and does not modify live resources.",
    "",
    "Apply:",
    `  Requires CONFIRM_TWILIO_TEST_CLEANUP=${REQUIRE_CONFIRM}.`,
    "  Releases matched phone numbers and closes matched test subaccounts.",
    "",
    "Inputs:",
    "  Uses TWILIO_* from the environment, .env.local/.env, or falls back to Railway variables.",
  ].join("\n"));
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

function loadRailwayVariables() {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    return {
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    };
  }
  for (const envPath of [process.env.SETTINGS_PATH || ".env.local", ".env"]) {
    const abs = path.resolve(envPath);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    const parsed = {};
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      parsed[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
    if (parsed.TWILIO_ACCOUNT_SID && parsed.TWILIO_AUTH_TOKEN) {
      return parsed;
    }
  }
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
  return digits.length >= 4 ? `***${digits.slice(-4)}` : null;
}

function redactSid(value) {
  const text = String(value || "").trim();
  return text ? `${text.slice(0, 4)}…${text.slice(-6)}` : null;
}

function isPlaceholderSecret(value) {
  const text = String(value || "").trim().toLowerCase();
  return !text || /^x+$/.test(text) || text.includes("your_") || text.includes("placeholder");
}

function validateTwilioCredentials({ sid, token }) {
  if (!/^AC[a-fA-F0-9]{32}$/.test(sid)) {
    throw new Error(
      `Invalid TWILIO_ACCOUNT_SID (${redactSid(sid)}). Use the real master Account SID from Twilio; it must start with AC followed by 32 hex characters.`,
    );
  }
  if (isPlaceholderSecret(token)) {
    throw new Error("Invalid TWILIO_AUTH_TOKEN. Replace the placeholder token with the real Twilio auth token.");
  }
}

function isTestAccount(account) {
  const name = String(account.friendlyName || "").toLowerCase();
  return /\b(test|smoke|stripe|webhook|buyer auth|trial test)\b/.test(name);
}

async function listNumbersForAccount(client, accountSid) {
  try {
    return await client.api.v2010.accounts(accountSid).incomingPhoneNumbers.list({ limit: 100 });
  } catch (err) {
    return [{ error: err?.message || String(err) }];
  }
}

async function main() {
  if (APPLY && CONFIRM !== REQUIRE_CONFIRM) {
    console.error(JSON.stringify({
      ok: false,
      error: "missing-confirmation",
      message: `Rerun with CONFIRM_TWILIO_TEST_CLEANUP=${REQUIRE_CONFIRM} to release numbers and close matched test subaccounts.`,
    }, null, 2));
    process.exit(1);
  }

  const vars = loadRailwayVariables();
  const sid = String(vars.TWILIO_ACCOUNT_SID || "").trim();
  const token = String(vars.TWILIO_AUTH_TOKEN || "").trim();
  if (!sid || !token) throw new Error("Twilio master credentials missing");
  validateTwilioCredentials({ sid, token });

  const client = twilio(sid, token);
  const accounts = await client.api.v2010.accounts.list({ limit: 100 });
  const matched = accounts.filter((account) => account.sid !== sid && account.status !== "closed" && isTestAccount(account));

  const summary = {
    ok: true,
    apply: APPLY,
    total_subaccounts_seen: accounts.filter((account) => account.sid !== sid).length,
    matched_test_subaccounts: matched.length,
    subaccounts: [],
    actions: [],
  };

  for (const account of matched) {
    const numbers = await listNumbersForAccount(client, account.sid);
    summary.subaccounts.push({
      sid: redactSid(account.sid),
      friendly_name: account.friendlyName,
      status: account.status,
      date_created: account.dateCreated,
      numbers: numbers.map((number) => number.error ? { error: number.error } : {
        sid: redactSid(number.sid),
        phone_number: redactPhone(number.phoneNumber),
        friendly_name: number.friendlyName,
      }),
    });

    if (!APPLY) continue;

    for (const number of numbers) {
      if (number.error || !number.sid) continue;
      try {
        await client.api.v2010.accounts(account.sid).incomingPhoneNumbers(number.sid).remove();
        summary.actions.push({ action: "phone_released", subaccount_sid: redactSid(account.sid), phone_number_sid: redactSid(number.sid), phone_number: redactPhone(number.phoneNumber) });
      } catch (err) {
        summary.actions.push({ action: "phone_release_failed", subaccount_sid: redactSid(account.sid), phone_number_sid: redactSid(number.sid), error: err?.message || String(err) });
      }
    }

    try {
      await client.api.v2010.accounts(account.sid).update({ status: "closed" });
      summary.actions.push({ action: "subaccount_closed", subaccount_sid: redactSid(account.sid), friendly_name: account.friendlyName });
    } catch (err) {
      summary.actions.push({ action: "subaccount_close_failed", subaccount_sid: redactSid(account.sid), friendly_name: account.friendlyName, error: err?.message || String(err) });
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, APPLY ? "twilio-test-resource-cleanup-apply.json" : "twilio-test-resource-cleanup-dry-run.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
  process.exit(1);
});
