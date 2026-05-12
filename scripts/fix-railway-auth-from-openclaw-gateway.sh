#!/usr/bin/env bash
set -euo pipefail
LABEL="${1:-ai.openclaw.gateway}"
UID_VALUE="$(id -u)"

echo "About to clear inherited RAILWAY_TOKEN from launchd and restart $LABEL"
echo "Command: launchctl unsetenv RAILWAY_TOKEN && launchctl kickstart -k gui/${UID_VALUE}/${LABEL}"

launchctl unsetenv RAILWAY_TOKEN
launchctl kickstart -k "gui/${UID_VALUE}/${LABEL}"

echo "Done. Re-run: npm run check:railway"
