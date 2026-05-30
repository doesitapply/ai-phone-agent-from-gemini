#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

bash "$SCRIPT_DIR/open-railway-token-page.sh"
bash "$SCRIPT_DIR/bootstrap-railway-auth-watch-clipboard-and-deploy.sh"
