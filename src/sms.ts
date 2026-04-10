import type { Sql } from "postgres";

export const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
export const HELP_KEYWORDS = new Set(["HELP"]);
export const START_KEYWORDS = new Set(["START"]);

export function normalizeSmsKeyword(body: string) {
  return body.trim().toUpperCase();
}

export type SmsStoreRow = {
  messageSid?: string | null;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  body: string;
  status?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  contactId?: number | null;
  businessId?: number | null;
  workspaceId?: number | null;
};

export async function storeSms(sql: Sql, row: SmsStoreRow) {
  await sql`
    INSERT INTO sms_messages (
      message_sid,
      direction,
      from_number,
      to_number,
      body,
      status,
      error_code,
      error_message,
      contact_id,
      business_id,
      workspace_id
    ) VALUES (
      ${row.messageSid ?? null},
      ${row.direction},
      ${row.from},
      ${row.to},
      ${row.body},
      ${row.status ?? null},
      ${row.errorCode ?? null},
      ${row.errorMessage ?? null},
      ${row.contactId ?? null},
      ${row.businessId ?? null},
      ${row.workspaceId ?? 1}
    )
    ON CONFLICT (message_sid) DO UPDATE SET
      status = COALESCE(EXCLUDED.status, sms_messages.status),
      error_code = COALESCE(EXCLUDED.error_code, sms_messages.error_code),
      error_message = COALESCE(EXCLUDED.error_message, sms_messages.error_message),
      updated_at = NOW()
  `;
}
