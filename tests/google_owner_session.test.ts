import assert from "node:assert/strict";
import test from "node:test";
import {
  OWNER_SESSION_COOKIE,
  OWNER_SESSION_TTL_SECONDS,
  clearOwnerSessionCookie,
  issueOwnerSessionToken,
  ownerSessionCookie,
  readOwnerSessionCookie,
  verifyOwnerSessionToken,
} from "../src/owner-session.js";

const secret = "test-only-owner-session-secret";
const now = Date.UTC(2026, 8, 5, 12, 0, 0);

test("approved Google identity can receive a signed owner session", () => {
  const { token, session } = issueOwnerSessionToken({
    email: "MadeInReno775@Gmail.com",
    name: "Cameron",
    subject: "google-subject-1",
  }, secret, now);
  const verified = verifyOwnerSessionToken(token, secret, now + 1_000);
  assert.equal(session.email, "madeinreno775@gmail.com");
  assert.equal(verified?.email, "madeinreno775@gmail.com");
  assert.equal(verified?.role, "operator");
});

test("tampered or expired owner sessions are rejected", () => {
  const { token } = issueOwnerSessionToken({ email: "madeinreno775@gmail.com" }, secret, now);
  assert.equal(verifyOwnerSessionToken(`${token}x`, secret, now + 1_000), null);
  assert.equal(verifyOwnerSessionToken(token, secret, now + (OWNER_SESSION_TTL_SECONDS + 1) * 1_000), null);
  assert.equal(verifyOwnerSessionToken(token, "different-secret", now + 1_000), null);
});

test("owner cookie is HTTP-only, strict, secure in production, and clearable", () => {
  const cookie = ownerSessionCookie("signed.token", true);
  assert.match(cookie, new RegExp(`^${OWNER_SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal(readOwnerSessionCookie(cookie), "signed.token");
  assert.match(clearOwnerSessionCookie(true), /Max-Age=0/);
});
