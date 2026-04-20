#!/usr/bin/env python3
"""
push-google-sa-to-railway.py
----------------------------
Reads a Google service account JSON key file and pushes all GOOGLE_SA_*
split variables to Railway using the Railway CLI.

Usage:
    python3 scripts/push-google-sa-to-railway.py /path/to/new-key.json

Requirements:
    - Railway CLI installed and RAILWAY_TOKEN set in environment
    - The token must be a project-scoped token for the ai-phone-agent service

The script sets these Railway variables:
    GOOGLE_SA_TYPE
    GOOGLE_SA_PROJECT_ID
    GOOGLE_SA_PRIVATE_KEY_ID
    GOOGLE_SA_CLIENT_EMAIL
    GOOGLE_SA_CLIENT_ID
    GOOGLE_SA_PRIVATE_KEY   (multiline — Railway CLI handles this correctly)

It does NOT touch GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CALENDAR_ID.
"""

import json
import os
import subprocess
import sys


RAILWAY_SERVICE = "ai-phone-agent"

SA_FIELD_MAP = {
    "GOOGLE_SA_TYPE": "type",
    "GOOGLE_SA_PROJECT_ID": "project_id",
    "GOOGLE_SA_PRIVATE_KEY_ID": "private_key_id",
    "GOOGLE_SA_CLIENT_EMAIL": "client_email",
    "GOOGLE_SA_CLIENT_ID": "client_id",
    "GOOGLE_SA_PRIVATE_KEY": "private_key",
}


def load_sa_json(path: str) -> dict:
    with open(path) as f:
        data = json.load(f)
    required = list(SA_FIELD_MAP.values())
    missing = [k for k in required if k not in data]
    if missing:
        print(f"ERROR: service account JSON is missing fields: {missing}", file=sys.stderr)
        sys.exit(1)
    return data


def set_railway_var(name: str, value: str) -> bool:
    """Set a single Railway variable. Returns True on success."""
    token = os.environ.get("RAILWAY_TOKEN")
    if not token:
        print("ERROR: RAILWAY_TOKEN environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    env = {**os.environ, "RAILWAY_TOKEN": token}
    result = subprocess.run(
        ["railway", "variables", "--set", f"{name}={value}", "--service", RAILWAY_SERVICE],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        print(f"  FAILED: {name}", file=sys.stderr)
        print(f"  stdout: {result.stdout.strip()}", file=sys.stderr)
        print(f"  stderr: {result.stderr.strip()}", file=sys.stderr)
        return False
    print(f"  OK: {name}")
    return True


def verify_calendar_endpoint():
    """Hit the calendar health endpoint and report status."""
    import urllib.request
    import urllib.error

    url = "https://ai-phone-agent-production-6811.up.railway.app/api/calendar/events"
    print(f"\nVerifying: GET {url}")
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            body = resp.read().decode()
            data = json.loads(body)
            if data.get("configured") and "error" not in data:
                print(f"  PASS: configured=true, no error field")
                print(f"  Events in calendar: {len(data.get('events', []))}")
            else:
                print(f"  WARN: response={body}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  HTTP {e.code}: {body}")
    except Exception as e:
        print(f"  ERROR: {e}")
        print("  (Service may still be redeploying — wait 60s and re-run verification)")


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 push-google-sa-to-railway.py /path/to/service-account.json")
        sys.exit(1)

    key_path = sys.argv[1]
    if not os.path.exists(key_path):
        print(f"ERROR: file not found: {key_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Loading service account from: {key_path}")
    sa = load_sa_json(key_path)
    print(f"  Account: {sa['client_email']}")
    print(f"  Project: {sa['project_id']}")
    print(f"  Key ID:  {sa['private_key_id']}")
    print()

    print(f"Pushing {len(SA_FIELD_MAP)} variables to Railway service '{RAILWAY_SERVICE}'...")
    failures = []
    for env_var, json_field in SA_FIELD_MAP.items():
        value = sa[json_field]
        ok = set_railway_var(env_var, value)
        if not ok:
            failures.append(env_var)

    print()
    if failures:
        print(f"FAILED to set: {failures}")
        print("Check RAILWAY_TOKEN and service name, then retry.")
        sys.exit(1)
    else:
        print("All variables set successfully.")
        print()
        print("Railway will redeploy automatically.")
        print("Waiting 30 seconds for redeploy, then verifying...")
        import time
        time.sleep(30)
        verify_calendar_endpoint()


if __name__ == "__main__":
    main()
