#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo '{"ok":false,"error":"missing-target","usage":"CONFIRM_SMIRK_ALLOWLIST_MUTATION=update-proof-call-allowlist npm run set:test-call-allowlist -- <safe-number>","nextAction":"Run npm run print:real-call-setup first, choose a safe proof-call target, then rerun this only after explicit allowlist approval."}'
  exit 1
fi

if [[ "${CONFIRM_SMIRK_ALLOWLIST_MUTATION:-}" != "update-proof-call-allowlist" ]]; then
  echo '{"ok":false,"error":"missing-allowlist-mutation-confirmation","requiredEnv":"CONFIRM_SMIRK_ALLOWLIST_MUTATION","requiredValue":"update-proof-call-allowlist","nextAction":"Do not mutate the production proof-call allowlist unless the target is approved. Prefer choosing an already allowlisted target from npm run check:real-call-readiness."}'
  exit 1
fi

mask_phone() {
  local raw="$1"
  local digits suffix prefix
  digits="$(printf '%s' "$raw" | tr -cd '0-9')"
  suffix="${digits: -4}"
  prefix=""
  [[ "$raw" == +* ]] && prefix="+"
  if [[ -n "$suffix" ]]; then
    printf '%s***%s' "$prefix" "$suffix"
  else
    printf '***'
  fi
}

CURRENT="$(node scripts/read-railway-variable.mjs COMPLIANCE_ALWAYS_ALLOW_NUMBERS || true)"

if [[ -z "$CURRENT" ]]; then
  NEW_VALUE="$TARGET"
else
  case ",$CURRENT," in
    *",$TARGET,"*)
      COUNT="$(printf '%s' "$CURRENT" | awk -F',' '{print NF}')"
      printf '{"ok":true,"changed":false,"maskedTarget":"%s","allowlistedTargetCount":%s,"nextAction":"Run npm run check:real-call-readiness -- <safe-number> before placing the proof call."}\n' "$(mask_phone "$TARGET")" "$COUNT"
      exit 0
      ;;
    *)
      NEW_VALUE="$CURRENT,$TARGET"
      ;;
  esac
fi

railway variable set "COMPLIANCE_ALWAYS_ALLOW_NUMBERS=$NEW_VALUE" >/dev/null
COUNT="$(printf '%s' "$NEW_VALUE" | awk -F',' '{print NF}')"
printf '{"ok":true,"changed":true,"maskedTarget":"%s","allowlistedTargetCount":%s,"nextAction":"Run npm run check:real-call-readiness -- <safe-number> before placing the proof call."}\n' "$(mask_phone "$TARGET")" "$COUNT"
