#!/usr/bin/env node
// One-shot patch: replace the voicemail handler body with a version that
// creates a callback task and sends an owner email alert.
import fs from 'fs';
const file = new URL('../server.ts', import.meta.url).pathname;
let src = fs.readFileSync(file, 'utf8');

const OLD = `app.post("/api/twilio/voicemail", async (req: Request, res: Response) => {
  const { CallSid, RecordingUrl, RecordingDuration } = req.body as any;
  try {
    logEvent(CallSid, "RECOVERY_TEXT_BACK_SENT", { reason: "voicemail_recorded", RecordingDuration });
    // Update call record with a pointer (optional)
    try {
      await sql\`UPDATE calls SET recording_url = COALESCE(recording_url, \${RecordingUrl}) WHERE call_sid = \${CallSid}\`;
    } catch {
      // ignore if column not present
    }
    // SMS disabled — voicemail SMS removed
  } catch (e: any) {
    log("error", "Twilio voicemail handler failed", { CallSid, error: e?.message || String(e) });
  }`;

const NEW = `app.post("/api/twilio/voicemail", async (req: Request, res: Response) => {
  const { CallSid, RecordingUrl, RecordingDuration } = req.body as any;
  try {
    logEvent(CallSid, "VOICEMAIL_RECORDED", { RecordingDuration, RecordingUrl });
    // Save recording URL to call record
    try {
      await sql\`UPDATE calls SET recording_url = COALESCE(recording_url, \${RecordingUrl}) WHERE call_sid = \${CallSid}\`;
    } catch { /* ignore if column not present */ }
    // Look up caller info for the notification
    const callRows = await sql\`SELECT from_number, to_number, direction, contact_id FROM calls WHERE call_sid = \${CallSid} LIMIT 1\`.catch(() => []);
    const callRow = (callRows as any)[0];
    const callerNumber = callRow?.direction === 'outbound' ? callRow?.to_number : callRow?.from_number || 'Unknown';
    // Look up contact name if available
    let callerName = callerNumber;
    if (callRow?.contact_id) {
      const contactRows = await sql\`SELECT name FROM contacts WHERE id = \${callRow.contact_id} LIMIT 1\`.catch(() => []);
      const cName = (contactRows as any)[0]?.name;
      if (cName) callerName = cName + ' (' + callerNumber + ')';
    }
    // Create a callback task so it shows up in the dashboard
    try {
      await sql\`
        INSERT INTO tasks (call_sid, contact_id, task_type, description, status, priority)
        VALUES (\${CallSid}, \${callRow?.contact_id || null}, 'callback', \${'Voicemail from ' + callerName + '. Duration: ' + (RecordingDuration || '?') + 's.'}, 'open', 'high')
      \`;
      logEvent(CallSid, "VOICEMAIL_TASK_CREATED", { callerName });
    } catch (taskErr: any) { log('warn', 'Failed to create voicemail task', { error: taskErr.message }); }
    // Send owner email alert
    const ownerEmail = env.OWNER_EMAIL || process.env.OWNER_EMAIL || '';
    const resendKey = env.RESEND_API_KEY || process.env.RESEND_API_KEY || '';
    const fromEmail = env.FROM_EMAIL || process.env.FROM_EMAIL || '';
    if (ownerEmail && resendKey && fromEmail) {
      try {
        const durationStr = RecordingDuration ? RecordingDuration + ' seconds' : 'unknown duration';
        const recordingLink = RecordingUrl ? '<p><a href="' + RecordingUrl + '">Listen to recording</a></p>' : '';
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: fromEmail,
            to: [ownerEmail],
            subject: 'Voicemail from ' + callerName,
            html: '<p><strong>Voicemail received</strong> from <strong>' + callerName + '</strong></p><p>Duration: ' + durationStr + '</p>' + recordingLink + '<p>A callback task has been created in your SMIRK dashboard.</p>',
          }),
        });
        logEvent(CallSid, "VOICEMAIL_EMAIL_SENT", { to: ownerEmail });
      } catch (emailErr: any) { log('warn', 'Voicemail email failed', { error: emailErr.message }); }
    } else {
      log('warn', 'Voicemail email skipped - OWNER_EMAIL, RESEND_API_KEY, or FROM_EMAIL not configured', { CallSid });
    }
  } catch (e: any) {
    log("error", "Twilio voicemail handler failed", { CallSid, error: e?.message || String(e) });
  }`;

if (!src.includes(OLD)) {
  console.error('PATCH FAILED: target string not found. Check for whitespace differences.');
  process.exit(1);
}
src = src.replace(OLD, NEW);
fs.writeFileSync(file, src, 'utf8');
console.log('Voicemail handler patched successfully.');
