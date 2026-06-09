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

if [ -z "$TOKEN" ] && [ -n "${RAILWAY_API_TOKEN:-}" ]; then
  TOKEN="$RAILWAY_API_TOKEN"
elif [ -z "$TOKEN" ] && [ -n "${RAILWAY_TOKEN:-}" ]; then
  TOKEN="$RAILWAY_TOKEN"
fi

if [ -z "$TOKEN" ]; then
  echo "FAIL no token provided on stdin or environment" >&2
  echo "Get one at: https://railway.app/account/tokens" >&2
  echo "Need the exact steps? Run: npm run -s print:railway-auth-setup" >&2
  echo "Preferred: printf '%s' '<token>' | npm run -s bootstrap:railway-auth" >&2
  echo "Env fallback: RAILWAY_API_TOKEN='<token>' npm run -s bootstrap:railway-auth" >&2
  echo "Alternative: printf '%s' '<token>' | npm run -s save:railway-auth" >&2
  echo "Low-level usage: printf '%s' '<token>' | ./scripts/save-railway-auth.sh" >&2
  exit 1
fi

case "$TOKEN" in
  "***"|"fake-token"|"<token>"|"<valid-token>"|"your-token-here"|"replace-me")
    echo "FAIL token looks like a placeholder/masked value; refusing to save it" >&2
    echo "Paste a real Railway token from https://railway.app/account/tokens" >&2
    exit 1
    ;;
esac

if ! printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9._:-]{24,255}$'; then
  echo "FAIL token does not look like a Railway token; refusing to save it" >&2
  echo "Copy only the token value from https://railway.app/account/tokens, not a file path, page text, or masked value." >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

awk -v key="$KEY_NAME" 'index($0, key "=") != 1 { print }' "$TARGET_FILE" > "$TMP_FILE"
printf '%s="%s"\n' "$KEY_NAME" "$TOKEN" >> "$TMP_FILE"
mv "$TMP_FILE" "$TARGET_FILE"
chmod 600 "$TARGET_FILE"

SAVED_VALUE="$(awk -F= -v key="$KEY_NAME" '$1 == key { value = substr($0, index($0, "=") + 1); gsub(/^"|"$/, "", value); print value; exit }' "$TARGET_FILE")"
if [ -z "$SAVED_VALUE" ]; then
  echo "FAIL save appeared to succeed but $KEY_NAME could not be read back from $TARGET_FILE" >&2
  exit 1
fi

echo "Saved $KEY_NAME to $TARGET_FILE"
echo "Verified $KEY_NAME was written"
echo "Next: npm run -s check:railway"
echo "Then: npm run -s check:deploy-post-call-fix-ready"
echo "Then: npm run write:deploy-approval-bundle"
echo "Then: CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix"
