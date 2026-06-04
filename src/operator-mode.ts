import { sql } from "./db.js";

const lastTenDigits = (value?: string | null): string => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const phonesMatch = (a?: string | null, b?: string | null): boolean => {
  const left = lastTenDigits(a);
  const right = lastTenDigits(b);
  return left.length === 10 && right.length === 10 && left === right;
};

export async function isOperatorCaller(workspaceId: number, callerPhone: string): Promise<boolean> {
  const configuredPhones = [
    process.env.OWNER_PHONE,
    process.env.HUMAN_TRANSFER_NUMBER,
    process.env.OPERATOR_ALERT_NUMBER,
  ].filter(Boolean) as string[];

  if (configuredPhones.some((phone) => phonesMatch(callerPhone, phone))) return true;

  try {
    const rows = await sql`
      SELECT owner_phone FROM workspaces WHERE id = ${workspaceId} LIMIT 1
    ` as { owner_phone: string | null }[];
    if (phonesMatch(callerPhone, rows[0]?.owner_phone)) return true;
  } catch {
    // Non-fatal. Env and Boss Mode checks still cover common operator paths.
  }

  try {
    const rows = await sql`
      SELECT boss_phone, enabled FROM boss_mode_settings WHERE workspace_id = ${workspaceId} LIMIT 1
    ` as { boss_phone: string | null; enabled: boolean }[];
    if (rows[0]?.enabled && phonesMatch(callerPhone, rows[0]?.boss_phone)) return true;
  } catch {
    // Boss Mode tables may not exist in older local databases.
  }

  return false;
}

export function buildOperatorModePromptBlock(isOperator: boolean): string {
  if (!isOperator) return "";
  return `

=== OPERATOR / BOSS MODE ===
You are speaking with the business owner or an authorized operator, not a sales prospect.
Do not pitch SMIRK, demos, missed-call recovery, pricing, or setup unless the operator explicitly asks.
Act as the same internal operations assistant used in the dashboard chat bubble.
You may list, create, update, complete, cancel, delete, and transfer workspace tasks using tools.
When the operator asks "what's new", summarize recent calls, open tasks, handoffs, and notable changes from available context.
When the operator asks who is available for handoff, list active/on-call team members and then route or transfer if requested.
For broad destructive actions such as completing or cancelling all open tasks, use the workspace bulk task tool only when the operator clearly asks for all of them. Briefly confirm the result after the tool succeeds.
=== END OPERATOR / BOSS MODE ===`;
}
