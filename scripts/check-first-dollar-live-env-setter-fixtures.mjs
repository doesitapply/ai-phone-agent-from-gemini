#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const setter = path.join(repoRoot, 'scripts', 'set-first-dollar-live-env.sh');
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'smirk-first-dollar-setter-'));
const fixtureBin = path.join(fixtureRoot, 'bin');
const railwayLog = path.join(fixtureRoot, 'railway.log');

function writeExecutable(name, body) {
  const target = path.join(fixtureBin, name);
  writeFileSync(target, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(target, 0o700);
}

function clearRailwayLog() {
  writeFileSync(railwayLog, '');
}

function recordedRailwayCalls() {
  return existsSync(railwayLog) ? readFileSync(railwayLog, 'utf8').trim() : '';
}

const baseEnv = {
  APP_URL: 'https://ai-phone-agent-production-6811.up.railway.app',
  STRIPE_PAYMENT_LINK_STARTER: 'https://buy.stripe.com/starter_fixture',
  STRIPE_PAYMENT_LINK_STARTER_ID: 'plink_starter_fixture',
  DISABLE_STRIPE_PAYMENT_LINK_PRO: 'true',
  DISABLE_STRIPE_PAYMENT_LINK_ENTERPRISE: 'true',
  STRIPE_REVENUE_READ_KEY: 'rk_live_fixture_revenue_123456789',
  STRIPE_BILLING_PORTAL_KEY: 'rk_live_fixture_portal_123456789',
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_fixture_123456789',
  SMIRK_NATIVE_CHECKOUT_ENABLED: 'false',
  PHONE_AGENT_PROVISIONING_SECRET: 'fixture-provisioning-secret',
  AUTO_FULFILL_PROVISIONING_REQUESTS: 'true',
  SMIRK_CUSTOMER_POLICY_APPROVED_VERSION: 'fixture-policy-v1',
  RESEND_API_KEY: 're_fixture_123456789',
  FROM_EMAIL: 'SMIRK <alerts@smirkcalls.com>',
  NOTIFICATION_EMAIL: 'operator@smirkcalls.com',
  BOOKING_LINK: 'https://calendly.com/smirkcalls/setup',
  LANDING_APP_URL: 'https://smirkcalls.com',
  GOOGLE_OAUTH_CLIENT_ID: 'fixture.apps.googleusercontent.com',
  TWILIO_ACCOUNT_SID: 'ACfixture123456789',
  TWILIO_AUTH_TOKEN: 'fixture-twilio-token',
  WORKSPACE_SECRET_ENCRYPTION_KEY: 'fixture-encryption-key-at-least-32-characters',
  OPENROUTER_API_KEY: 'sk-or-v1-fixture',
  OPENROUTER_ENABLED: 'true',
  FAST_LIVE_CALLS: 'false',
  CARTESIA_API_KEY: 'fixture-cartesia-key',
  RAILWAY_API_TOKEN: 'fixture-railway-token',
};

function run(overrides = {}, args = []) {
  clearRailwayLog();
  const env = {
    ...process.env,
    ...baseEnv,
    ...overrides,
    PATH: `${fixtureBin}:${process.env.PATH || ''}`,
    SMIRK_FIXTURE_RAILWAY_LOG: railwayLog,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) delete env[key];
  }
  return spawnSync('bash', [setter, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function expectRejectedWithoutMutation(label, overrides, expected) {
  const result = run(overrides);
  assert.notEqual(result.status, 0, `${label} must fail closed`);
  assert.match(output(result), expected, `${label} must explain the exact blocker`);
  assert.equal(recordedRailwayCalls(), '', `${label} must fail before Railway mutation`);
}

try {
  mkdirSync(fixtureBin);
  writeExecutable('node', 'exit 0');
  writeExecutable('npm', 'exit 0');
  writeExecutable('railway', 'printf "%s\\n" "$*" >> "$SMIRK_FIXTURE_RAILWAY_LOG"');

  const dryRun = run({}, ['--dry-run']);
  assert.equal(dryRun.status, 0, `Starter-only dry run must pass fixture preflight: ${output(dryRun)}`);
  assert.equal(recordedRailwayCalls(), '', 'dry run must never invoke Railway');
  assert.match(dryRun.stdout, /SMIRK_NATIVE_CHECKOUT_ENABLED=false/, 'dry run must force native Checkout off');
  assert.match(dryRun.stdout, /STRIPE_PAYMENT_LINK_PRO=/, 'dry run must clear Pro URL');
  assert.match(dryRun.stdout, /STRIPE_PAYMENT_LINK_PRO_ID=/, 'dry run must clear Pro ID');
  assert.match(dryRun.stdout, /STRIPE_PAYMENT_LINK_ENTERPRISE=/, 'dry run must clear Enterprise URL');
  assert.match(dryRun.stdout, /STRIPE_PAYMENT_LINK_ENTERPRISE_ID=/, 'dry run must clear Enterprise ID');

  expectRejectedWithoutMutation(
    'live-env approval without Starter acceptance',
    { CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE: 'apply-smirk-first-dollar-live-env' },
    /CONFIRM_SMIRK_REAL_STARTER_CHECKOUT=accept-buyer-initiated-starter-197-monthly/,
  );
  expectRejectedWithoutMutation(
    'Starter acceptance without live-env approval',
    { CONFIRM_SMIRK_REAL_STARTER_CHECKOUT: 'accept-buyer-initiated-starter-197-monthly' },
    /CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env/,
  );
  expectRejectedWithoutMutation(
    'wrong Starter acceptance value',
    {
      CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE: 'apply-smirk-first-dollar-live-env',
      CONFIRM_SMIRK_REAL_STARTER_CHECKOUT: 'yes',
    },
    /CONFIRM_SMIRK_REAL_STARTER_CHECKOUT=accept-buyer-initiated-starter-197-monthly/,
  );
  expectRejectedWithoutMutation(
    'Pro Payment Link attempt',
    { STRIPE_PAYMENT_LINK_PRO: 'https://buy.stripe.com/pro_fixture', STRIPE_PAYMENT_LINK_PRO_ID: 'plink_pro_fixture' },
    /Starter-only setter cannot enable PRO/,
  );
  expectRejectedWithoutMutation(
    'Enterprise Payment Link attempt',
    { STRIPE_PAYMENT_LINK_ENTERPRISE: 'https://buy.stripe.com/enterprise_fixture', STRIPE_PAYMENT_LINK_ENTERPRISE_ID: 'plink_enterprise_fixture' },
    /Starter-only setter cannot enable ENTERPRISE/,
  );
  expectRejectedWithoutMutation(
    'native Checkout attempt',
    { SMIRK_NATIVE_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_live_fixture_native_123456789' },
    /requires SMIRK_NATIVE_CHECKOUT_ENABLED=false/,
  );

  const approved = run({
    CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE: 'apply-smirk-first-dollar-live-env',
    CONFIRM_SMIRK_REAL_STARTER_CHECKOUT: 'accept-buyer-initiated-starter-197-monthly',
  });
  assert.equal(approved.status, 0, `both exact confirmations must permit the fake Railway write: ${output(approved)}`);
  const railwayCall = recordedRailwayCalls();
  assert.match(railwayCall, /^variable set /, 'approved path must invoke only the fake Railway variable setter');
  assert.match(railwayCall, /STRIPE_PAYMENT_LINK_STARTER=https:\/\/buy\.stripe\.com\/starter_fixture/, 'approved write must set the exact Starter URL');
  assert.match(railwayCall, /STRIPE_PAYMENT_LINK_PRO=\s/, 'approved write must clear Pro URL');
  assert.match(railwayCall, /STRIPE_PAYMENT_LINK_ENTERPRISE=\s/, 'approved write must clear Enterprise URL');
  assert.match(railwayCall, /SMIRK_NATIVE_CHECKOUT_ENABLED=false/, 'approved write must force native Checkout off');

  console.log('OK first-dollar live env setter is Starter-only, clears Pro/Enterprise, forces native Checkout off, and requires both exact approvals before mutation');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
