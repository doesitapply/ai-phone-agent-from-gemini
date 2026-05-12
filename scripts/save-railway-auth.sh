#!/usr/bin/env bash
set -euo pipefail

TARGET_FILE="${TARGET_FILE:-$HOME/.openclaw/workspace/.env.operator}"
KEY_NAME="${KEY_NAME:-RAILWAY_API_TOKEN}"

mkdir -p "$(dirname "$TARGET_FILE")"
touch "$TARGET_FILE"
chmod 600 "$TARGET_FILE"

TOKEN="$(cat)"
TOKEN="${TOKEN%$'\n'}"
TOKEN="${TOKEN%$'\r'}"

if [ -z "$TOKEN" ]; then
  echo "FAIL no token provided on stdin" >&2
  echo "Usage: printf '%s' '<token>' | ./scripts/save-railway-auth.sh" >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

awk -v key="$KEY_NAME" 'index($0, key "=") != 1 { print }' "$TARGET_FILE" > "$TMP_FILE"
printf '%s="%s"\n' "$KEY_NAME" "$TOKEN" >> "$TMP_FILE"
mv "$TMP_FILE" "$TARGET_FILE"
chmod 600 "$TARGET_FILE"

echo "Saved $KEY_NAME to $TARGET_FILE"
echo "Next: source ./scripts/load-railway-auth.sh && npm run check:railway"