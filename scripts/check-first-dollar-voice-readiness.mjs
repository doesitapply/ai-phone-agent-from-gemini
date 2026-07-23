import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  describeFirstDollarVoiceHealth,
  evaluateFirstDollarVoiceReadiness,
} from '../src/first-dollar-voice-readiness.js';

const base = {
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'b'.repeat(32),
  WORKSPACE_SECRET_ENCRYPTION_KEY: 'fixture-encryption-secret-32-chars-minimum',
  OPENROUTER_API_KEY: `sk-or-v1-${'c'.repeat(32)}`,
  OPENROUTER_ENABLED: 'true',
  FAST_LIVE_CALLS: 'false',
  CARTESIA_API_KEY: 'cartesia-fixture-key-with-enough-entropy',
};

assert.equal(evaluateFirstDollarVoiceReadiness(base).ready, true, 'complete managed Twilio + streaming AI prerequisites must pass');

for (const key of [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'WORKSPACE_SECRET_ENCRYPTION_KEY',
  'OPENROUTER_API_KEY',
  'OPENROUTER_ENABLED',
  'FAST_LIVE_CALLS',
  'CARTESIA_API_KEY',
]) {
  const candidate = { ...base };
  delete candidate[key];
  assert.equal(evaluateFirstDollarVoiceReadiness(candidate).ready, false, `missing ${key} must fail first-dollar voice readiness`);
}

assert.equal(evaluateFirstDollarVoiceReadiness({ ...base, FAST_LIVE_CALLS: 'true' }).streamingAiReady, false, 'FAST_LIVE_CALLS=true bypasses the real streaming path and must fail');
assert.equal(evaluateFirstDollarVoiceReadiness({ ...base, OPENROUTER_ENABLED: 'false' }).streamingAiReady, false, 'disabled OpenRouter must fail streaming readiness');
assert.equal(evaluateFirstDollarVoiceReadiness({ ...base, TWILIO_ACCOUNT_SID: `AC${'z'.repeat(32)}` }).twilioProvisioningReady, false, 'malformed parent AccountSid must fail');

const withoutCartesia = { ...base };
delete withoutCartesia.CARTESIA_API_KEY;
const ttsMatrix = [
  { ELEVENLABS_API_KEY: 'elevenlabs-fixture-key-with-enough-entropy' },
  { GOOGLE_TTS_API_KEY: 'google-tts-fixture-key-with-enough-entropy' },
  { OPENAI_API_KEY: `sk-${'d'.repeat(32)}` },
  {
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account',
      client_email: 'tts@example.iam.gserviceaccount.com',
      private_key: `-----BEGIN PRIVATE KEY-----\n${'e'.repeat(64)}\n-----END PRIVATE KEY-----`,
    }),
  },
];
for (const providerEnv of ttsMatrix) {
  assert.equal(evaluateFirstDollarVoiceReadiness({ ...withoutCartesia, ...providerEnv }).ready, true, `enabled TTS matrix case ${Object.keys(providerEnv)[0]} must pass`);
}
assert.equal(evaluateFirstDollarVoiceReadiness({
  ...withoutCartesia,
  ELEVENLABS_API_KEY: 'elevenlabs-fixture-key-with-enough-entropy',
  ELEVENLABS_ENABLED: 'false',
}).streamingTtsReady, false, 'explicitly disabled TTS credentials must not count');
const disabledCredentialHealth = describeFirstDollarVoiceHealth({
  ...withoutCartesia,
  ELEVENLABS_API_KEY: 'elevenlabs-fixture-key-with-enough-entropy',
  ELEVENLABS_ENABLED: 'false',
});
assert.equal(disabledCredentialHealth.ready, false, 'a present but disabled credential must not make operator voice health pass');
assert.equal(disabledCredentialHealth.provider, null, 'a disabled provider must not be named as active');
assert.match(disabledCredentialHealth.detail, /premium streaming TTS provider/, 'operator voice health must explain the actual disabled-provider blocker');
const googleHealth = describeFirstDollarVoiceHealth({
  ...withoutCartesia,
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account',
    client_email: 'tts@example.iam.gserviceaccount.com',
    private_key: `-----BEGIN PRIVATE KEY-----\n${'g'.repeat(64)}\n-----END PRIVATE KEY-----`,
  }),
});
assert.equal(googleHealth.ready, true, 'an enabled Google service account must satisfy operator streaming voice health');
assert.equal(googleHealth.provider, 'google');
assert.equal(googleHealth.detail, 'Streaming AI + Google TTS');

const buyerRoutes = fs.readFileSync('src/routes/buyer-routes.ts', 'utf8');
const localEnvCheck = fs.readFileSync('scripts/check-first-dollar-env.mjs', 'utf8');
const railwayEnvCheck = fs.readFileSync('scripts/check-railway-first-dollar-env.mjs', 'utf8');
const railwaySetter = fs.readFileSync('scripts/set-first-dollar-live-env.sh', 'utf8');
const server = fs.readFileSync('server.ts', 'utf8');
const systemHealth = fs.readFileSync('src/routes/system-health-routes.ts', 'utf8');
assert.ok(buyerRoutes.includes('evaluateFirstDollarVoiceReadiness(process.env)'), 'buyer readiness must use the shared exact voice predicate');
assert.ok(buyerRoutes.includes('&& voiceReadiness.ready'), 'checkout activation readiness must require managed Twilio and streaming AI');
for (const source of [localEnvCheck, railwayEnvCheck]) {
  for (const marker of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'WORKSPACE_SECRET_ENCRYPTION_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_ENABLED', 'FAST_LIVE_CALLS', 'streaming TTS provider']) {
    assert.ok(source.includes(marker), `first-dollar environment contract must require ${marker}`);
  }
}
for (const marker of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'WORKSPACE_SECRET_ENCRYPTION_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_ENABLED', 'FAST_LIVE_CALLS', 'streaming_tts_key']) {
  assert.ok(railwaySetter.includes(marker), `first-dollar Railway setter must carry required voice setting ${marker}`);
}
assert.ok(server.includes('throw new Error("No streaming AI provider configured (enabled OpenRouter required)")'), 'runtime streaming pipeline must require the provider used by streamOpenRouter');
assert.ok(server.includes('if (buffer) return { buffer, contentType: "audio/basic" }'), 'Cartesia streaming audio must retain its Twilio-compatible audio/basic MIME type');
assert.ok(systemHealth.includes('describeFirstDollarVoiceHealth(env)'), 'operator health must use the exact first-dollar streaming voice predicate instead of credential presence');
assert.doesNotMatch(systemHealth, /const voiceOk = !!\(env\.ELEVENLABS_API_KEY/, 'operator health must not report disabled TTS credentials as active');

console.log('OK first-dollar readiness requires managed Twilio plus the actual enabled OpenRouter streaming-TTS path');
