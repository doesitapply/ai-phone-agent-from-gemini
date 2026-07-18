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
  STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS: 'plink_starter_fixture',
  DISABLE_STRIPE_PAYMENT_LINK_PRO: 'true',
  DISABLE_STRIPE_PAYMENT_LINK_ENTERPRISE: 'true',
  STRIPE_REVENUE_READ_KEY: 'rk_live_fixture_revenue_123456789',
  STRIPE_BILLING_PORTAL_KEY: 'rk_live_fixture_portal_123456789',
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_fixture_123456789',
  SMIRK_NATIVE_CHECKOUT_ENABLED: 'false',
  PHONE_AGENT_PROVISIONING_SECRET: 'smirk-fixture-provisioning-secret-123456789',
  AUTO_FULFILL_PROVISIONING_REQUESTS: 'true',
  SMIRK_CUSTOMER_POLICY_APPROVED_VERSION: 'fixture-policy-v1',
  RESEND_API_KEY: 're_fixture_123456789',
  FROM_EMAIL: 'SMIRK <alerts@smirkcalls.com>',
  NOTIFICATION_EMAIL: 'operator@smirkcalls.com',
  OWNER_ALERT_EMAIL: undefined,
  OWNER_EMAIL: undefined,
  OPERATOR_EMAIL: undefined,
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
  CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE: undefined,
  CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST: undefined,
  CONFIRM_SMIRK_REAL_STARTER_CHECKOUT: undefined,
  CONFIRM_SMIRK_FIRST_DOLLAR_ACTIVATION_DEPLOY: undefined,
};

function run(overrides = {}, args = []) {
  clearRailwayLog();
  const env = {
    ...process.env,
    ...baseEnv,
    ...overrides,
    PATH: `${fixtureBin}:${process.env.PATH || ''}`,
    SMIRK_FIXTURE_RAILWAY_LOG: railwayLog,
    SMIRK_FIXTURE_REAL_NODE: process.execPath,
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
  writeExecutable('node', `
if [[ "\${1:-}" == *compute-first-dollar-pending-env-manifest.mjs ]]; then
  exec "$SMIRK_FIXTURE_REAL_NODE" "$@"
fi
if [[ "\${1:-}" == *check-payment-link-fulfillment-ids.mjs ]]; then
  current="\${2:-}"
  ids="\${3:-}"
  if [[ ",\${ids}," != *",\${current},"* ]]; then
    echo "FAIL starter-current-payment-link-id-not-allowlisted" >&2
    exit 1
  fi
fi
if [[ "\${1:-}" == *check-proposed-payment-links.mjs && "\${SMIRK_FIXTURE_FAIL_PROPOSED_LINKS:-0}" == "1" ]]; then
  echo "FAIL fixture proposed Payment Link provider proof" >&2
  exit 1
fi
if [[ "\${1:-}" == *check-exclusive-first-dollar-payment-links.mjs && "\${SMIRK_FIXTURE_FAIL_EXCLUSIVITY:-0}" == "1" ]]; then
  echo "FAIL fixture active legacy Payment Link exclusivity" >&2
  exit 1
fi
exit 0`);
  writeExecutable('npm', 'exit 0');
  writeExecutable('railway', 'printf "%s\\n" "$*" >> "$SMIRK_FIXTURE_RAILWAY_LOG"');

  const dryRun = run({}, ['--dry-run']);
  assert.equal(dryRun.status, 0, `Starter-only dry run must pass fixture preflight: ${output(dryRun)}`);
  assert.equal(recordedRailwayCalls(), '', 'dry run must never invoke Railway');
  assert.match(dryRun.stdout, /SMIRK_NATIVE_CHECKOUT_ENABLED=false/, 'dry run must force native Checkout off');
  assert.match(dryRun.stdout, /STRIPE_PAYMENT_LINK_PRO=/, 'dry run must clear Pro URL');
  assert.match(dryRun.stdout, /STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS=plink_starter_fixture/, 'dry run must preserve the exact current/historical fulfillment ID allowlist');
  assert.match(dryRun.stdout, /STRIPE_PAYMENT_LINK_PRO_ID=/, 'dry run must clear Pro ID');
  assert.match(dryRun.stdout, /STRIPE_PAYMENT_LINK_ENTERPRISE=/, 'dry run must clear Enterprise URL');
  assert.match(dryRun.stdout, /STRIPE_PAYMENT_LINK_ENTERPRISE_ID=/, 'dry run must clear Enterprise ID');
  assert.match(dryRun.stdout, /project=90599f03-6d6f-4044-8933-e0301be67a82 service=96bcd6e7-9487-4197-bcd1-a6bd0546e6b2 environment=22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a/, 'dry run must disclose the exact pinned Railway production target');
  assert.match(dryRun.stdout, /--service 96bcd6e7-9487-4197-bcd1-a6bd0546e6b2 --environment 22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a --skip-deploys/, 'dry run must pin the service/environment and suppress implicit deploys');
  const digestMatch = dryRun.stdout.match(/PENDING ENV SHA-256: ([a-f0-9]{64})/);
  assert.ok(digestMatch, 'dry run must print the exact pending-manifest SHA-256');
  const pendingDigest = digestMatch[1];
  assert.match(dryRun.stdout, /PENDING ENV COMMIT: [a-f0-9]{40}/, 'dry run must bind exact HEAD');
  assert.match(dryRun.stdout, /PENDING ENV ASSIGNMENT COUNT: 31/, 'dry run must disclose the complete assignment count');
  assert.match(dryRun.stdout, /PENDING ENV ORDERED KEY LIST: APP_URL,STRIPE_REVENUE_READ_KEY/, 'dry run must disclose ordered keys without values');
  assert.doesNotMatch(dryRun.stdout, /rk_live_fixture_revenue_123456789|rk_live_fixture_portal_123456789|smirk-fixture-provisioning-secret-123456789|re_fixture_123456789|fixture-twilio-token|fixture-encryption-key-at-least-32-characters|sk-or-v1-fixture|fixture-cartesia-key/, 'dry run must never disclose a secret value');
  assert.match(dryRun.stdout, new RegExp(`CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST=${pendingDigest}`), 'dry run must print the exact digest-bound staging confirmation');

  expectRejectedWithoutMutation(
    'weak provisioning secret',
    { PHONE_AGENT_PROVISIONING_SECRET: 'short-secret' },
    /dedicated non-placeholder secret of at least 32 characters/,
  );
  expectRejectedWithoutMutation(
    'documented provisioning-secret placeholder',
    { PHONE_AGENT_PROVISIONING_SECRET: 'replace-with-matching-landing-secret' },
    /dedicated non-placeholder secret of at least 32 characters/,
  );
  expectRejectedWithoutMutation(
    'conflicting stale alert alias',
    { OWNER_EMAIL: 'stale-recipient@smirkcalls.com' },
    /OWNER_EMAIL conflicts with the reviewed NOTIFICATION_EMAIL recipient/,
  );
  expectRejectedWithoutMutation(
    'proposed Starter provider proof failure',
    { SMIRK_FIXTURE_FAIL_PROPOSED_LINKS: '1' },
    /fixture proposed Payment Link provider proof/,
  );
  expectRejectedWithoutMutation(
    'active legacy Payment Link exclusivity failure',
    { SMIRK_FIXTURE_FAIL_EXCLUSIVITY: '1' },
    /fixture active legacy Payment Link exclusivity/,
  );

  expectRejectedWithoutMutation(
    'live-env approval without exact pending digest',
    { CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE: 'apply-smirk-first-dollar-live-env' },
    new RegExp(`CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST=${pendingDigest}`),
  );
  expectRejectedWithoutMutation(
    'pending digest without live-env approval',
    { CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST: pendingDigest },
    /CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE=apply-smirk-first-dollar-live-env/,
  );
  expectRejectedWithoutMutation(
    'wrong pending digest',
    {
      CONFIRM_SMIRK_FIRST_DOLLAR_LIVE_ENV_WRITE: 'apply-smirk-first-dollar-live-env',
      CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST: '0'.repeat(64),
    },
    new RegExp(`CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST=${pendingDigest}`),
  );
  expectRejectedWithoutMutation(
    'Pro Payment Link attempt',
    { STRIPE_PAYMENT_LINK_PRO: 'https://buy.stripe.com/pro_fixture', STRIPE_PAYMENT_LINK_PRO_ID: 'plink_pro_fixture' },
    /Starter-only setter cannot enable PRO/,
  );
  expectRejectedWithoutMutation(
    'Starter fulfillment allowlist omits current ID',
    { STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS: 'plink_prior_fixture' },
    /starter-current-payment-link-id-not-allowlisted|Starter fulfillment Payment Link ID allowlist is invalid/,
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
    CONFIRM_SMIRK_FIRST_DOLLAR_PENDING_ENV_DIGEST: pendingDigest,
  });
  assert.equal(approved.status, 0, `write plus exact digest must permit inert staging without real-checkout authority: ${output(approved)}`);
  const railwayCall = recordedRailwayCalls();
  assert.match(railwayCall, /^variable set /, 'approved path must invoke only the fake Railway variable setter');
  assert.match(railwayCall, /--service 96bcd6e7-9487-4197-bcd1-a6bd0546e6b2 --environment 22e0a5a3-43bf-4b6c-8fa6-635e7c94b84a --skip-deploys/, 'approved path must pin the target and suppress implicit deploys');
  assert.match(railwayCall, /STRIPE_PAYMENT_LINK_STARTER=https:\/\/buy\.stripe\.com\/starter_fixture/, 'approved write must set the exact Starter URL');
  assert.match(railwayCall, /STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS=plink_starter_fixture/, 'approved write must preserve the exact fulfillment ID allowlist');
  assert.match(railwayCall, /STRIPE_PAYMENT_LINK_PRO=\s/, 'approved write must clear Pro URL');
  assert.match(railwayCall, /STRIPE_PAYMENT_LINK_ENTERPRISE=\s/, 'approved write must clear Enterprise URL');
  assert.match(railwayCall, /SMIRK_NATIVE_CHECKOUT_ENABLED=false/, 'approved write must force native Checkout off');
  assert.match(railwayCall, /NOTIFICATION_EMAIL=operator@smirkcalls\.com/, 'approved write must set the reviewed canonical alert recipient');
  assert.match(railwayCall, /OWNER_ALERT_EMAIL=operator@smirkcalls\.com/, 'approved write must overwrite the owner-alert alias');
  assert.match(railwayCall, /OWNER_EMAIL=operator@smirkcalls\.com/, 'approved write must overwrite the owner alias');
  assert.match(railwayCall, /OPERATOR_EMAIL=operator@smirkcalls\.com/, 'approved write must overwrite the operator alias');
  assert.match(railwayCall, new RegExp(`SMIRK_PENDING_FIRST_DOLLAR_ENV_DIGEST=${pendingDigest}`), 'approved staging write must persist the exact digest sentinel');
  assert.match(railwayCall, /SMIRK_PENDING_FIRST_DOLLAR_ENV_KEYS=APP_URL,STRIPE_REVENUE_READ_KEY/, 'approved staging write must persist the complete ordered key list');
  assert.match(railwayCall, /SMIRK_PENDING_FIRST_DOLLAR_ENV_COMMIT=[a-f0-9]{40}/, 'approved staging write must persist the exact commit sentinel');
  assert.match(railwayCall, /SMIRK_PENDING_FIRST_DOLLAR_ENV_SCHEMA=1/, 'approved staging write must persist the manifest schema sentinel');
  assert.equal(railwayCall.split(/\r?\n/).length, 1, 'staging must invoke Railway exactly once');
  assert.doesNotMatch(railwayCall, /^(?:railway )?up(?:\s|$)/, 'staging must never trigger a Railway deploy');
  assert.match(approved.stdout, /checkout has not been exposed by this staging write/, 'staging disclosure must state that checkout remains inactive');

  console.log('OK first-dollar live env setter is Starter-only and stages a digest-bound pending manifest with --skip-deploys without requiring real-checkout authority');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
