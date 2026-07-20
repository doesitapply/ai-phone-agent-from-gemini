// ── Screened Transfer (press-1 whisper gate) ─────────────────────────────────
// Prevents callers from ever landing in a contractor's personal carrier
// voicemail. Instead of blind-bridging, the AI holds the caller, dials the
// contractor on a second leg, and plays a whisper: "Press 1 to accept."
// Carrier voicemail cannot press 1, so the bridge only completes when a real
// human accepts. On decline/no-answer/voicemail, the caller comes back to the
// AI with a graceful fallback and callback capture.
//
// Flow:
//   [Caller leg]  <Say handoff line> → <Dial action=/transfer-result>
//                   <Number url=/transfer-whisper>contractor</Number>
//   [Callee leg]  /transfer-whisper → <Gather numDigits=1 action=/transfer-screen>
//                   "Emergency call from SMIRK: {context}. Press 1 to accept."
//                 /transfer-screen  → Digits==1 ? (empty TwiML = bridge) : <Hangup>
//   [Caller leg]  /transfer-result → bridged&completed ? <Hangup>
//                                  : fallback speech + gather → /api/twilio/process

export type ScreenedTransferParams = {
  appUrl: string;
  callSid: string;
  targetPhone: string;
  targetName?: string | null;
};

export type WhisperContext = {
  reason?: string | null;
  urgency?: string | null;
  callerName?: string | null;
  callerPhone?: string | null;
};

const SCREEN_ACCEPT_DIGIT = "1";
// Whisper gather window. Long enough for a human to hear the prompt and react,
// short enough that carrier voicemail (which answers around 15-25s of ringing)
// never holds the caller hostage.
export const WHISPER_GATHER_TIMEOUT_SECONDS = 10;
// Outbound leg ring timeout. Below typical carrier voicemail pickup (~20-25s)
// is NOT required — voicemail answering is harmless because it cannot press 1.
export const SCREENED_DIAL_TIMEOUT_SECONDS = 25;

export const buildTransferWhisperUrl = (params: ScreenedTransferParams): string => {
  const query = new URLSearchParams({ callSid: params.callSid });
  return `${params.appUrl}/api/twilio/transfer-whisper?${query.toString()}`;
};

export const buildTransferScreenUrl = (appUrl: string, callSid: string): string => {
  const query = new URLSearchParams({ callSid });
  return `${appUrl}/api/twilio/transfer-screen?${query.toString()}`;
};

export const buildTransferResultUrl = (params: ScreenedTransferParams): string => {
  const query = new URLSearchParams({
    callSid: params.callSid,
    targetName: params.targetName || "",
  });
  return `${params.appUrl}/api/twilio/transfer-result?${query.toString()}`;
};

export const buildWhisperAnnouncement = (context: WhisperContext): string => {
  const parts: string[] = [];
  const urgency = String(context.urgency || "").toLowerCase();
  const lead = urgency === "urgent" || urgency === "high" || urgency === "emergency"
    ? "Emergency call from SMIRK"
    : "Incoming call from SMIRK";
  parts.push(lead);

  const reason = String(context.reason || "").replace(/\s+/g, " ").trim();
  if (reason) parts.push(reason.slice(0, 220));

  const caller = [context.callerName, context.callerPhone]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(", ");
  if (caller) parts.push(`Caller: ${caller}`);

  return `${parts.join(". ")}. Press 1 to accept this call, or hang up to let SMIRK take a message.`;
};

export const isScreenAccepted = (digits: string | null | undefined): boolean =>
  String(digits || "").trim() === SCREEN_ACCEPT_DIGIT;

// Dial action DialCallStatus semantics for a screened transfer:
// - "completed": the callee leg was answered AND the whisper TwiML ended with a
//   bridge (pressed 1) AND the conversation finished. Nothing left to do.
// - "no-answer" / "busy" / "failed" / "canceled": nobody accepted. This is also
//   what a carrier-voicemail pickup produces, because the whisper <Gather> times
//   out against a voicemail greeting and we hang up the callee leg ourselves.
// DialCallDuration guards the edge where a human answered, pressed 1, and the
// bridge completed in under a couple of seconds (still a real conversation).
export type TransferOutcome = "bridged" | "not_accepted";

export const classifyTransferOutcome = (
  dialCallStatus: string | null | undefined,
  dialCallDuration: string | number | null | undefined
): TransferOutcome => {
  const status = String(dialCallStatus || "").trim().toLowerCase();
  if (status !== "completed") return "not_accepted";
  const duration = Number(dialCallDuration ?? 0);
  // A press-1 bridge always yields a nonzero bridged duration. A whisper leg
  // that was answered but never accepted reports no-answer (we hang it up), so
  // any completed status with duration > 0 is a genuine human conversation.
  return duration > 0 ? "bridged" : "not_accepted";
};

export const buildTransferFallbackMessage = (targetName?: string | null): string => {
  const name = String(targetName || "").trim() || "the team";
  return (
    `Sorry about the wait — ${name} is tied up on another job right now. ` +
    `I've flagged this as high priority and sent your details straight to their cell. ` +
    `What's the best number to reach you at the moment they free up?`
  );
};
