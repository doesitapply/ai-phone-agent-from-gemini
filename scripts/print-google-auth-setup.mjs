#!/usr/bin/env node
const appUrl = String(process.env.APP_URL || 'https://ai-phone-agent-production-6811.up.railway.app').replace(/\/$/, '');
const configUrl = `${appUrl}/api/auth/google/config`;

let liveSummary = 'unavailable';
try {
  const res = await fetch(configUrl);
  const body = await res.json().catch(() => ({}));
  liveSummary = `http=${res.status} enabled=${body.enabled ? 'yes' : 'no'} clientIdPresent=${body.clientId ? 'yes' : 'no'} adminEnabled=${body.adminEnabled ? 'yes' : 'no'}`;
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
console.log('2. Add the live JavaScript origin exactly as shown below:');
console.log(`   ${appUrl}`);
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
console.log('If the checker still fails, confirm the Google client JavaScript origin matches the live APP_URL above exactly.');
