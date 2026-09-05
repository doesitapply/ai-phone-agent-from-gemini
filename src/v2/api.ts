export type WorkspaceSession = {
  workspaceId: number;
  workspaceName?: string;
  apiKey: string;
  role?: string;
  plan?: string;
};

export type OwnerSession = {
  authenticated: true;
  email: string;
  name?: string;
};

const WORKSPACE_SESSION_KEY = "smirk_workspace_session";
const ACTIVE_WORKSPACE_ID_KEY = "smirk_active_workspace_id";

export function readWorkspaceSession(): WorkspaceSession | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACE_SESSION_KEY) || "null");
    if (!parsed?.workspaceId || !parsed?.apiKey) return null;
    return parsed as WorkspaceSession;
  } catch {
    return null;
  }
}

export function writeWorkspaceSession(session: WorkspaceSession | null): void {
  if (!session) {
    localStorage.removeItem(WORKSPACE_SESSION_KEY);
    localStorage.removeItem(ACTIVE_WORKSPACE_ID_KEY);
    return;
  }
  localStorage.setItem(WORKSPACE_SESSION_KEY, JSON.stringify(session));
  localStorage.setItem(ACTIVE_WORKSPACE_ID_KEY, String(session.workspaceId));
}

export function readActiveWorkspaceId(): number | null {
  const id = Number(localStorage.getItem(ACTIVE_WORKSPACE_ID_KEY) || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function writeActiveWorkspaceId(value: number | null): void {
  if (!value) localStorage.removeItem(ACTIVE_WORKSPACE_ID_KEY);
  else localStorage.setItem(ACTIVE_WORKSPACE_ID_KEY, String(value));
}

export async function api<T>(path: string, options: RequestInit = {}, workspaceId?: number | null): Promise<T> {
  const workspace = readWorkspaceSession();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (workspace?.apiKey) headers.Authorization = `Bearer ${workspace.apiKey}`;
  const targetWorkspaceId = workspaceId || workspace?.workspaceId || readActiveWorkspaceId();
  if (targetWorkspaceId) headers["X-Workspace-Id"] = String(targetWorkspaceId);
  const response = await fetch(path, {
    ...options,
    cache: options.cache || "no-store",
    credentials: "same-origin",
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body?.error || body?.message || `Request failed (${response.status})`));
  }
  return body as T;
}

export async function readOwnerSession(): Promise<OwnerSession | null> {
  try {
    const body = await api<any>("/api/auth/session");
    if (!body?.authenticated || !body?.user?.email) return null;
    return { authenticated: true, email: String(body.user.email), name: body.user.name || undefined };
  } catch {
    return null;
  }
}

export async function signOut(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
  writeWorkspaceSession(null);
}
