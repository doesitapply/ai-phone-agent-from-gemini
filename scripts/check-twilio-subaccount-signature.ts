import assert from "node:assert/strict";
import twilio from "twilio";
import { decryptWorkspaceSecret, encryptWorkspaceSecret } from "../src/workspace-secret-crypto.js";
import {
  buildTwilioSignatureCandidateUrls,
  resolveTwilioWebhookAuthToken,
  selectExactWorkspaceTwilioCredential,
  validateTwilioWebhookSignature,
} from "../src/twilio-webhook-security.js";

const parentAccountSid = `AC${"a".repeat(32)}`;
const workspaceAccountSid = `AC${"b".repeat(32)}`;
const unknownAccountSid = `AC${"c".repeat(32)}`;
const parentToken = "parent_auth_token_fixture";
const workspaceToken = "workspace_auth_token_fixture";
const encryptionSecret = "fixture-workspace-encryption-secret";
const encryptedWorkspaceToken = encryptWorkspaceSecret(workspaceToken, encryptionSecret);
assert.equal(decryptWorkspaceSecret(encryptedWorkspaceToken, encryptionSecret), workspaceToken, "workspace credential must round-trip through authenticated encryption");
assert.throws(() => decryptWorkspaceSecret(encryptedWorkspaceToken, "wrong-secret"), "wrong encryption key must fail authentication");

const body = {
  AccountSid: workspaceAccountSid,
  CallSid: `CA${"d".repeat(32)}`,
  From: "+17755550101",
  To: "+17755550102",
};
const canonicalUrl = "https://smirkcalls.com/api/twilio/incoming";
const candidates = buildTwilioSignatureCandidateUrls({
  originalUrl: "/api/twilio/incoming",
  forwardedProto: "https",
  forwardedHost: "smirkcalls.com",
  rawHost: "smirkcalls.com",
  appUrl: "https://smirkcalls.com",
});
assert.ok(candidates.includes(canonicalUrl), "canonical production webhook URL must be a signature candidate");

const workspaceCredential = {
  workspaceId: 42,
  accountSid: workspaceAccountSid,
  encryptedAuthToken: encryptedWorkspaceToken,
};
assert.deepEqual(selectExactWorkspaceTwilioCredential(workspaceAccountSid, [{
  workspace_id: 42,
  twilio_account_sid: workspaceAccountSid,
  twilio_auth_token: encryptedWorkspaceToken,
}]), workspaceCredential, "database credential selection must require one exact AccountSid match");
assert.equal(selectExactWorkspaceTwilioCredential(workspaceAccountSid, [{
  workspace_id: 42,
  twilio_account_sid: workspaceAccountSid,
  twilio_auth_token: encryptedWorkspaceToken,
}, {
  workspace_id: 43,
  twilio_account_sid: workspaceAccountSid,
  twilio_auth_token: encryptedWorkspaceToken,
}]), null, "duplicate AccountSid ownership must fail closed");
const resolvedWorkspace = resolveTwilioWebhookAuthToken({
  requestAccountSid: body.AccountSid,
  parentAccountSid,
  parentAuthToken: parentToken,
  workspaceCredential,
  decryptWorkspaceToken: (encrypted) => decryptWorkspaceSecret(encrypted, encryptionSecret),
});
assert.equal(resolvedWorkspace?.scope, "workspace", "subaccount webhook must select the exact workspace credential");
const workspaceSignature = twilio.getExpectedTwilioSignature(workspaceToken, canonicalUrl, body);
assert.equal(validateTwilioWebhookSignature({
  validateRequest: twilio.validateRequest,
  authToken: resolvedWorkspace!.authToken,
  signature: workspaceSignature,
  candidateUrls: candidates,
  body,
}), true, "a correctly signed subaccount webhook must validate");

const forgedParentSignature = twilio.getExpectedTwilioSignature(parentToken, canonicalUrl, body);
assert.equal(validateTwilioWebhookSignature({
  validateRequest: twilio.validateRequest,
  authToken: resolvedWorkspace!.authToken,
  signature: forgedParentSignature,
  candidateUrls: candidates,
  body,
}), false, "the parent token must not authenticate a subaccount-owned webhook");

const resolvedParent = resolveTwilioWebhookAuthToken({
  requestAccountSid: parentAccountSid,
  parentAccountSid,
  parentAuthToken: parentToken,
  workspaceCredential: null,
  decryptWorkspaceToken: () => "",
});
assert.equal(resolvedParent?.scope, "parent", "parent-owned webhook must retain the exact parent credential path");
assert.equal(resolveTwilioWebhookAuthToken({
  requestAccountSid: unknownAccountSid,
  parentAccountSid,
  parentAuthToken: parentToken,
  workspaceCredential: null,
  decryptWorkspaceToken: () => "",
}), null, "unknown AccountSid must fail closed instead of falling back to the parent token");
assert.equal(resolveTwilioWebhookAuthToken({
  requestAccountSid: "",
  parentAccountSid,
  parentAuthToken: parentToken,
  workspaceCredential,
  decryptWorkspaceToken: () => workspaceToken,
}), null, "missing AccountSid must fail closed in production");

console.log("OK Twilio webhook security selects and validates the exact parent or workspace subaccount credential");
