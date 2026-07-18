#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { validateGoogleTokenAudience } from "../src/google-auth-safety.js";

assert.deepEqual(validateGoogleTokenAudience("client-a.apps.googleusercontent.com", []), { ok: false, code: "GOOGLE_OAUTH_NOT_CONFIGURED" });
assert.deepEqual(validateGoogleTokenAudience("", ["client-a.apps.googleusercontent.com"]), { ok: false, code: "GOOGLE_CLIENT_MISMATCH" });
assert.deepEqual(validateGoogleTokenAudience("client-b.apps.googleusercontent.com", ["client-a.apps.googleusercontent.com"]), { ok: false, code: "GOOGLE_CLIENT_MISMATCH" });
assert.deepEqual(validateGoogleTokenAudience("client-a.apps.googleusercontent.com", ["client-a.apps.googleusercontent.com"]), { ok: true, audience: "client-a.apps.googleusercontent.com" });

console.log("PASS Google OAuth audience safety fixtures (4)");
