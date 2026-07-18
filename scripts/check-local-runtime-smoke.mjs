#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 3210);
const fetchTimeoutMs = Number(process.env.SMIRK_LOCAL_RUNTIME_FETCH_TIMEOUT_MS || 5_000);
const startupTimeoutMs = Number(process.env.SMIRK_LOCAL_RUNTIME_STARTUP_TIMEOUT_MS || 10_000);
const smokeOperatorApiKey = `smirk-local-runtime-smoke-${randomBytes(32).toString('hex')}`;
const serverEntry = fileURLToPath(new URL('../dist-server/server.mjs', import.meta.url));
const childCwd = dirname(serverEntry);
const isolatedSettingsPath = join(
  tmpdir(),
  `smirk-local-runtime-smoke-settings-${randomBytes(16).toString('hex')}`,
);

// Never copy process.env into this production child. That can leak credentials
// and enable startup integrations such as the OpenClaw WebSocket bridge.
const runtimeEnvironmentKeys = [
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ',
];
const runtimeEnvironment = Object.fromEntries(
  runtimeEnvironmentKeys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
const externalProviderEnvKeys = Object.freeze([
  'OPENCLAW_GATEWAY_URL', 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_AGENT_ID', 'OPENCLAW_MODEL', 'OPENCLAW_TIMEOUT_MS',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
  'STRIPE_SECRET_KEY', 'STRIPE_REVENUE_READ_KEY', 'STRIPE_BILLING_PORTAL_KEY',
  'STRIPE_BILLING_PORTAL_CONFIGURATION_ID', 'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PAYMENT_LINK_STARTER', 'STRIPE_PAYMENT_LINK_STARTER_ID', 'STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS',
  'STRIPE_PAYMENT_LINK_PRO', 'STRIPE_PAYMENT_LINK_PRO_ID',
  'STRIPE_PAYMENT_LINK_ENTERPRISE', 'STRIPE_PAYMENT_LINK_ENTERPRISE_ID',
  'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY',
  'CARTESIA_API_KEY', 'GOOGLE_TTS_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'FROM_EMAIL', 'FROM_NAME', 'OWNER_EMAIL',
  'OWNER_ALERT_EMAIL', 'NOTIFICATION_EMAIL', 'OPERATOR_EMAIL', 'SENDGRID_API_KEY',
  'MAILGUN_API_KEY', 'POSTMARK_SERVER_TOKEN', 'SMTP_URL',
  'WEBHOOK_URL', 'OUTBOUND_WEBHOOK_URL', 'HUBSPOT_ACCESS_TOKEN', 'SALESFORCE_ACCESS_TOKEN',
  'AIRTABLE_API_KEY', 'NOTION_API_KEY', 'CALENDLY_SIGNING_SECRET', 'TELEGRAM_WEBHOOK_SECRET',
  'APOLLO_API_KEY', 'GOOGLE_MAPS_API_KEY', 'GOOGLE_PLACES_API_KEY', 'SERPER_API_KEY', 'BRAVE_API_KEY',
  'HUMAN_TRANSFER_NUMBER', 'OPERATOR_ALERT_NUMBER', 'OWNER_PHONE',
  'PHONE_AGENT_API_KEY', 'PHONE_AGENT_PROVISIONING_SECRET', 'TEST_CALL_SECRET',
]);
const disabledOutboundEnv = Object.freeze({
  OPENCLAW_ENABLED: 'false',
  OPENCLAW_BRIDGE_ENABLED: 'false',
  OPENROUTER_ENABLED: 'false',
  ELEVENLABS_ENABLED: 'false',
  GOOGLE_TTS_ENABLED: 'false',
  SMS_ENABLED: 'false',
  SMS_ALLOW_NON_ALLOWLISTED: 'false',
  DEV_OUTBOUND_BYPASS: 'false',
  ENABLE_REAL_LAUNCH_APPROVALS: 'false',
  AUTO_FULFILL_PROVISIONING_REQUESTS: 'false',
  ALLOW_STRIPE_TEST_CHECKOUT: 'false',
  ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV: 'false',
  SMIRK_NATIVE_CHECKOUT_ENABLED: 'false',
});
const env = {
  ...runtimeEnvironment,
  ...disabledOutboundEnv,
  PORT: String(port),
  NODE_ENV: 'production',
  APP_URL: `http://127.0.0.1:${port}`,
  // Block production's /tmp/.env.local load. The bundled-server cwd also keeps
  // dotenv's fallback lookup away from credentials in the checkout root.
  SETTINGS_PATH: isolatedSettingsPath,
  // This is a packaging/auth smoke, not a production-data probe. The enclosing
  // readiness gate has separate authenticated live DB and entitlement checks.
  DATABASE_URL: '',
  // The production child intentionally does not load the checkout's .env.local.
  // Give this isolated process a one-run credential so the smoke can exercise
  // both rejection and authenticated access without depending on operator secrets.
  DASHBOARD_API_KEY: smokeOperatorApiKey,
};

function assertIsolatedChildEnv(childEnv) {
  const leakedProviderKeys = externalProviderEnvKeys.filter((key) => Object.hasOwn(childEnv, key));
  const enabledOutboundKeys = Object.entries(disabledOutboundEnv)
    .filter(([key, value]) => childEnv[key] !== value)
    .map(([key]) => key);
  if (
    leakedProviderKeys.length > 0
    || enabledOutboundKeys.length > 0
    || childEnv.DATABASE_URL !== ''
    || childEnv.DASHBOARD_API_KEY !== smokeOperatorApiKey
    || childEnv.SETTINGS_PATH !== isolatedSettingsPath
  ) {
    throw new Error(JSON.stringify({
      error: 'local-runtime-child-env-not-isolated',
      leakedProviderKeys,
      enabledOutboundKeys,
      databaseUrlBlank: childEnv.DATABASE_URL === '',
      ephemeralOperatorAuth: childEnv.DASHBOARD_API_KEY === smokeOperatorApiKey,
      isolatedSettingsPath: childEnv.SETTINGS_PATH === isolatedSettingsPath,
    }));
  }
}

assertIsolatedChildEnv(env);

const child = spawn(process.execPath, [serverEntry], {
  cwd: childCwd,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
child.stdout.on('data', (d) => { logs += String(d); });
child.stderr.on('data', (d) => { logs += String(d); });

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, ...detail }, null, 2));
  process.exit(1);
}

async function fetchText(path, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal, headers });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  } catch (error) {
    fail('local-runtime-fetch-failed', {
      path,
      port,
      timeoutMs: fetchTimeoutMs,
      detail: String(error?.message || error || 'unknown fetch failure'),
    });
  } finally {
    clearTimeout(timeout);
  }
}

try {
  let started = false;
  const startChecks = Math.max(1, Math.ceil(startupTimeoutMs / 500));
  for (let i = 0; i < startChecks; i += 1) {
    await wait(500);
    if (/Server running on http:\/\/localhost:|SMIRK missed-call recovery started/i.test(logs)) {
      started = true;
      break;
    }
  }

  if (!started) {
    fail('local-runtime-startup-timeout', {
      port,
      timeoutMs: startupTimeoutMs,
      logs: logs.trim().slice(-2000),
    });
  }

  const health = await fetchText('/health');
  const version = await fetchText('/api/version');
  const unauthenticatedTasks = await fetchText('/api/tasks');
  const tasks = await fetchText('/api/tasks', { 'X-Api-Key': smokeOperatorApiKey });

  const healthOk = health.status === 200 && /"status"\s*:/i.test(health.text);
  const versionOk = version.status === 200 && /"version"\s*:/i.test(version.text);
  const unauthenticatedTasksOk = unauthenticatedTasks.status === 401 && /Unauthorized/i.test(unauthenticatedTasks.text);
  const tasksOk = tasks.status === 200 && /"tasks"\s*:/i.test(tasks.text);
  let healthIsolation;
  try {
    const payload = JSON.parse(health.text);
    healthIsolation = {
      databaseDisabled: payload?.db?.enabled === false,
      twilioDisabled: payload?.twilioConfigured === false,
      aiProvidersDisabled: payload?.aiConfigured === false,
      stripePaymentLinksDisabled: payload?.paymentLinksConfigured === false,
      ownerEmailDisabled: payload?.ownerEmailDeliveryConfigured === false,
    };
  } catch {
    healthIsolation = { invalidHealthJson: true };
  }
  const providerIsolationOk = Object.values(healthIsolation).every((value) => value === true);

  console.log(`GET /health -> ${health.status}`);
  console.log(health.text.slice(0, 200));
  console.log(`GET /api/version -> ${version.status}`);
  console.log(version.text.slice(0, 200));
  console.log(`GET /api/tasks without auth -> ${unauthenticatedTasks.status}`);
  console.log(unauthenticatedTasks.text.slice(0, 200));
  console.log(`GET /api/tasks with ephemeral operator auth -> ${tasks.status}`);
  console.log(tasks.text.slice(0, 200));

  if (!healthOk || !versionOk || !unauthenticatedTasksOk || !tasksOk || !providerIsolationOk) {
    fail('local-runtime-smoke-failed', {
      healthOk,
      versionOk,
      unauthenticatedTasksOk,
      tasksOk,
      providerIsolationOk,
      healthIsolation,
      healthStatus: health.status,
      versionStatus: version.status,
      unauthenticatedTasksStatus: unauthenticatedTasks.status,
      tasksStatus: tasks.status,
    });
  }

  console.log('OK local runtime smoke passed with DB, OpenClaw, external providers, Twilio, Stripe, email, and outbound actions isolated');
} finally {
  child.kill('SIGTERM');
  await wait(300);
}
