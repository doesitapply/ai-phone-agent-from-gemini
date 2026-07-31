import { timingSafeEqual } from "node:crypto";

export const PROSPECT_REVENUE_LOOP_OBSERVER_PATH =
  "/api/prospecting/revenue-loop" as const;

export type ProspectRevenueLoopObserverConfig = {
  configured: boolean;
  available: boolean;
  workspaceId: number | null;
  missing: string[];
};

function positiveWorkspaceId(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function secretEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function readProspectRevenueLoopObserverConfig(
  env: Record<string, string | undefined>
): ProspectRevenueLoopObserverConfig {
  const apiKey = String(
    env.PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY || ""
  ).trim();
  const workspaceId = positiveWorkspaceId(
    env.PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID
  );
  const missing: string[] = [];
  if (apiKey.length < 32) {
    missing.push("PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY");
  }
  if (
    apiKey.length >= 32 &&
    [env.DASHBOARD_API_KEY, env.DEMO_OPERATOR_API_KEY]
      .map(value => String(value || "").trim())
      .filter(Boolean)
      .includes(apiKey)
  ) {
    missing.push(
      "PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY_SEPARATION"
    );
  }
  if (workspaceId === null) {
    missing.push("PROSPECT_REVENUE_LOOP_OBSERVER_WORKSPACE_ID");
  }
  return {
    configured: apiKey.length > 0 || workspaceId !== null,
    available: missing.length === 0,
    workspaceId,
    missing,
  };
}

export function authenticateProspectRevenueLoopObserver(input: {
  method: string;
  path: string;
  providedApiKey: string | undefined;
  env: Record<string, string | undefined>;
}): number | null {
  if (
    input.method.toUpperCase() !== "GET" ||
    input.path !== PROSPECT_REVENUE_LOOP_OBSERVER_PATH
  ) {
    return null;
  }
  const config = readProspectRevenueLoopObserverConfig(input.env);
  if (!config.available || config.workspaceId === null) return null;
  const expected = String(
    input.env.PROSPECT_REVENUE_LOOP_OBSERVER_API_KEY || ""
  ).trim();
  const provided = String(input.providedApiKey || "").trim();
  if (!provided || !secretEquals(provided, expected)) return null;
  return config.workspaceId;
}
