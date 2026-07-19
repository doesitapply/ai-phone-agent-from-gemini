#!/usr/bin/env python3
"""One-off verified missed-call callout to United Plumbing (Reno).

Context: Cam personally called United Plumbing on Sunday 2026-07-19 and hit
voicemail despite their 24-hour service claim. Verified missed call, so the
real-time callout angle is factual. United already received generic touch 1
yesterday, so this is framed as a "Re:" follow-up with the fresh data point
and logged as touch 2 (variant missed_call_callout_verified), which the
sequence engine will treat as their day-3 touch already delivered.
"""
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from campaign import CONFIG, append_ledger, resend_send  # noqa: E402

TO = "admin@unitednv.com"
COMPANY = "United Plumbing"
SUBJECT = f"Re: Missed calls at {COMPANY}"

BODY = f"""Hi {COMPANY} team,

Quick follow-up to my note yesterday, because it just happened for real.

Your site says 24-hour service, but I called earlier today and went straight to voicemail.

If I were a homeowner in Reno with a backed-up sewer, I wouldn't have left a message. I would have hung up and called the next plumber on Google. That's a $500 job handed straight to your competition while your guys are out living their Sunday.

I built SMIRK right here in Reno to stop exactly that. It answers the calls you miss, figures out what the emergency is, and texts YOU the details so you can call back and lock the job down before someone else does.

Don't take my word for it. Call the demo line right now at (775) 420-3005 and give it a fake emergency. You'll hear exactly what your customers would hear. If it makes sense, you can book time with me during that same call. Zero setup for your team.

Or try it from your desk: {CONFIG['launch_url']}

Cam | SMIRK
{CONFIG['physical_address']}
(Reply "stop" and I won't email you again.)"""


def main() -> None:
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("RESEND_API_KEY not set (source /home/ubuntu/.smirk_outbound_env)")
    print(f"Sending verified missed-call callout to {COMPANY} <{TO}>")
    status, rid, err = resend_send({"email": TO, "subject": SUBJECT, "body": BODY}, api_key)
    now = datetime.now(timezone.utc).isoformat()
    append_ledger([{
        "sent_at": now,
        "company": COMPANY,
        "vertical": "plumbing",
        "region": "Reno NV",
        "email": TO,
        "touch_number": "2",
        "subject": SUBJECT,
        "message_variant": "missed_call_callout_verified",
        "resend_id": rid,
        "status": status,
        "response": "",
        "notes": err or "Cam verified missed call by phone 2026-07-19 (Sunday), voicemail despite 24hr claim",
        "batch": "oneoff_callout",
        "contact_url": "",
    }])
    print(f"status={status} resend_id={rid} err={err or 'none'}")
    if status != "sent":
        sys.exit(1)


if __name__ == "__main__":
    main()
