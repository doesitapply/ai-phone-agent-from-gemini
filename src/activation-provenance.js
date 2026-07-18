/** @typedef {"customer" | "operator" | "system"} ActivationActor */
/** @typedef {"operator" | "demo_operator" | "workspace" | "unknown"} ActivationAuthMode */
/** @typedef {"operator_api_key" | "demo_operator_api_key" | "workspace_bearer_token" | "unattributed"} ActivationAuthProvenance */

/**
 * Translate the authentication decision already made by dashboardAuth into an
 * immutable activation-audit identity. Never infer a customer merely because a
 * workspace ID is present: full and demo operator sessions remain operators.
 * @param {unknown} authMode
 * @returns {{ actor: ActivationActor; authMode: ActivationAuthMode; authProvenance: ActivationAuthProvenance }}
 */
export function activationIdentityForAuthMode(authMode) {
  const normalized = String(authMode || "").trim().toLowerCase();
  if (normalized === "operator") {
    return {
      actor: "operator",
      authMode: "operator",
      authProvenance: "operator_api_key",
    };
  }
  if (normalized === "demo_operator") {
    return {
      actor: "operator",
      authMode: "demo_operator",
      authProvenance: "demo_operator_api_key",
    };
  }
  if (normalized === "workspace") {
    return {
      actor: "customer",
      authMode: "workspace",
      authProvenance: "workspace_bearer_token",
    };
  }
  return {
    actor: "system",
    authMode: "unknown",
    authProvenance: "unattributed",
  };
}

export const BUYER_EMAIL_INVITE_AUTH_PROVENANCE = "buyer_email_invite_token";
