#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_FILE="${TARGET_FILE:-$HOME/.openclaw/workspace/.env.operator}"
KEY_NAME="${KEY_NAME:-RAILWAY_API_TOKEN}"
SKIP_CHECK="${SKIP_CHECK:-0}"

TARGET_FILE="$TARGET_FILE" KEY_NAME="$KEY_NAME" "$SCRIPT_DIR/save-railway-auth.sh" <<EOF
$(cat)
EOF

TOKEN_VALUE="$(awk -F= -v key="$KEY_NAME" '$1 == key { value = substr($0, index($0, "=") + 1); gsub(/^"|"$/, "", value); print value; exit }' "$TARGET_FILE")"
export "$KEY_NAME=$TOKEN_VALUE"

echo "Loaded $KEY_NAME from $TARGET_FILE"

if [ "$SKIP_CHECK" = "1" ]; then
  echo "Check skipped"
  exit 0
fi

npm run check:railway
