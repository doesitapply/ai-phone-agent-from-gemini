import assert from "node:assert/strict";
import test from "node:test";
import { isVerifiedOwnerChatIdentity, resolveOwnerChatEmails } from "./owner-chat-identity.js";

test("uses a dedicated allowlist when configured and otherwise falls back to the owner email", () => {
  assert.deepEqual(
    resolveOwnerChatEmails({ ownerChatEmails: "cam@example.com, CAM@example.com", ownerEmail: "other@example.com" }),
    ["cam@example.com"],
  );
  assert.deepEqual(resolveOwnerChatEmails({ ownerEmail: "owner@example.com, cam@example.com" }), ["cam@example.com"]);
});

test("requires a verified email that exactly matches the configured owner allowlist", () => {
  const allowed = ["cam@example.com"];
  assert.equal(isVerifiedOwnerChatIdentity({ email: "CAM@example.com", emailVerified: true }, allowed), true);
  assert.equal(isVerifiedOwnerChatIdentity({ email: "cam@example.com", emailVerified: false }, allowed), false);
  assert.equal(isVerifiedOwnerChatIdentity({ email: "other@example.com", emailVerified: true }, allowed), false);
});
