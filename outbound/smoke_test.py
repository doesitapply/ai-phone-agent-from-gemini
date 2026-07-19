#!/usr/bin/env python3
"""One-shot smoke test: send the first drafted batch email to Cam's own inbox
instead of the prospect, using the exact same Resend send path campaign.py uses.
Does NOT touch the ledger or the pending batch."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from campaign import resend_send, PENDING

api_key = os.environ.get("RESEND_API_KEY", "").strip()
if not api_key:
    print("RESEND_API_KEY not set")
    sys.exit(1)

with open(PENDING) as f:
    item = json.load(f)["items"][0].copy()

real_target = item["email"]
item["email"] = "cam@smirkcalls.com"
item["subject"] = f"[SMOKE TEST] {item['subject']}"
item["body"] = (
    f"(Smoke test — this would have gone to {real_target}. "
    f"No prospect has been emailed.)\n\n" + item["body"]
)

status, rid, err = resend_send(item, api_key)
print(f"status={status} resend_id={rid} err={err}")
