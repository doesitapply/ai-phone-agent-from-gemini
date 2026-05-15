#!/usr/bin/env bash
set -euo pipefail

KEY="${1:-}"
TARGET="${2:-auto}"
SECRET_VALUE="${SECRET_VALUE:-}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOME/.openclaw/workspace}"
OPERATOR_ENV="$WORKSPACE_ROOT/.env.operator"
SMIRK_ENV="$WORKSPACE_ROOT/.env.smirk"
STATE_DIR="$WORKSPACE_ROOT/state"
INVENTORY_FILE="$STATE_DIR/secret-inventory.json"

usage() {
  cat <<'EOF'
Usage:
  SECRET_VALUE='value' bash scripts/set-operator-secret.sh KEY [operator|smirk|auto]

Examples:
  SECRET_VALUE='railway_abc123' bash scripts/set-operator-secret.sh RAILWAY_API_TOKEN operator
  SECRET_VALUE='re_xxx' bash scripts/set-operator-secret.sh RESEND_API_KEY smirk
  SECRET_VALUE='SMIRK <alerts@smirkcalls.com>' bash scripts/set-operator-secret.sh FROM_EMAIL smirk

Behavior:
  - upserts the key into ~/.openclaw/workspace/.env.operator or .env.smirk
  - creates/updates ~/.openclaw/workspace/state/secret-inventory.json
  - never prints the raw secret value
EOF
}

if [ -z "$KEY" ] || [ "$KEY" = "-h" ] || [ "$KEY" = "--help" ]; then
  usage
  exit 1
fi

if [ -z "$SECRET_VALUE" ]; then
  echo "FAIL SECRET_VALUE is empty. Pass the value via environment, not CLI history." >&2
  exit 1
fi

mask() {
  local value="$1"
  local len=${#value}
  if [ "$len" -le 8 ]; then
    printf '%s' '***'
  else
    printf '%s...%s' "${value:0:4}" "${value: -4}"
  fi
}

pick_target() {
  local key="$1"
  case "$key" in
    RAILWAY_TOKEN|RAILWAY_API_TOKEN|GITHUB_TOKEN|GITHUB_PAT|NAMECHEAP_*|STRIPE_SECRET_KEY|STRIPE_API_KEY|RESEND_DASHBOARD_* )
      printf '%s' 'operator'
      ;;
    *)
      printf '%s' 'smirk'
      ;;
  esac
}

if [ "$TARGET" = "auto" ]; then
  TARGET="$(pick_target "$KEY")"
fi

case "$TARGET" in
  operator) ENV_FILE="$OPERATOR_ENV" ;;
  smirk) ENV_FILE="$SMIRK_ENV" ;;
  *) echo "FAIL target must be operator, smirk, or auto" >&2; exit 1 ;;
esac

mkdir -p "$STATE_DIR"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE" || true

python3 - "$ENV_FILE" "$KEY" "$SECRET_VALUE" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
if path.exists():
    lines = path.read_text().splitlines()
else:
    lines = []
out = []
replaced = False
for line in lines:
    if line.startswith(key + '='):
        out.append(f'{key}={value}')
        replaced = True
    else:
        out.append(line)
if not replaced:
    if out and out[-1].strip():
        out.append('')
    out.append(f'{key}={value}')
path.write_text('\n'.join(out).rstrip() + '\n')
PY

python3 - "$INVENTORY_FILE" "$KEY" "$TARGET" "$ENV_FILE" <<'PY'
import json, sys, os
from datetime import datetime, timezone
path = sys.argv[1]
key = sys.argv[2]
target = sys.argv[3]
env_file = os.path.expanduser(sys.argv[4])
now = datetime.now(timezone.utc).isoformat()
if os.path.exists(path):
    try:
        data = json.load(open(path))
    except Exception:
        data = {}
else:
    data = {}
if not isinstance(data, dict):
    data = {}
data[key] = {
    'target': target,
    'env_file': env_file,
    'present': True,
    'updated_at': now,
}
with open(path, 'w') as f:
    json.dump(dict(sorted(data.items())), f, indent=2)
    f.write('\n')
PY

printf 'OK saved %s to %s (%s)\n' "$KEY" "$ENV_FILE" "$(mask "$SECRET_VALUE")"
printf 'Inventory updated: %s\n' "$INVENTORY_FILE"
