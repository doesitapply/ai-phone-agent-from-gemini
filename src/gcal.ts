/**
 * Google Calendar Sync Module
 *
 * Inserts or proposes an appointment in Google Calendar using a Service Account.
 *
 * Setup:
 *   1. Create a Google Cloud project and enable the Calendar API.
 *   2. Create a Service Account, download the JSON key.
 *      Set GOOGLE_SERVICE_ACCOUNT_JSON to the raw JSON string OR its base64 encoding.
 *   3. Share the target calendar with the service account email (Editor role).
 *   4. Set GOOGLE_CALENDAR_ID to the calendar ID (or "primary").
 *
 * Fallback behaviour:
 *   - If appointmentTime is missing, the event is created as a "proposed slot"
 *     with a 1-hour placeholder starting at the next round hour.
 *   - All errors are surfaced in CalendarResult.error — never thrown to callers.
 */
import { google } from "googleapis";

export interface CalendarEvent {
  summary: string;          // e.g. "HVAC Inspection — Bob's Roofing"
  description?: string;     // full notes / transcript snippet
  startIso?: string;        // ISO 8601 datetime — optional; falls back to next round hour
  endIso?: string;          // ISO 8601 datetime — optional; defaults to startIso + 1h
  location?: string;        // service address
  attendeeEmail?: string;   // caller's email if captured
  timeZone?: string;        // e.g. "America/Los_Angeles"
  isProposed?: boolean;     // marks the event as a proposed/tentative slot
}

export interface CalendarResult {
  success: boolean;
  eventId?: string;
  htmlLink?: string;
  isProposed?: boolean;
  error?: string;
}

/** Parse the service account JSON — supports raw JSON string or base64-encoded JSON. */
function parseServiceAccountJson(raw: string): object {
  const trimmed = raw.trim();
  // Try raw JSON first
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  // Try base64-decoded JSON
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  return JSON.parse(decoded);
}

/** Return the next round hour (e.g. if now is 14:23, return 15:00) as ISO string. */
function nextRoundHour(tz: string): string {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 1);
  return now.toISOString();
}

/**
 * Insert an event into Google Calendar.
 * If startIso is missing, creates a proposed/tentative slot at the next round hour.
 * Returns the event ID and HTML link on success.
 */
export async function insertCalendarEvent(event: CalendarEvent): Promise<CalendarResult> {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";

  if (!serviceAccountJson) {
    return { success: false, error: "GOOGLE_SERVICE_ACCOUNT_JSON is not configured." };
  }
  if (!calendarId) {
    return { success: false, error: "GOOGLE_CALENDAR_ID is not configured." };
  }

  try {
    const credentials = parseServiceAccountJson(serviceAccountJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });

    const calendar = google.calendar({ version: "v3", auth });
    const tz = event.timeZone || "America/Los_Angeles";

    // Determine start/end — fall back to proposed slot if no time provided
    const isProposed = !event.startIso || event.isProposed;
    const startIso = event.startIso ?? nextRoundHour(tz);
    const endIso   = event.endIso   ?? new Date(new Date(startIso).getTime() + 60 * 60_000).toISOString();

    const summary = isProposed
      ? `[PROPOSED] ${event.summary}`
      : event.summary;

    const description = [
      event.description ?? "",
      isProposed ? "\n⚠️ This is a proposed slot — confirm with the customer before finalising." : "",
    ].filter(Boolean).join("\n");

    const body: any = {
      summary,
      description,
      location: event.location,
      start: { dateTime: startIso, timeZone: tz },
      end:   { dateTime: endIso,   timeZone: tz },
      status: isProposed ? "tentative" : "confirmed",
    };

    if (event.attendeeEmail) {
      body.attendees = [{ email: event.attendeeEmail }];
    }

    const response = await calendar.events.insert({
      calendarId,
      requestBody: body,
      sendUpdates: event.attendeeEmail ? "all" : "none",
    });

    if (!response.data.id) {
      return { success: false, error: "Calendar API returned no event ID." };
    }

    return {
      success: true,
      eventId:    response.data.id,
      htmlLink:   response.data.htmlLink || undefined,
      isProposed: isProposed ?? false,
    };
  } catch (err: any) {
    // Surface Google API errors clearly
    const msg = err?.errors?.[0]?.message ?? err?.message ?? "Unknown Google Calendar error";
    return { success: false, error: msg };
  }
}

/**
 * Check if Google Calendar is configured.
 */
export function isCalendarConfigured(): boolean {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_CALENDAR_ID);
}

/** Build an authenticated Google Calendar client from env. */
async function getCalendarClient() {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not configured");
  const credentials = parseServiceAccountJson(serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

export interface CalendarEventItem {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  status: string;
  htmlLink?: string;
  attendees?: { email: string; displayName?: string }[];
}

/**
 * List calendar events between two ISO datetimes.
 * Returns events sorted by start time.
 */
export async function listCalendarEvents(
  startIso: string,
  endIso: string,
  maxResults = 50
): Promise<{ success: boolean; events?: CalendarEventItem[]; error?: string }> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
  try {
    const calendar = await getCalendarClient();
    const response = await calendar.events.list({
      calendarId,
      timeMin: startIso,
      timeMax: endIso,
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
    });
    const items = (response.data.items || []).map((e: any) => ({
      id: e.id || "",
      summary: e.summary || "(No title)",
      start: e.start?.dateTime || e.start?.date || "",
      end: e.end?.dateTime || e.end?.date || "",
      location: e.location,
      description: e.description,
      status: e.status || "confirmed",
      htmlLink: e.htmlLink,
      attendees: (e.attendees || []).map((a: any) => ({ email: a.email, displayName: a.displayName })),
    }));
    return { success: true, events: items };
  } catch (err: any) {
    const msg = err?.errors?.[0]?.message ?? err?.message ?? "Unknown error";
    return { success: false, error: msg };
  }
}

/**
 * Check free/busy for a time window.
 * Returns an array of busy intervals (from Google Calendar).
 */
export async function checkCalendarFreebusy(
  startIso: string,
  endIso: string
): Promise<{ success: boolean; busy?: { start: string; end: string }[]; error?: string }> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
  try {
    const calendar = await getCalendarClient();
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: startIso,
        timeMax: endIso,
        items: [{ id: calendarId }],
      },
    });
    const busy = (response.data.calendars?.[calendarId]?.busy || []).map((b: any) => ({
      start: b.start || "",
      end: b.end || "",
    }));
    return { success: true, busy };
  } catch (err: any) {
    const msg = err?.errors?.[0]?.message ?? err?.message ?? "Unknown error";
    return { success: false, error: msg };
  }
}
