#!/usr/bin/env node
const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const configUrl = `${appUrl}/api/auth/google/config`;
const appOrigin = new URL(appUrl).origin;
const fetchTimeoutMs = Number(process.env.SMIRK_GOOGLE_AUTH_SETUP_FETCH_TIMEOUT_MS || 10_000);
const fetchRetries = Number(process.env.SMIRK_GOOGLE_AUTH_SETUP_FETCH_RETRIES || 2);

function matchingSmirkOrigin(origin) {
  const url = new URL(origin);
  if (url.hostname === 'smirkcalls.com') return `${url.protocol}//www.smirkcalls.com`;
  if (url.hostname === 'www.smirkcalls.com') return `${url.protocol}//smirkcalls.com`;
  return '';
}

const recommendedOrigins = [...new Set([appOrigin, matchingSmirkOrigin(appOrigin)].filter(Boolean))];

async function fetchConfigWithTimeout() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    return await fetch(configUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchConfigWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= fetchRetries + 1; attempt += 1) {
    try {
      return { response: await fetchConfigWithTimeout(), attempts: attempt };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    response: null,
    attempts: fetchRetries + 1,
    error: {
      code: 'google-auth-setup-fetch-failed',
      timeoutMs: fetchTimeoutMs,
      detail: String(lastError?.message || lastError || 'unknown fetch failure'),
    },
  };
}

let liveSummary = 'unavailable';
try {
  const { response: res, attempts, error } = await fetchConfigWithRetry();
  if (error) {
    liveSummary = `unavailable (${error.code}; attempts=${attempts}; timeoutMs=${error.timeoutMs}; detail=${error.detail})`;
  } else {
    const body = await res.json().catch(() => ({ error: 'google-auth-setup-invalid-json' }));
    liveSummary = `http=${res.status} attempts=${attempts} enabled=${body.enabled ? 'yes' : 'no'} clientIdPresent=${body.clientId ? 'yes' : 'no'} adminEnabled=${body.adminEnabled ? 'yes' : 'no'}`;
  }
} catch (err) {
  liveSummary = `unavailable (${err?.message || 'fetch failed'})`;
}

console.log('Google auth live setup for SMIRK');
console.log('');
console.log(`Live app URL: ${appUrl}`);
console.log(`Verification endpoint: ${configUrl}`);
console.log(`Current live status: ${liveSummary}`);
console.log('');
console.log('0. First check whether a real client ID already exists locally:');
console.log('   npm run find:google-auth-client-id');
console.log('1. In Google Cloud Console, create or select the OAuth 2.0 Web application client used by the SMIRK dashboard.');
console.log('2. Add these Authorized JavaScript origins to that Google client:');
for (const origin of recommendedOrigins) {
  console.log(`   ${origin}`);
}
console.log('   # origin only: no path, no trailing slash');
console.log('3. For the current Google Identity button flow, no redirect URI is required unless you separately choose a redirect-based OAuth flow in Google Cloud Console.');
console.log('4. Copy the client ID (it must end with .apps.googleusercontent.com).');
console.log('5. Set exactly one browser client ID in Railway:');
console.log('   npm run fix:google-auth-live:from-scan -- --dry-run');
console.log('   npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com');
console.log('   # one-shot ship check after setting it:');
console.log('   npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com && npm run -s check:ship-live');
console.log('   # alt forms:');
console.log('   npm run fix:google-auth-live:dry -- your-google-web-client-id.apps.googleusercontent.com');
console.log('   npm run set:google-auth-env -- your-google-web-client-id.apps.googleusercontent.com');
console.log('   GOOGLE_OAUTH_CLIENT_ID="your-google-web-client-id.apps.googleusercontent.com" npm run set:google-auth-env');
console.log('6. Verify the live dashboard path:');
console.log('   npm run check:google-auth-live');
console.log('   npm run check:launch-blockers');
console.log('   npm run check:post-deploy-live');
console.log(`   curl -s ${configUrl}`);
console.log('');
console.log('Optional admin Google login:');
console.log('   GOOGLE_ADMIN_EMAILS="you@example.com" npm run fix:google-auth-live -- your-google-web-client-id.apps.googleusercontent.com');
console.log('   # alt: GOOGLE_OAUTH_CLIENT_ID="your-google-web-client-id.apps.googleusercontent.com" GOOGLE_ADMIN_EMAILS="you@example.com" npm run set:google-auth-env');
console.log('');
console.log('If Google shows Error 400: origin_mismatch, the Google client is missing the exact browser origin shown in the error.');
