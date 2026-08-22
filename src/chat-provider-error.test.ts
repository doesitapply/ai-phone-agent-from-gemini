import { describe, expect, it } from "vitest";
import { shouldTryOpenRouterFallback, toSafeChatProviderFailure } from "./chat-provider-error.js";

describe("chat provider failure boundary", () => {
  it("classifies denied Gemini project access as eligible for OpenRouter fallback", () => {
    const error = new Error('{"error":{"code":403,"message":"Your project has been denied access.","status":"PERMISSION_DENIED"}}');
    expect(shouldTryOpenRouterFallback(error)).toBe(true);
    expect(toSafeChatProviderFailure(error)).toEqual({
      status: 503,
      body: {
        error: "SMIRK Agent is temporarily unavailable because its AI provider access needs repair. No action was taken.",
        code: "CHAT_PROVIDER_ACCESS_DENIED",
      },
    });
  });

  it("does not expose unrelated upstream provider failures", () => {
    expect(shouldTryOpenRouterFallback(new Error("timeout"))).toBe(false);
    expect(toSafeChatProviderFailure(new Error("timeout"))).toEqual({
      status: 503,
      body: {
        error: "SMIRK Agent is temporarily unavailable. No action was taken.",
        code: "CHAT_PROVIDER_UNAVAILABLE",
      },
    });
  });
});
