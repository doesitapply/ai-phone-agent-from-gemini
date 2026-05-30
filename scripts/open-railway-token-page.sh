#!/usr/bin/env bash
set -euo pipefail

URL="https://railway.app/account/tokens"

if command -v open >/dev/null 2>&1; then
  open "$URL"
  echo "Opened Railway token page: $URL"
else
  echo "Open this URL to create/copy a Railway token: $URL"
fi
