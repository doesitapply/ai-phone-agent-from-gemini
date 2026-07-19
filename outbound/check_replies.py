#!/usr/bin/env python3
"""Update campaign_ledger.csv response fields from a replies JSON file.

Input: outbound/replies.json — list of {"email": ..., "classification": ...,
"note": ...} entries produced by the daily run's inbox check (Gmail search for
messages from prospect addresses).

Classifications: interested | question | not_now | opt_out | bounce
  * opt_out and bounce addresses get appended to suppression.txt
  * any reply halts further follow-ups for that address (touch_state logic)
"""
import csv
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
LEDGER = os.path.join(BASE, "campaign_ledger.csv")
SUPPRESSION = os.path.join(BASE, "suppression.txt")
REPLIES = os.path.join(BASE, "replies.json")

VALID = {"interested", "question", "not_now", "opt_out", "bounce"}


def main():
    if not os.path.exists(REPLIES):
        print("No replies.json — nothing to update.")
        return
    replies = json.load(open(REPLIES))
    if not replies:
        print("replies.json empty — nothing to update.")
        return
    by_email = {}
    for r in replies:
        c = r.get("classification", "").strip()
        if c not in VALID:
            print(f"skip invalid classification: {r}", file=sys.stderr)
            continue
        by_email[r["email"].strip().lower()] = (c, r.get("note", ""))

    rows = list(csv.DictReader(open(LEDGER)))
    fields = rows[0].keys() if rows else []
    updated = 0
    for row in rows:
        e = row["email"].lower()
        if e in by_email:
            c, note = by_email[e]
            if row["response"] in ("", "no_response"):
                row["response"] = c
                if note:
                    row["notes"] = (row["notes"] + " | " if row["notes"] else "") + note
                updated += 1
    with open(LEDGER, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    # suppression for opt-outs and bounces
    to_suppress = [e for e, (c, _) in by_email.items() if c in ("opt_out", "bounce")]
    if to_suppress:
        existing = set()
        if os.path.exists(SUPPRESSION):
            existing = {l.strip().lower() for l in open(SUPPRESSION) if l.strip()}
        with open(SUPPRESSION, "a") as f:
            for e in to_suppress:
                if e not in existing:
                    f.write(e + "\n")
    print(f"Updated {updated} ledger rows. Suppressed {len(to_suppress)}.")


if __name__ == "__main__":
    main()
