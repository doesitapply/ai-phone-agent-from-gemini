/**
 * Google Calendar Sync Module
 *
 * Provides a single function to insert an appointment into Google Calendar
 * using a Service Account (recommended for server-side use) or OAuth2.
 *
 * Setup:
 *   1. Create a Google Cloud project and enable the Calendar API.
 *   2. Create a Service Account, download the JSON key, and set
 *      GOOGLE_SERVICE_ACCOUNT_JSON=<minified JSON string> in your env.
 *   3. Share the target calendar with the service account email (Editor role).
 *   4. Set GOOGLE_CALENDAR_ID to the calendar ID (or "primary").
 */
import { google } from "googleapis";

export interface CalendarEvent {
  summary: string;          // e.g. "HVAC Inspection — Bob's Roofing"
  description?: string;     // full notes / transcript snippet
  startIso: string;         // ISO 8601 datetime, e.g. "2026-03-17T14:00:00"
  endIso: string;           // ISO 8601 datetime
  location?: string;        // service address
  attendeeEmail?: string;   // caller's email if captured
  timeZone?: string;        // e.g. "America/Los_Angeles"
}

export interface CalendarResult {
  success: boolean;
  eventId?: string;
  htmlLink?: string;
  error?: string;
}

/**
 * Insert an event into Google Calendar.
 * Returns the event ID and HTML link on success.
 */
export async function insertCalendarEvent(event: CalendarEvent): Promise<CalendarResult> {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";

  if (!serviceAccountJson) {
    return { success: false, error: "GOOGLE_SERVICE_ACCOUNT_JSON is not configured." };
  }

  try {
    const credentials = JSON.parse(serviceAccountJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });

    const calendar = google.calendar({ version: "v3", auth });
    const tz = event.timeZone || "America/Los_Angeles";

    const body: any = {
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: { dateTime: event.startIso, timeZone: tz },
      end: { dateTime: event.endIso, timeZone: tz },
    };

    if (event.attendeeEmail) {
      body.attendees = [{ email: event.attendeeEmail }];
    }

    const response = await calendar.events.insert({
      calendarId,
      requestBody: body,
      sendUpdates: event.attendeeEmail ? "all" : "none",
    });

    return {
      success: true,
      eventId: response.data.id || undefined,
      htmlLink: response.data.htmlLink || undefined,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Unknown Google Calendar error",
    };
  }
}

/**
 * Check if Google Calendar is configured.
 */
export function isCalendarConfigured(): boolean {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_CALENDAR_ID);
}
