/**
 * workspace-ai-keys.ts
 *
 * Per-workspace AI key resolution with TTL cache.
 *
 * Architecture:
 *   - Each workspace can store its own Gemini, OpenRouter, and ElevenLabs keys in the DB.
 *   - At call time, we resolve the workspace's keys and cache them for TTL_MS to avoid
 *     a DB round-trip on every conversation turn.
 *   - Fallback to global env vars ONLY if the workspace has no key configured (null/empty).
 *   - If a workspace has a key configured and it fails (401/403), we do NOT silently fall
 *     back to the global key — we throw a workspace-scoped error so the failure is visible.
 *
 * Cache: simple Map with per-entry TTL (no external dependency).
 * Default TTL: 5 minutes. Invalidate on workspace settings update.
 */
import { getWorkspaceById } from "./saas.js";

export interface WorkspaceAiKeys {
  workspaceId: number;
  geminiApiKey: string | null;
  openrouterApiKey: string | null;
  elevenLabsApiKey: string | null;
  /** True if the key came from the workspace DB record (not the global env fallback) */
  geminiIsWorkspaceKey: boolean;
  openrouterIsWorkspaceKey: boolean;
  elevenLabsIsWorkspaceKey: boolean;
}

interface CacheEntry {
  keys: WorkspaceAiKeys;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 500;

const cache = new Map<number, CacheEntry>();

/** Evict expired entries and enforce max size (LRU-lite: evict oldest). */
function evict() {
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(id);
  }
  if (cache.size > MAX_ENTRIES) {
    // Delete oldest entries until under limit
    const toDelete = cache.size - MAX_ENTRIES;
    let deleted = 0;
    for (const id of cache.keys()) {
      cache.delete(id);
      if (++deleted >= toDelete) break;
    }
  }
}

/**
 * Resolve AI keys for a workspace.
 * Fetches from DB if not cached; falls back to global env vars if workspace has no key.
 *
 * @param workspaceId  The workspace ID from the call record.
 * @param globalKeys   Global env var fallbacks.
 */
export async function resolveWorkspaceAiKeys(
  workspaceId: number,
  globalKeys: { geminiApiKey?: string | null; openrouterApiKey?: string | null; elevenLabsApiKey?: string | null }
): Promise<WorkspaceAiKeys> {
  const now = Date.now();
  const cached = cache.get(workspaceId);
  if (cached && cached.expiresAt > now) return cached.keys;

  evict();

  let wsRow: { gemini_api_key?: string | null; openrouter_api_key?: string | null; elevenlabs_api_key?: string | null } | null = null;
  try {
    wsRow = await getWorkspaceById(workspaceId);
  } catch {
    // DB unavailable — fall back to global keys, do not cache
    return {
      workspaceId,
      geminiApiKey: globalKeys.geminiApiKey ?? null,
      openrouterApiKey: globalKeys.openrouterApiKey ?? null,
      elevenLabsApiKey: globalKeys.elevenLabsApiKey ?? null,
      geminiIsWorkspaceKey: false,
      openrouterIsWorkspaceKey: false,
      elevenLabsIsWorkspaceKey: false,
    };
  }

  const geminiWs = wsRow?.gemini_api_key?.trim() || null;
  const openrouterWs = wsRow?.openrouter_api_key?.trim() || null;
  const elevenLabsWs = wsRow?.elevenlabs_api_key?.trim() || null;

  const keys: WorkspaceAiKeys = {
    workspaceId,
    geminiApiKey: geminiWs ?? (globalKeys.geminiApiKey ?? null),
    openrouterApiKey: openrouterWs ?? (globalKeys.openrouterApiKey ?? null),
    elevenLabsApiKey: elevenLabsWs ?? (globalKeys.elevenLabsApiKey ?? null),
    geminiIsWorkspaceKey: !!geminiWs,
    openrouterIsWorkspaceKey: !!openrouterWs,
    elevenLabsIsWorkspaceKey: !!elevenLabsWs,
  };

  cache.set(workspaceId, { keys, expiresAt: now + TTL_MS });
  return keys;
}

/**
 * Invalidate cached keys for a workspace (call after workspace settings update).
 */
export function invalidateWorkspaceAiKeyCache(workspaceId: number) {
  cache.delete(workspaceId);
}

/**
 * Build an OpenRouter config override using a workspace-specific key.
 * Returns null if no key is available.
 */
export function buildWorkspaceOpenRouterConfig(
  workspaceKeys: WorkspaceAiKeys,
  baseConfig: { model: string; enabled: boolean; timeoutMs: number } | null
): { apiKey: string; model: string; enabled: boolean; timeoutMs: number } | null {
  const key = workspaceKeys.openrouterApiKey;
  if (!key) return null;
  return {
    apiKey: key,
    model: baseConfig?.model || "google/gemini-flash-1.5",
    enabled: true,
    timeoutMs: baseConfig?.timeoutMs || 8000,
  };
}

/**
 * Build an ElevenLabs config override using a workspace-specific key.
 * Returns null if no key is available.
 */
export function buildWorkspaceElevenLabsConfig(
  workspaceKeys: WorkspaceAiKeys,
  baseConfig: { voiceId: string; modelId: string } | null
): { apiKey: string; voiceId: string; modelId: string } | null {
  const key = workspaceKeys.elevenLabsApiKey;
  if (!key) return null;
  return {
    apiKey: key,
    voiceId: baseConfig?.voiceId || "TX3LPaxmHKxFdv7VOQHJ",
    modelId: baseConfig?.modelId || "eleven_flash_v2_5",
  };
}

/**
 * Classify an AI API error as workspace-key-specific vs infrastructure.
 * Used to decide whether to surface a workspace-scoped error or a global one.
 */
export function classifyAiKeyError(
  error: unknown,
  isWorkspaceKey: boolean,
  workspaceId: number,
  provider: "gemini" | "openrouter" | "elevenlabs"
): { isKeyError: boolean; message: string } {
  const msg = error instanceof Error ? error.message : String(error);
  const isAuthError = /401|403|unauthorized|invalid.*key|api.*key|authentication/i.test(msg);

  if (isAuthError && isWorkspaceKey) {
    // Invalidate cache so next call re-fetches (in case key was rotated)
    invalidateWorkspaceAiKeyCache(workspaceId);
    return {
      isKeyError: true,
      message: `[workspace:${workspaceId}] ${provider} key invalid or expired — check workspace settings. Error: ${msg}`,
    };
  }

  return {
    isKeyError: false,
    message: msg,
  };
}
