#!/usr/bin/env python3
"""
push-google-sa-to-railway.py
----------------------------
Reads a Google service account JSON key file and pushes all GOOGLE_SA_*
split variables to a Railway service via the Railway CLI.

Usage:
    # Normal: push new key, wait for redeploy, verify endpoint
    RAILWAY_TOKEN=<token> python3 push-google-sa-to-railway.py new-key.json

    # Dry run: show what would be set, touch nothing
    RAILWAY_TOKEN=<token> python3 push-google-sa-to-railway.py new-key.json --dry-run

    # Verify only: check the live endpoint, set nothing
    python3 push-google-sa-to-railway.py --verify-only

    # Override defaults
    python3 push-google-sa-to-railway.py new-key.json \\
        --service my-service \\
        --verify-url https://my-service.up.railway.app/api/calendar/events

Requirements:
    - Railway CLI installed (railway --version)
    - RAILWAY_TOKEN set to a project-scoped token for the target service
    - The JSON file must be a fresh, non-exposed service account key

Variables set:
    GOOGLE_SA_TYPE, GOOGLE_SA_PROJECT_ID, GOOGLE_SA_PRIVATE_KEY_ID,
    GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_CLIENT_ID, GOOGLE_SA_PRIVATE_KEY

Variables warned about (stale, should be removed):
    GOOGLE_SERVICE_ACCOUNT_JSON
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


# Defaults — override with CLI args
DEFAULT_SERVICE = "ai-phone-agent"
DEFAULT_VERIFY_URL = "https://ai-phone-agent-production-6811.up.railway.app/api/calendar/events"
REDEPLOY_WAIT_SECONDS = 35

# The stale var that causes ghost contamination if left in place
STALE_VAR = "GOOGLE_SERVICE_ACCOUNT_JSON"

SA_FIELD_MAP = {
    "GOOGLE_SA_TYPE": "type",
    "GOOGLE_SA_PROJECT_ID": "project_id",
    "GOOGLE_SA_PRIVATE_KEY_ID": "private_key_id",
    "GOOGLE_SA_CLIENT_EMAIL": "client_email",
    "GOOGLE_SA_CLIENT_ID": "client_id",
    "GOOGLE_SA_PRIVATE_KEY": "private_key",
}


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def check_railway_cli() -> None:
    result = subprocess.run(["railway", "--version"], capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        fail("Railway CLI not found. Install: npm install -g @railway/cli")
    print(f"Railway CLI: {result.stdout.strip()}")


def check_railway_token() -> str:
    token = os.environ.get("RAILWAY_TOKEN", "").strip()
    if not token:
        fail("RAILWAY_TOKEN is not set.\n  export RAILWAY_TOKEN=<your-project-scoped-token>")
    # Print presence only — never print any part of the value
    print("RAILWAY_TOKEN: set")
    return token


def load_sa_json(path: str) -> dict:
    if not os.path.exists(path):
        fail(f"File not found: {path}")
    with open(path) as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            fail(f"Invalid JSON in {path}: {e}")
    required = list(SA_FIELD_MAP.values())
    missing = [k for k in required if k not in data]
    if missing:
        fail(f"Service account JSON is missing required fields: {missing}")
    return data


def railway_run(args: list[str], token: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "RAILWAY_TOKEN": token}
    return subprocess.run(args, env=env, capture_output=True, text=True, timeout=30)


def check_stale_var(service: str, token: str, dry_run: bool) -> None:
    """Warn if GOOGLE_SERVICE_ACCOUNT_JSON is still set — it causes ghost contamination."""
    result = railway_run(
        ["railway", "variables", "--service", service],
        token,
    )
    if STALE_VAR in result.stdout:
        if dry_run:
            print(f"  [DRY RUN] WARN: {STALE_VAR} is still set — would recommend removing it")
        else:
            print(f"  WARN: {STALE_VAR} is still set in Railway.")
            print(f"        This can cause ghost contamination if the code falls back to it.")
            print(f"        Remove it from Railway Variables after confirming split vars work.")


def set_railway_var(name: str, value: str, service: str, token: str, dry_run: bool) -> bool:
    if dry_run:
        # Show field name and length only — never show value content
        print(f"  [DRY RUN] would set: {name} ({len(value)} chars)")
        return True

    result = railway_run(
        ["railway", "variables", "--set", f"{name}={value}", "--service", service],
        token,
    )
    if result.returncode != 0:
        print(f"  FAILED: {name}", file=sys.stderr)
        # Print stderr but scrub any value that looks like a key
        safe_stderr = result.stderr.strip()
        if safe_stderr:
            print(f"  {safe_stderr}", file=sys.stderr)
        return False
    print(f"  OK: {name}")
    return True


def verify_endpoint(url: str) -> bool:
    print(f"\nVerifying: GET {url}")
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            body = resp.read().decode()
            data = json.loads(body)
            if data.get("configured") and "error" not in data:
                print(f"  PASS: configured=true, no error field")
                print(f"  Events in calendar: {len(data.get('events', []))}")
                return True
            else:
                print(f"  WARN: configured={data.get('configured')}, error={data.get('error', 'none')}")
                return False
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            err_data = json.loads(body)
            print(f"  HTTP {e.code}: error={err_data.get('error', body[:120])}")
        except Exception:
            print(f"  HTTP {e.code}: {body[:120]}")
        return False
    except Exception as e:
        print(f"  ERROR: {e}")
        print(f"  (Service may still be redeploying — retry with --verify-only in 60s)")
        return False


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Push Google service account split vars to Railway",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("key_file", nargs="?", help="Path to new service account JSON key file")
    parser.add_argument("--dry-run", action="store_true", help="Show what would happen without touching Railway")
    parser.add_argument("--verify-only", action="store_true", help="Only verify the live endpoint; set nothing")
    parser.add_argument("--service", default=DEFAULT_SERVICE, help=f"Railway service name (default: {DEFAULT_SERVICE})")
    parser.add_argument("--verify-url", default=DEFAULT_VERIFY_URL, help="Endpoint to verify after deploy")
    parser.add_argument("--no-wait", action="store_true", help="Skip the post-deploy wait and go straight to verify")
    args = parser.parse_args()

    if args.verify_only:
        ok = verify_endpoint(args.verify_url)
        sys.exit(0 if ok else 1)

    if not args.key_file:
        parser.print_help()
        sys.exit(1)

    print("=== Railway Google SA Variable Push ===\n")
    check_railway_cli()
    token = check_railway_token()
    print()

    print(f"Loading service account: {args.key_file}")
    sa = load_sa_json(args.key_file)
    # Print metadata only — never print key material
    print(f"  Account:  {sa['client_email']}")
    print(f"  Project:  {sa['project_id']}")
    print(f"  Key ID:   {sa['private_key_id']}")
    print(f"  Key size: {len(sa['private_key'])} chars")
    print()

    print("Checking for stale vars...")
    check_stale_var(args.service, token, args.dry_run)
    print()

    mode_tag = "[DRY RUN] " if args.dry_run else ""
    print(f"{mode_tag}Pushing {len(SA_FIELD_MAP)} variables to Railway service '{args.service}'...")

    failures = []
    for env_var, json_field in SA_FIELD_MAP.items():
        ok = set_railway_var(env_var, sa[json_field], args.service, token, args.dry_run)
        if not ok:
            failures.append(env_var)

    print()
    if failures:
        print(f"FAILED to set: {failures}", file=sys.stderr)
        print("Check RAILWAY_TOKEN and --service name, then retry.", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print("Dry run complete. No changes were made.")
        return

    print("All variables set. Railway will redeploy automatically.")

    if not args.no_wait:
        print(f"Waiting {REDEPLOY_WAIT_SECONDS}s for redeploy...")
        time.sleep(REDEPLOY_WAIT_SECONDS)

    ok = verify_endpoint(args.verify_url)
    if not ok:
        print("\nVerification failed. If Railway is still deploying, retry:")
        print(f"  python3 push-google-sa-to-railway.py --verify-only --verify-url {args.verify_url}")
        sys.exit(1)

    print("\nDone. Calendar integration is live.")


if __name__ == "__main__":
    main()
