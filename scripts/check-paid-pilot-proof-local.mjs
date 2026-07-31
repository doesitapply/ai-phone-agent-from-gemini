#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import postgres from 'postgres';

const port = Number(process.env.PORT || 3317);
const appUrl = `http://127.0.0.1:${port}`;
const databaseUrl = process.env.DATABASE_URL || 'postgresql://cameronchurch@localhost/smirk_revenue_proof_20260731';
const webhookSecret = `whsec_local_revenue_proof_${randomBytes(24).toString('hex')}`;
const checkoutSessionId = 'cs_test_smirk_paid_handoff_local_revenue_proof_20260731';
const stripeEventId = 'evt_smirk_paid_handoff_local_revenue_proof_20260731';
const paymentLinkId = 'plink_smirk_local_revenue_proof_20260731';
const customerId = 'cus_smirk_local_revenue_proof_20260731';
const subscriptionId = 'sub_smirk_local_revenue_proof_20260731';
const buyerEmail = 'smoke+stripe-local-revenue-proof@proof.invalid';
const ownerPhone = '+17755550199';
const sql = postgres(databaseUrl, { max: 1 });

const event = {
  id: stripeEventId,
  object: 'event',
  type: 'checkout.session.completed',
  livemode: false,
  created: Math.floor(Date.now() / 1000),
  data: {
    object: {
      id: checkoutSessionId,
      object: 'checkout.session',
      mode: 'subscription',
      livemode: false,
      status: 'complete',
      payment_status: 'paid',
      currency: 'usd',
      amount_subtotal: 19700,
      amount_total: 19700,
      customer: customerId,
      subscription: subscriptionId,
      customer_email: buyerEmail,
      customer_details: {
        email: buyerEmail,
        name: 'Synthetic Proof Buyer',
        phone: ownerPhone,
        address: { line1: '1 Proof Way', city: 'Reno', state: 'NV', postal_code: '89501', country: 'US' },
      },
      consent_collection: { terms_of_service: 'required' },
      consent: { terms_of_service: 'accepted' },
      automatic_tax: { enabled: true, status: 'complete' },
      metadata: {
        source: 'gate3-stripe-webhook-smoke',
        plan: 'starter',
        business_name: 'Synthetic Paid Pilot Plumbing',
        owner_email: buyerEmail,
        owner_phone: ownerPhone,
        mode: 'missed_call_recovery',
      },
    },
  },
};

function sign(body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', webhookSecret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function postSigned(body) {
  const response = await fetch(`${appUrl}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
    body,
  });
  return { status: response.status, body: await response.text() };
}

const childEnv = {
  PATH: process.env.PATH || '',
  HOME: process.env.HOME || '',
  TMPDIR: process.env.TMPDIR || '/tmp',
  NODE_ENV: 'production',
  PORT: String(port),
  APP_URL: appUrl,
  DATABASE_URL: databaseUrl,
  DASHBOARD_API_KEY: `local-proof-${randomBytes(24).toString('hex')}`,
  STRIPE_WEBHOOK_SECRET: webhookSecret,
  STRIPE_PAYMENT_LINK_STARTER: `https://buy.stripe.com/${paymentLinkId}`,
  STRIPE_PAYMENT_LINK_STARTER_ID: paymentLinkId,
  STRIPE_PAYMENT_LINK_STARTER_FULFILLMENT_IDS: paymentLinkId,
  SMIRK_STRIPE_SMOKE_EVENT_ID: stripeEventId,
  SMIRK_STRIPE_SMOKE_SESSION_ID: checkoutSessionId,
  AUTO_FULFILL_PROVISIONING_REQUESTS: 'true',
  ALLOW_STRIPE_TEST_CHECKOUT: 'false',
  ALLOW_UNSIGNED_STRIPE_WEBHOOK_DEV: 'false',
  SMS_ENABLED: 'false',
  OPENCLAW_ENABLED: 'false',
  OPENCLAW_BRIDGE_ENABLED: 'false',
  OPENROUTER_ENABLED: 'false',
  ELEVENLABS_ENABLED: 'false',
  GOOGLE_TTS_ENABLED: 'false',
  RESEND_API_KEY: '',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_PHONE_NUMBER: '',
  SMIRK_CUSTOMER_POLICY_APPROVED_VERSION: 'synthetic-proof-only',
};

const child = spawn(process.execPath, ['dist-server/server.mjs'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (chunk) => { logs += String(chunk); });
child.stderr.on('data', (chunk) => { logs += String(chunk); });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(250);
    try {
      const health = await fetch(`${appUrl}/health`);
      const schema = await sql`SELECT to_regclass('public.stripe_checkout_fulfillments') AS table_name`;
      if (health.ok && schema[0]?.table_name) { ready = true; break; }
    } catch {}
  }
  if (!ready) throw new Error(`Local proof server did not start: ${logs.slice(-1500)}`);

  const body = JSON.stringify(event);
  const first = await postSigned(body);
  const replay = await postSigned(body);
  if (first.status !== 200 || replay.status !== 200) {
    throw new Error(`Signed webhook failed: first=${first.status} replay=${replay.status} body=${first.body.slice(0, 300)}`);
  }

  const [workspaceRows, requestRows, fulfillmentRows, activationRows] = await Promise.all([
    sql`SELECT id, plan, subscription_status, twilio_phone_number FROM workspaces WHERE stripe_customer_id = ${customerId} AND stripe_subscription_id = ${subscriptionId}`,
    sql`SELECT id, workspace_id, status, requested_plan, requested_mode FROM provisioning_requests WHERE request_id = ${checkoutSessionId} AND source = 'stripe_checkout_completed'`,
    sql`SELECT checkout_session_id, event_id, status FROM stripe_checkout_fulfillments WHERE checkout_session_id = ${checkoutSessionId}`,
    sql`SELECT event_type, status, detail FROM activation_events WHERE workspace_id IN (SELECT id FROM workspaces WHERE stripe_customer_id = ${customerId}) ORDER BY id`,
  ]);

  const telephonyEvents = activationRows.filter((row) => row.event_type === 'telephony_provisioning_required');
  const result = {
    proof_type: 'local_signed_synthetic_paid_checkout',
    real_charge_created: false,
    external_messages_sent: false,
    signed_webhook_http: [first.status, replay.status],
    exact_counts: {
      workspace: workspaceRows.length,
      activation_task: requestRows.length,
      fulfillment_receipt: fulfillmentRows.length,
      manual_telephony_event: telephonyEvents.length,
    },
    purchased_plan: requestRows[0]?.requested_plan || null,
    purchased_mode: requestRows[0]?.requested_mode || null,
    fulfillment_status: fulfillmentRows[0]?.status || null,
    activation_status: requestRows[0]?.status || null,
    workspace_id: workspaceRows[0]?.id || null,
    provisioning_request_id: requestRows[0]?.id || null,
    replay_idempotent: workspaceRows.length === 1 && requestRows.length === 1 && fulfillmentRows.length === 1,
    activation_complete_claimed: false,
    telephony_reason: telephonyEvents[0]?.detail?.reason || null,
  };

  if (result.exact_counts.workspace !== 1) throw new Error('Expected exactly one workspace');
  if (result.exact_counts.activation_task !== 1) throw new Error('Expected exactly one activation task');
  if (result.exact_counts.fulfillment_receipt !== 1) throw new Error('Expected exactly one fulfillment receipt');
  if (result.exact_counts.manual_telephony_event !== 1) throw new Error('Expected exactly one manual telephony event');
  if (result.purchased_plan !== 'starter') throw new Error('Purchased-plan validation did not preserve Starter');
  if (result.activation_status !== 'PENDING_MANUAL_TELEPHONY') throw new Error('Missing explicit manual telephony state');
  if (result.fulfillment_status !== 'complete') throw new Error('Fulfillment receipt is not complete');
  if (!result.replay_idempotent) throw new Error('Webhook replay created duplicates');

  console.log(JSON.stringify(result, null, 2));
} finally {
  child.kill('SIGTERM');
  await sql.end({ timeout: 1 });
}
