import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { registerAuthRoutes } from "../src/routes/auth-routes";

test("Google operator exchange mints only an approved server session and logout clears it", async () => {
  const app = express();
  const now = Date.now();
  registerAuthRoutes(app, {
    env: { DASHBOARD_API_KEY: "configured-for-test" },
    googleClientIds: () => ["test-client.apps.googleusercontent.com"],
    googleAdminEmails: () => ["admin@example.test"],
    googleDemoOperatorEmails: () => [],
    verifyGoogleIdToken: async (credential) => ({
      email: credential === "approved" ? "admin@example.test" : "ordinary@example.test",
      email_verified: true,
      name: "Test Owner",
      sub: "google-subject-test",
      aud: "test-client.apps.googleusercontent.com",
    }),
    getWorkspacesForEmail: async () => [],
    createVerifiedOwnerSession: (identity, res) => {
      res.append("Set-Cookie", "smirk_owner_session=valid; Path=/; HttpOnly; SameSite=Strict");
      return { email: String(identity.email), role: "operator", expiresAt: now + 60_000 };
    },
    readVerifiedOwnerSession: (req) => String(req.headers.cookie || "").includes("smirk_owner_session=valid")
      ? { email: "admin@example.test", name: "Test Owner", role: "operator", expiresAt: now + 60_000 }
      : null,
    clearVerifiedOwnerSession: (res) => {
      res.append("Set-Cookie", "smirk_owner_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    },
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const denied = await fetch(`${baseUrl}/api/auth/google/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "operator", credential: "ordinary" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("set-cookie"), null);

    const allowed = await fetch(`${baseUrl}/api/auth/google/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "operator", credential: "approved" }),
    });
    assert.equal(allowed.status, 200);
    const allowedBody = await allowed.json() as any;
    assert.equal(allowedBody.session.serverSession, true);
    assert.equal("apiKey" in allowedBody.session, false);
    const cookie = allowed.headers.get("set-cookie") || "";
    assert.match(cookie, /smirk_owner_session=valid/);
    assert.match(cookie, /HttpOnly/i);

    const csrfDenied = await fetch(`${baseUrl}/api/auth/google/redirect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "g_csrf_token=cookie-token",
      },
      body: new URLSearchParams({ credential: "approved", g_csrf_token: "different-token" }),
      redirect: "manual",
    });
    assert.equal(csrfDenied.status, 303);
    assert.equal(csrfDenied.headers.get("location"), "/dashboard?admin=1&auth_error=csrf");
    assert.equal(csrfDenied.headers.get("set-cookie"), null);

    const redirectDenied = await fetch(`${baseUrl}/api/auth/google/redirect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "g_csrf_token=matching-token",
      },
      body: new URLSearchParams({ credential: "ordinary", g_csrf_token: "matching-token" }),
      redirect: "manual",
    });
    assert.equal(redirectDenied.status, 303);
    assert.equal(redirectDenied.headers.get("location"), "/dashboard?admin=1&auth_error=not_allowed");
    assert.equal(redirectDenied.headers.get("set-cookie"), null);

    const redirectAllowed = await fetch(`${baseUrl}/api/auth/google/redirect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "g_csrf_token=matching-token",
      },
      body: new URLSearchParams({ credential: "approved", g_csrf_token: "matching-token" }),
      redirect: "manual",
    });
    assert.equal(redirectAllowed.status, 303);
    assert.equal(redirectAllowed.headers.get("location"), "/dashboard");
    assert.match(redirectAllowed.headers.get("set-cookie") || "", /smirk_owner_session=valid/);
    assert.match(redirectAllowed.headers.get("set-cookie") || "", /HttpOnly/i);

    const missing = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(missing.status, 401);

    const restored = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: "smirk_owner_session=valid" } });
    assert.equal(restored.status, 200);
    const restoredBody = await restored.json() as any;
    assert.equal(restoredBody.authenticated, true);
    assert.equal(restoredBody.session.serverSession, true);
    assert.equal(restoredBody.session.role, "operator");

    const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Cookie: "smirk_owner_session=valid" } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/i);
  } finally {
    server.close();
  }
});
