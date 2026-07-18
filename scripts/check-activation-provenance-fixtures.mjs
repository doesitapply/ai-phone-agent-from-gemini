#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  activationIdentityForAuthMode,
  BUYER_EMAIL_INVITE_AUTH_PROVENANCE,
} from "../src/activation-provenance.js";

assert.deepEqual(activationIdentityForAuthMode("operator"), {
  actor: "operator",
  authMode: "operator",
  authProvenance: "operator_api_key",
});
assert.deepEqual(activationIdentityForAuthMode("demo_operator"), {
  actor: "operator",
  authMode: "demo_operator",
  authProvenance: "demo_operator_api_key",
});
assert.deepEqual(activationIdentityForAuthMode("workspace"), {
  actor: "customer",
  authMode: "workspace",
  authProvenance: "workspace_bearer_token",
});
assert.equal(activationIdentityForAuthMode(undefined).actor, "system");
assert.equal(BUYER_EMAIL_INVITE_AUTH_PROVENANCE, "buyer_email_invite_token");

console.log("OK activation provenance keeps operator rescue distinct from buyer-auth activation");
