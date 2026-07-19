#!/usr/bin/env python3
"""Send Cam a sample of each sequence touch (t1, day-3, day-7) using a real
prospect's rendered copy, delivered to his Gmail. Does not touch the ledger."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from campaign import draft_email, sendable_prospects, resend_send

TARGET = "madeinreno775@gmail.com"

api_key = os.environ.get("RESEND_API_KEY", "").strip()
if not api_key:
    print("RESEND_API_KEY not set")
    sys.exit(1)

# pick a representative prospect: plumbing, Reno if available
pros = sendable_prospects()
sample = next(
    (p for p in pros if "plumb" in p["vertical"].lower() and "reno" in p["region"].lower()),
    pros[0],
)

for touch in (1, 2, 3):
    subject, body = draft_email(sample, touch)
    label = {1: "TOUCH 1 (day 0)", 2: "FOLLOW-UP (day 3)", 3: "FINAL (day 7)"}[touch]
    item = {
        "email": TARGET,
        "company": sample["company"],
        "subject": f"[SAMPLE — {label}] {subject}",
        "body": (
            f"(Sample of what prospects receive — rendered for {sample['company']}, "
            f"{sample['region']}. Not logged to the ledger.)\n\n{body}"
        ),
    }
    status, rid, err = resend_send(item, api_key)
    print(f"touch {touch}: status={status} err={err}")
