#!/usr/bin/env python3
"""Read-only access to SMIRK's historical outbound campaign ledger.

The former draft/send engine bypassed SMIRK's recipient-specific approval,
QC, suppression, spend, and outcome ledger. Those commands now fail closed.
Historical CSV files remain readable so prior activity can be reconciled into
the canonical SMIRK system without losing audit evidence.
"""

import csv
import json
import os
import sys


BASE = os.path.dirname(os.path.abspath(__file__))
ENRICHED = os.path.join(BASE, "prospects_enriched.csv")
NATIONWIDE = os.path.join(BASE, "prospects_nationwide.csv")
LEDGER = os.path.join(BASE, "campaign_ledger.csv")
SUPPRESSION = os.path.join(BASE, "suppression.txt")

DISABLED_CODE = "SMIRK_GUARDED_OUTREACH_REQUIRED"
DISABLED_MESSAGE = (
    "Legacy outbound drafting and sending are disabled. Use the SMIRK "
    "recipient-specific QC, approval, and separate execution workflow."
)


def load_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def load_prospects():
    rows = []
    seen = set()
    for path in (ENRICHED, NATIONWIDE):
        for row in load_csv(path):
            email = (row.get("email") or "").strip().lower()
            key = email or (row.get("company") or "").strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            rows.append(row)
    return rows


def load_suppression():
    if not os.path.exists(SUPPRESSION):
        return set()
    with open(SUPPRESSION, encoding="utf-8") as handle:
        return {
            line.strip().lower()
            for line in handle
            if line.strip() and not line.lstrip().startswith("#")
        }


def cmd_status():
    ledger = load_csv(LEDGER)
    sent = [row for row in ledger if row.get("status") == "sent"]
    contacted = {
        (row.get("email") or "").strip().lower()
        for row in sent
        if (row.get("email") or "").strip()
    }
    replied = {
        (row.get("email") or "").strip().lower()
        for row in ledger
        if (row.get("email") or "").strip()
        and (row.get("response") or "").strip()
        not in ("", "no_response")
    }
    suppression = load_suppression()
    sendable = {
        (row.get("email") or "").strip().lower()
        for row in load_prospects()
        if (row.get("email") or "").strip()
        and (row.get("email") or "").strip().lower() not in suppression
    }
    print(f"Historical sendable prospects: {len(sendable)}")
    print(f"Historical contacted (unique): {len(contacted)}")
    print(f"Historical sends: {len(sent)}")
    print(f"Historical replies logged: {len(replied)}")
    print(f"Historical suppressions: {len(suppression)}")
    print("Execution: disabled; canonical SMIRK approval ledger required")


def fail_closed(command):
    print(
        json.dumps(
            {
                "ok": False,
                "code": DISABLED_CODE,
                "command": command,
                "message": DISABLED_MESSAGE,
                "externalAction": "none",
            },
            sort_keys=True,
        ),
        file=sys.stderr,
    )
    return 2


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "status":
        cmd_status()
        return 0
    if command in {"draft", "send"}:
        return fail_closed(command)
    print("Usage: python3 outbound/campaign.py status", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
