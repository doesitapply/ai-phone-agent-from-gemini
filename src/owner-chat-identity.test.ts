import { describe, expect, it } from "vitest";
import { isVerifiedOwnerChatIdentity, resolveOwnerChatEmails } from "./owner-chat-identity.js";

describe("owner chat identity policy", () => {
  it("uses a dedicated allowlist when configured and otherwise falls back to the owner email", () => {
    expect(resolveOwnerChatEmails({ ownerChatEmails: "cam@example.com, CAM@example.com", ownerEmail: "other@example.com" }))
      .toEqual(["cam@example.com"]);
    expect(resolveOwnerChatEmails({ ownerEmail: "owner@example.com, cam@example.com" }))
      .toEqual(["cam@example.com"]);
  });

  it("requires a verified email that exactly matches the configured owner allowlist", () => {
    const allowed = ["cam@example.com"];
    expect(isVerifiedOwnerChatIdentity({ email: "CAM@example.com", emailVerified: true }, allowed)).toBe(true);
    expect(isVerifiedOwnerChatIdentity({ email: "cam@example.com", emailVerified: false }, allowed)).toBe(false);
    expect(isVerifiedOwnerChatIdentity({ email: "other@example.com", emailVerified: true }, allowed)).toBe(false);
  });
});
