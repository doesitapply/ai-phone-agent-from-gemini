#!/usr/bin/env node
console.log('Google auth live setup for SMIRK');
console.log('');
console.log('1. In Google Cloud Console, create or select the OAuth 2.0 Web application client used by the SMIRK dashboard.');
console.log('2. Add the production JavaScript origin:');
console.log('   https://ai-phone-agent-production-6811.up.railway.app');
console.log('3. Add the production redirect URI:');
console.log('   https://ai-phone-agent-production-6811.up.railway.app');
console.log('4. Copy the client ID (it should end with .apps.googleusercontent.com).');
console.log('5. Set it in Railway:');
console.log('   GOOGLE_OAUTH_CLIENT_ID="your-google-web-client-id.apps.googleusercontent.com" npm run set:google-auth-env');
console.log('6. Verify:');
console.log('   npm run check:google-auth-live');
console.log('   npm run check:post-deploy-live');
console.log('');
console.log('Optional admin Google login:');
console.log('   GOOGLE_OAUTH_CLIENT_ID="your-google-web-client-id.apps.googleusercontent.com" GOOGLE_ADMIN_EMAILS="you@example.com" npm run set:google-auth-env');
