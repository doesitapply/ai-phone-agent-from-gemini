#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo '{"ok":false,"error":"missing-target","nextAction":"Usage: npm run set:test-call-allowlist -- +15551234567"}'
  exit 1
fi

source ./scripts/load-railway-auth.sh >/dev/null 2>&1 || true
CURRENT="$(railway variable list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{}");process.stdout.write(String(j.COMPLIANCE_ALWAYS_ALLOW_NUMBERS||""))})')"

if [[ -z "$CURRENT" ]]; then
  NEW_VALUE="$TARGET"
else
  case ",$CURRENT," in
    *",$TARGET,"*)
      echo "{\"ok\":true,\"changed\":false,\"value\":\"$CURRENT\"}"
      exit 0
      ;;
    *)
      NEW_VALUE="$CURRENT,$TARGET"
      ;;
  esac
fi

railway variable set "COMPLIANCE_ALWAYS_ALLOW_NUMBERS=$NEW_VALUE" >/dev/null
printf '{"ok":true,"changed":true,"value":"%s"}\n' "$NEW_VALUE"
