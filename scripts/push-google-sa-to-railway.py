#!/usr/bin/env python3
"""
push-google-sa-to-railway.py
----------------------------
Reads a Google service account JSON key file and pushes all GOOGLE_SA_*
split variables to Railway using the Railway CLI.

Usage:
    # Push new key vars to Railway
    RAILWAY_TOKEN=<token> python3 push-google-sa-to-railway.py /path/to/new-key.json

    # Dry run — show what would be set without touching Railway
    RAILWAY_TOKEN=<token> python3 push-google-sa-to-railway.py /path/to/new-key.json --dry-run

    # Verify only — check the live calendar endpoint without setting anything
    RAILWAY_TOKEN=<token> python3 push-google-sa-to-railway.py --verify-only

Requirements:
    - Railway CLI installed (railway --version)
    - RAILWAY_TOKEN set to a project-scoped token for the target service
    - The JSON file must be a fresh, non-exposed Google service account key

Variables set:
    GOOGLE_SA_TYPE, GOOGLE_SA_PROJECT_ID, GOOGLE_SA_PRIVATE_KEY_ID,
    GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_CLIENT_ID, GOOGLE_SA_PRIVATE_KEY
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


RAILWAY_SERVICE = "ai-phone-agent"
VERIFY_URL = "https://ai-phone-agent-production-6811.up.railway.app/api/calendar/events"
REDEPLOY_WAIT_SECONDS = 35

SA_FIELD_MAP = {
    "GOOGLE_SA_TYPE": "type",
    "GOOGLE_SA_PROJECT_ID": "project_id",
    "GOOGLE_SA_PRIVATE_KEY_ID": "private_key_id",
    "GOOGLE_SA_CLIENT_EMAIL": "client_email",
    "GOOGLE_SA_CLIENT_ID": "client_id",
    "GOOGLE_SA_PRIVATE_KEY": "private_key",
}


def check_railway_cli():
    result = subprocess.run(["railway", "--version"], capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        print("ERROR: Railway CLI not found. Install: npm install -g @railway/cli", file=sys.stderr)
        sys.exit(1)
    print(f"Railway CLI: {result.stdout.strip()}")


def check_railway_token():
    token = os.environ.get("RAILWAY_TOKEN")
    if not token:
        print("ERROR: RAILWAY_TOKEN environment variable is not set.", file=sys.stderr)
        print("  Set it with: export RAILWAY_TOKEN=<your-project-scoped-token>", file=sys.stderr)
        sys.exit(1)
    print(f"RAILWAY_TOKEN: set ({token[:8]}...)")
    return token


def load_sa_json(path: str) -> dict:
    if not os.path.exists(path):
        print(f"ERROR: file not found: {path}", file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        data = json.load(f)
    required = list(SA_FIELD_MAP.values())
    missing = [k for k in required if k not in data]
    if missing:
        print(f"ERROR: service account JSON is missing fields: {missing}", file=sys.stderr)
        sys.exit(1)
    return data


def set_railway_var(name: str, value: str, token: str, dry_run: bool) -> bool:
    if dry_run:
        preview = value[:20].replace("\n", "\\n") + ("..." if len(value) > 20 else "")
        print(f"  [DRY RUN] would set: {name} = {preview}")
        return True

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


def verify_endpoint():
    print(f"\nVerifying: GET {VERIFY_URL}")
    try:
        with urllib.request.urlopen(VERIFY_URL, timeout=15) as resp:
            body = resp.read().decode()
            data = json.loads(body)
            if data.get("configured") and "error" not in data:
                print(f"  PASS: configured=true, no error field")
                print(f"  Events in calendar: {len(data.get('events', []))}")
                return True
            else:
                print(f"  WARN: unexpected response: {body}")
                return False
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  HTTP {e.code}: {body}")
        return False
    except Exception as e:
        print(f"  ERROR: {e}")
        print("  (Service may still be redeploying — wait 60s and re-run with --verify-only)")
        return False


def main():
    parser = argparse.ArgumentParser(description="Push Google SA split vars to Railway")
    parser.add_argument("key_file", nargs="?", help="Path to new service account JSON key file")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be set without touching Railway")
    parser.add_argument("--verify-only", action="store_true", help="Only verify the live endpoint, do not set vars")
    args = parser.parse_args()

    if args.verify_only:
        verify_endpoint()
        return

    if not args.key_file:
        parser.print_help()
        sys.exit(1)

    print("=== Railway Google SA Variable Push ===\n")
    check_railway_cli()
    token = check_railway_token()
    print()

    print(f"Loading service account from: {args.key_file}")
    sa = load_sa_json(args.key_file)
    print(f"  Account: {sa['client_email']}")
    print(f"  Project: {sa['project_id']}")
    print(f"  Key ID:  {sa['private_key_id']}")
    print()

    mode = "[DRY RUN] " if args.dry_run else ""
    print(f"{mode}Pushing {len(SA_FIELD_MAP)} variables to Railway service '{RAILWAY_SERVICE}'...")

    failures = []
    for env_var, json_field in SA_FIELD_MAP.items():
        value = sa[json_field]
        ok = set_railway_var(env_var, value, token, args.dry_run)
        if not ok:
            failures.append(env_var)

    print()
    if failures:
        print(f"FAILED to set: {failures}")
        print("Check RAILWAY_TOKEN and service name, then retry.")
        sys.exit(1)

    if args.dry_run:
        print("Dry run complete. No changes were made.")
        return

    print("All variables set successfully.")
    print(f"\nRailway will redeploy automatically.")
    print(f"Waiting {REDEPLOY_WAIT_SECONDS}s for redeploy...")
    time.sleep(REDEPLOY_WAIT_SECONDS)
    ok = verify_endpoint()
    if not ok:
        print("\nVerification failed. If Railway is still deploying, run:")
        print(f"  python3 push-google-sa-to-railway.py --verify-only")
        sys.exit(1)


if __name__ == "__main__":
    main()
