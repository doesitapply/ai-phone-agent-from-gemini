#!/usr/bin/env python3
"""Patch the voicemail handler in server.ts to send owner email + create callback task."""
import os

file_path = os.path.join(os.path.dirname(__file__), '..', 'server.ts')
with open(file_path, 'r', encoding='utf-8') as f:
    src = f.read()

start = src.find('app.post("/api/twilio/voicemail"')
end = src.find('\n});', start) + 4
if start == -1:
    print('FAIL: voicemail handler not found')
    exit(1)

old_block = src[start:end]
print(f'Replacing chars {start}-{end} ({len(old_block)} chars)')

new_block = r'''app.post("/api/twilio/voicemail", async (req: Request, res: Response) => {
  const { CallSid, RecordingUrl, RecordingDuration } = req.body as any;
  try {
    logEvent(CallSid, "VOICEMAIL_RECORDED", { RecordingDuration, RecordingUrl });
    // Save recording URL to call record
    try {
      await sql`UPDATE calls SET recording_url = COALESCE(recording_url, ${RecordingUrl}) WHERE call_sid = ${CallSid}`;
    } catch { /* ignore if column not present */ }
    // Look up caller info for the notification
    const callRows = await sql`SELECT from_number, to_number, direction, contact_id FROM calls WHERE call_sid = ${CallSid} LIMIT 1`.catch(() => []);
    const callRow = (callRows as any)[0];
    const callerNumber = callRow?.direction === 'outbound' ? callRow?.to_number : callRow?.from_number || 'Unknown';
    // Look up contact name if available
    let callerName = callerNumber;
    if (callRow?.contact_id) {
      const contactRows = await sql`SELECT name FROM contacts WHERE id = ${callRow.contact_id} LIMIT 1`.catch(() => []);
      const cName = (contactRows as any)[0]?.name;
      if (cName) callerName = cName + ' (' + callerNumber + ')';
    }
    // Create a callback task so it shows up in the dashboard
    try {
      const vmDesc = 'Voicemail from ' + callerName + '. Duration: ' + (RecordingDuration || '?') + 's.';
      await sql`
        INSERT INTO tasks (call_sid, contact_id, task_type, description, status, priority)
        VALUES (${CallSid}, ${callRow?.contact_id || null}, 'callback', ${vmDesc}, 'open', 'high')
      `;
      logEvent(CallSid, "VOICEMAIL_TASK_CREATED", { callerName });
    } catch (taskErr: any) { log('warn', 'Failed to create voicemail task', { error: taskErr.message }); }
    // Send owner email alert
    const vmOwnerEmail = (env as any).OWNER_EMAIL || process.env.OWNER_EMAIL || '';
    const vmResendKey = (env as any).RESEND_API_KEY || process.env.RESEND_API_KEY || '';
    const vmFromEmail = (env as any).FROM_EMAIL || process.env.FROM_EMAIL || '';
    if (vmOwnerEmail && vmResendKey && vmFromEmail) {
      try {
        const durationStr = RecordingDuration ? RecordingDuration + ' seconds' : 'unknown duration';
        const recordingLink = RecordingUrl ? '<p><a href="' + RecordingUrl + '">Listen to recording (requires Twilio login)</a></p>' : '';
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + vmResendKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: vmFromEmail,
            to: [vmOwnerEmail],
            subject: 'Voicemail from ' + callerName,
            html: '<p><strong>Voicemail received</strong> from <strong>' + callerName + '</strong></p><p>Duration: ' + durationStr + '</p>' + recordingLink + '<p>A callback task has been created in your SMIRK dashboard.</p>',
          }),
        });
        logEvent(CallSid, "VOICEMAIL_EMAIL_SENT", { to: vmOwnerEmail });
      } catch (emailErr: any) { log('warn', 'Voicemail email failed', { error: emailErr.message }); }
    } else {
      log('warn', 'Voicemail email skipped - OWNER_EMAIL, RESEND_API_KEY, or FROM_EMAIL not configured', { CallSid });
    }
  } catch (e: any) {
    log("error", "Twilio voicemail handler failed", { CallSid, error: e?.message || String(e) });
  }
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: "Polly.Matthew-Neural" as any }, "Thanks for leaving a message. We'll call you back shortly.");
  twiml.hangup();
  res.type("text/xml");
  return res.send(twiml.toString());
});'''

result = src[:start] + new_block + src[end:]
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(result)
print('Voicemail handler patched successfully.')
