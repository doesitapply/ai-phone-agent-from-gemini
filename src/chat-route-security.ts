export type ChatRouteAuthMode = "operator" | "workspace" | "demo_operator";

type ChatWorkspaceInput = {
  authMode: ChatRouteAuthMode;
  authenticatedWorkspaceId: number;
  requestedWorkspaceId?: unknown;
};

type ChatWorkspaceResolution =
  | { ok: true; workspaceId: number }
  | { ok: false; code: "INVALID_CHAT_WORKSPACE_ID" };

const isValidWorkspaceId = (value: unknown): value is number => (
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
);

export function resolveChatWorkspace(input: ChatWorkspaceInput): ChatWorkspaceResolution {
  const { authMode, authenticatedWorkspaceId, requestedWorkspaceId } = input;
  if (!isValidWorkspaceId(authenticatedWorkspaceId)) {
    return { ok: false, code: "INVALID_CHAT_WORKSPACE_ID" };
  }

  // Workspace and demo-operator sessions stay bound to the workspace selected
  // by authenticated request context. Only a full operator may target another
  // workspace explicitly for cross-workspace support work.
  if (authMode !== "operator" || requestedWorkspaceId === undefined) {
    return { ok: true, workspaceId: authenticatedWorkspaceId };
  }
  if (!isValidWorkspaceId(requestedWorkspaceId)) {
    return { ok: false, code: "INVALID_CHAT_WORKSPACE_ID" };
  }
  return { ok: true, workspaceId: requestedWorkspaceId };
}
