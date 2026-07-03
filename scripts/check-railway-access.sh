#!/usr/bin/env bash
set -euo pipefail

if [ -f "./scripts/load-railway-auth.sh" ]; then
  # shellcheck disable=SC1091
  source ./scripts/load-railway-auth.sh >/dev/null 2>/dev/null || true
fi

EXPECTED_PROJECT="ai-phone-agent"
EXPECTED_ENVIRONMENT="production"
EXPECTED_SERVICE="ai-phone-agent"
DEPLOY_BRANCH="$(git branch --show-current 2>/dev/null || true)"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
if [ "$DEPLOY_BRANCH" = "main" ]; then
  DEPLOY_COMMAND="CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix npm run deploy:post-call-fix"
else
  DEPLOY_COMMAND="CONFIRM_SMIRK_POST_CALL_FIX_DEPLOY=deploy-post-call-fix CONFIRM_SMIRK_DEPLOY_BRANCH=$DEPLOY_BRANCH npm run deploy:post-call-fix"
fi
COMMON_ENV_FILES=(
  "$HOME/.openclaw/workspace/.env.operator"
  "$HOME/.openclaw/workspace/.env.smirk"
  "$HOME/.openclaw/workspace/.env"
)
COMMON_SHELL_FILES=(
  "$HOME/.zshrc"
  "$HOME/.zprofile"
  "$HOME/.zshenv"
  "$HOME/.bashrc"
  "$HOME/.bash_profile"
  "$HOME/.profile"
)
RAILWAY_CLI_ATTEMPTS="${SMIRK_RAILWAY_CLI_ATTEMPTS:-4}"
RAILWAY_CLI_RETRY_DELAY="${SMIRK_RAILWAY_CLI_RETRY_DELAY_SECONDS:-3}"
is_retryable_railway_output() {
  printf '%s' "$1" | grep -Eqi 'rate[ -]?limit|ratelimit|ratelimited|too many requests|ECONNRESET|ETIMEDOUT|timeout'
}
run_railway_with_retry() {
  local __out_var="$1"
  shift
  local attempt code output
  attempt=1
  while [ "$attempt" -le "$RAILWAY_CLI_ATTEMPTS" ]; do
    code=0
    output="$(railway "$@" 2>&1)" || code=$?
    if [ "$code" -eq 0 ]; then
      printf -v "$__out_var" '%s' "$output"
      return 0
    fi
    if [ "$attempt" -lt "$RAILWAY_CLI_ATTEMPTS" ] && is_retryable_railway_output "$output"; then
      echo "WARN railway $* failed with retryable Railway CLI output; retrying in ${RAILWAY_CLI_RETRY_DELAY}s (${attempt}/${RAILWAY_CLI_ATTEMPTS})" >&2
      sleep "$RAILWAY_CLI_RETRY_DELAY"
      attempt=$((attempt + 1))
      continue
    fi
    printf -v "$__out_var" '%s' "$output"
    return "$code"
  done
  return 1
}
find_openclaw_gateway_token_hint() {
  local gateway_line gateway_pid gateway_env gateway_token gateway_label
  gateway_line="$(ps -axo pid=,command= | grep 'openclaw/dist/index.js gateway' | grep -v grep | head -n 1 || true)"
  [ -n "$gateway_line" ] || return 1
  gateway_pid="$(printf '%s' "$gateway_line" | awk '{print $1}')"
  [ -n "$gateway_pid" ] || return 1
  gateway_env="$(ps eww -p "$gateway_pid" 2>/dev/null || true)"
  gateway_token="$(printf '%s' "$gateway_env" | sed -n 's/.*RAILWAY_TOKEN=\([^ ]*\).*/\1/p' | head -n 1)"
  gateway_label="$(printf '%s' "$gateway_env" | sed -n 's/.*OPENCLAW_LAUNCHD_LABEL=\([^ ]*\).*/\1/p' | head -n 1)"
  if [ -n "$gateway_token" ]; then
    local relation="different from active token"
    if [ "$gateway_token" = "$current_token" ]; then
      relation="matches active token"
    fi
    if [ -n "$gateway_label" ]; then
      echo "OpenClaw gateway pid $gateway_pid carries RAILWAY_TOKEN ($(mask_token "$gateway_token"), $relation); launchd label: $gateway_label"
      return 0
    fi
    echo "OpenClaw gateway pid $gateway_pid carries RAILWAY_TOKEN ($(mask_token "$gateway_token"), $relation)"
    return 0
  fi
  echo "OpenClaw gateway pid $gateway_pid found, but no RAILWAY_TOKEN was visible in its process environment"
}
mask_token() {
  local raw="$1"
  local len=${#raw}
  if [ "$len" -le 0 ]; then
    printf 'empty'
    return
  fi
  printf 'present len=%s redacted=true' "$len"
}
read_token_from_file() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 1
  awk -F= -v target="$key" '
    $1 == target {
      value = substr($0, index($0, "=") + 1)
      gsub(/^"|"$/, "", value)
      gsub(/^'"'"'|'"'"'$/, "", value)
      print value
      exit
    }
  ' "$file"
}
file_token_hint() {
  local file="$1"
  local key="$2"
  if ! grep -Eq "^${key}=" "$file"; then
    return 1
  fi
  local value
  value="$(read_token_from_file "$file" "$key" || true)"
  if [ -z "$value" ]; then
    echo "$key is blank in $file"
    return 0
  fi
  local relation="different from active token"
  if [ "$value" = "$current_token" ]; then
    relation="matches active token"
  fi
  echo "$key in $file ($(mask_token "$value"), $relation)"
}
looks_placeholder_token() {
  case "$1" in
    "***"|"fake-token"|"<token>"|"<valid-token>"|"your-token-here"|"replace-me") return 0 ;;
    *) return 1 ;;
  esac
}
TOKEN_SOURCE=""
TOKEN_ORIGIN=""
if [ -n "${RAILWAY_API_TOKEN:-}" ]; then
  TOKEN_SOURCE="RAILWAY_API_TOKEN"
  TOKEN_ORIGIN="process environment"
elif [ -n "${RAILWAY_TOKEN:-}" ]; then
  TOKEN_SOURCE="RAILWAY_TOKEN"
  TOKEN_ORIGIN="process environment"
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "FAIL railway CLI not installed" >&2
  exit 1
fi

if [ -z "$TOKEN_SOURCE" ]; then
  target_file="$HOME/.openclaw/workspace/.env.operator"
  echo "FAIL Railway auth missing" >&2
  echo "Create/copy a Railway token at https://railway.app/account/tokens, then save RAILWAY_API_TOKEN into $target_file." >&2
  echo "Primary path (macOS):" >&2
  echo "  npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy" >&2
  echo "Need the exact steps? Run: npm run -s print:railway-auth-setup" >&2
  echo "Fast path:" >&2
  echo "  printf '%s' '<real-token>' | TARGET_FILE='$target_file' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth" >&2
  echo "Save-only path:" >&2
  echo "  printf '%s' '<real-token>' | SKIP_CHECK=1 TARGET_FILE='$target_file' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth" >&2
  echo "Env-var path:" >&2
  echo "  RAILWAY_API_TOKEN='<real-token>' TARGET_FILE='$target_file' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth" >&2
  echo "One-shot path:" >&2
  echo "  printf '%s' '<real-token>' | TARGET_FILE='$target_file' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy" >&2
  echo "Clipboard path (macOS):" >&2
  echo "  Copy the Railway token, then run: npm run -s bootstrap:railway-auth-from-clipboard-and-deploy" >&2
  echo "Clipboard watch path (macOS):" >&2
  echo "  npm run -s bootstrap:railway-auth-watch-clipboard-and-deploy" >&2
  echo "Alternative:" >&2
  echo "  printf '%s' '<real-token>' | TARGET_FILE='$target_file' KEY_NAME='RAILWAY_API_TOKEN' npm run -s save:railway-auth" >&2
  echo "After auth is restored:" >&2
  echo "  npm run -s check:railway" >&2
  echo "  npm run -s check:deploy-post-call-fix-ready" >&2
  echo "  npm run write:deploy-approval-bundle" >&2
  echo "  $DEPLOY_COMMAND" >&2
  if ! [ -f "$target_file" ] || ! grep -Eq '^RAILWAY_API_TOKEN=' "$target_file"; then
    echo "Hint: $target_file currently has no RAILWAY_API_TOKEN entry." >&2
  fi
  for env_file in "${COMMON_ENV_FILES[@]}"; do
    if [ -f "$env_file" ]; then
      if grep -Eq '^RAILWAY_API_TOKEN=' "$env_file"; then
        hint="$(file_token_hint "$env_file" "RAILWAY_API_TOKEN" || true)"
        [ -n "$hint" ] && echo "Hint: $hint" >&2
      fi
      if grep -Eq '^RAILWAY_TOKEN=' "$env_file"; then
        hint="$(file_token_hint "$env_file" "RAILWAY_TOKEN" || true)"
        if [ -n "$hint" ]; then
          if [[ "$hint" == *"blank in"* ]]; then
            echo "Hint: $hint (safe to ignore unless you intend to use RAILWAY_TOKEN there)" >&2
          else
            echo "Hint: $hint" >&2
          fi
        fi
      fi
    fi
  done
  exit 1
fi

current_token="${!TOKEN_SOURCE}"
echo "Using Railway token from $TOKEN_SOURCE ($TOKEN_ORIGIN, $(mask_token "$current_token"))"

if looks_placeholder_token "$current_token"; then
  echo "FAIL Railway auth placeholder token" >&2
  echo "Token source: $TOKEN_SOURCE ($TOKEN_ORIGIN, $(mask_token "$current_token"))" >&2
  for env_file in "${COMMON_ENV_FILES[@]}"; do
    if [ -f "$env_file" ] && grep -Eq "^${TOKEN_SOURCE}=" "$env_file"; then
      hint="$(file_token_hint "$env_file" "$TOKEN_SOURCE")"
      echo "Hint: $hint" >&2
    fi
  done
  echo "Replace the placeholder with a real Railway token from https://railway.app/account/tokens" >&2
  echo "Primary path (macOS): npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy" >&2
  echo "Fast path: printf '%s' '<real-token>' | npm run -s bootstrap:railway-auth" >&2
  echo "Env-var path: RAILWAY_API_TOKEN='<real-token>' npm run -s bootstrap:railway-auth" >&2
  echo "One-shot path: printf '%s' '<real-token>' | npm run -s bootstrap:railway-auth-and-deploy" >&2
  exit 1
fi

emit_auth_failure() {
  local auth_output="$1"
  echo "FAIL Railway auth invalid" >&2
  echo "Token source: $TOKEN_SOURCE ($TOKEN_ORIGIN, $(mask_token "$current_token"))" >&2
  any_file_match=0
  any_file_nonblank_match=0
  for env_file in "${COMMON_ENV_FILES[@]}"; do
    if [ -f "$env_file" ] && grep -Eq "^${TOKEN_SOURCE}=" "$env_file"; then
      any_file_match=1
      hint="$(file_token_hint "$env_file" "$TOKEN_SOURCE")"
      echo "Hint: $hint" >&2
      if [[ "$hint" != *"blank in"* ]]; then
        any_file_nonblank_match=1
      fi
    fi
  done
  if [ "$TOKEN_ORIGIN" = "process environment" ] && [ "$any_file_match" -eq 1 ] && [ "$any_file_nonblank_match" -eq 0 ]; then
    echo "Hint: the invalid token is coming from the current shell, not the local env files; unset $TOKEN_SOURCE or replace it in the shell before retrying." >&2
    shell_match=0
    for shell_file in "${COMMON_SHELL_FILES[@]}"; do
      if [ -f "$shell_file" ] && grep -Eq "${TOKEN_SOURCE}|RAILWAY_API_TOKEN" "$shell_file"; then
        shell_match=1
        echo "Hint: shell startup file references Railway auth: $shell_file" >&2
      fi
    done
    if [ "$shell_match" -eq 0 ]; then
      parent_pid="$(ps -o ppid= -p $$ | tr -d ' ' || true)"
      parent_cmd=""
      grandparent_pid=""
      grandparent_cmd=""
      if [ -n "$parent_pid" ]; then
        parent_cmd="$(ps -o command= -p "$parent_pid" 2>/dev/null || true)"
        grandparent_pid="$(ps -o ppid= -p "$parent_pid" 2>/dev/null | tr -d ' ' || true)"
      fi
      if [ -n "$grandparent_pid" ]; then
        grandparent_cmd="$(ps -o command= -p "$grandparent_pid" 2>/dev/null || true)"
      fi
      echo "Hint: no common shell startup files reference Railway auth; the bad token is likely inherited from the parent session or launcher environment." >&2
      if [ -n "$parent_cmd" ]; then
        echo "Hint: parent process appears to be: $parent_cmd" >&2
      fi
      if [ -n "$grandparent_cmd" ]; then
        echo "Hint: grandparent process appears to be: $grandparent_cmd" >&2
      fi
      gateway_hint="$(find_openclaw_gateway_token_hint || true)"
      if [ -n "$gateway_hint" ]; then
        echo "Hint: $gateway_hint" >&2
        gateway_label="$(printf '%s' "$gateway_hint" | sed -n 's/.*launchd label: \([^ ]*\).*/\1/p' | head -n 1)"
      fi
    fi
  fi
  echo "Try one of:" >&2
  echo "  unset $TOKEN_SOURCE && npm run check:ship-live" >&2
  echo "  npm run -s bootstrap:railway-auth-open-page-watch-clipboard-and-deploy" >&2
  echo "  printf '%s' '<valid-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth" >&2
  echo "  RAILWAY_API_TOKEN='<valid-token>' TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth" >&2
  echo "  printf '%s' '<valid-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s bootstrap:railway-auth-and-deploy" >&2
  echo "  # or: printf '%s' '<valid-token>' | TARGET_FILE='$HOME/.openclaw/workspace/.env.operator' KEY_NAME='RAILWAY_API_TOKEN' npm run -s save:railway-auth" >&2
  if [ -n "${gateway_label:-}" ]; then
    echo "  launchctl unsetenv RAILWAY_TOKEN && launchctl kickstart -k gui/$(id -u)/$gateway_label" >&2
  fi
  echo "Set a valid RAILWAY_TOKEN or RAILWAY_API_TOKEN (create/copy one at https://railway.app/account/tokens), or use the Railway dashboard." >&2
  echo "Need the exact steps? Run: npm run -s print:railway-auth-setup" >&2
  printf '%s\n' "$auth_output" >&2
  exit 1
}

whoami_output=""
whoami_code=0
run_railway_with_retry whoami_output whoami || whoami_code=$?
if [ "$whoami_code" -ne 0 ]; then
  if is_retryable_railway_output "$whoami_output"; then
    echo "WARN railway whoami failed with retryable Railway CLI output; trying Railway GraphQL access check" >&2
    EXPECTED_PROJECT="$EXPECTED_PROJECT" EXPECTED_ENVIRONMENT="$EXPECTED_ENVIRONMENT" EXPECTED_SERVICE="$EXPECTED_SERVICE" node scripts/check-railway-graphql-access.mjs
    exit $?
  fi
  if printf '%s' "$whoami_output" | grep -qi 'Invalid RAILWAY_TOKEN\|Unauthorized\|token\|login\|error decoding response body'; then
    emit_auth_failure "$whoami_output"
  fi
  echo "FAIL railway whoami failed" >&2
  printf '%s\n' "$whoami_output" >&2
  exit 1
fi

status_output=""
status_code=0
status_json_output=""
run_railway_with_retry status_json_output status --json || status_code=$?

if [ "$status_code" -ne 0 ]; then
  if printf '%s' "$status_json_output" | grep -qi 'Invalid RAILWAY_TOKEN\|Unauthorized\|token\|login\|error decoding response body'; then
    emit_auth_failure "$status_json_output"
  fi
  status_output=""
  run_railway_with_retry status_output status || status_code=$?
  if [ "$status_code" -ne 0 ]; then
    if is_retryable_railway_output "$status_output$status_json_output"; then
      echo "WARN railway status failed with retryable Railway CLI output; trying Railway GraphQL access check" >&2
      EXPECTED_PROJECT="$EXPECTED_PROJECT" EXPECTED_ENVIRONMENT="$EXPECTED_ENVIRONMENT" EXPECTED_SERVICE="$EXPECTED_SERVICE" node scripts/check-railway-graphql-access.mjs
      exit $?
    fi
    if printf '%s' "$status_output" | grep -qi 'Invalid RAILWAY_TOKEN\|Unauthorized\|token\|login\|error decoding response body'; then
      emit_auth_failure "$status_output"
    fi
    echo "FAIL railway status failed" >&2
    printf '%s\n' "$status_output" >&2
    exit 1
  fi
else
  if ! printf '%s' "$status_json_output" | EXPECTED_PROJECT="$EXPECTED_PROJECT" EXPECTED_ENVIRONMENT="$EXPECTED_ENVIRONMENT" EXPECTED_SERVICE="$EXPECTED_SERVICE" node -e '
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const data = JSON.parse(input);
const expectedProject = String(process.env.EXPECTED_PROJECT || "");
const expectedEnvironment = String(process.env.EXPECTED_ENVIRONMENT || "");
const expectedService = String(process.env.EXPECTED_SERVICE || "");
const project = String(data.project?.name || data.name || "");
let environment = String(data.environment?.name || "");
let service = String(data.service?.name || "");
if ((!environment || !service) && Array.isArray(data.environments?.edges)) {
  const envNode = data.environments.edges
    .map((edge) => edge?.node)
    .find((node) => String(node?.name || "") === expectedEnvironment);
  environment = String(envNode?.name || environment || "");
  const serviceNode = envNode?.serviceInstances?.edges
    ?.map((edge) => edge?.node)
    ?.find((node) => String(node?.serviceName || "") === expectedService);
  service = String(serviceNode?.serviceName || service || "");
}
if (!project && expectedProject && Array.isArray(data.services?.edges)) {
  // Current Railway CLI project graph output uses data.name for project name.
  // Keep the services branch above as a guard against future partial outputs.
}
if (!project || !environment || !service) process.exit(1);
console.log(`Project: ${project}`);
console.log(`Environment: ${environment}`);
console.log(`Service: ${service}`);
' >/tmp/smirk-railway-status.txt 2>/dev/null; then
    echo "FAIL railway status --json returned unreadable output" >&2
    printf '%s\n' "$status_json_output" >&2
    exit 1
  fi
  status_output="$(cat /tmp/smirk-railway-status.txt)"
fi

printf '%s\n' "$status_output"

project_line="$(printf '%s\n' "$status_output" | grep '^Project:' || true)"
environment_line="$(printf '%s\n' "$status_output" | grep '^Environment:' || true)"
service_line="$(printf '%s\n' "$status_output" | grep '^Service:' || true)"

if [[ "$project_line" != *"$EXPECTED_PROJECT"* ]] || [[ "$environment_line" != *"$EXPECTED_ENVIRONMENT"* ]] || [[ "$service_line" != *"$EXPECTED_SERVICE"* ]]; then
  echo "FAIL Railway target mismatch" >&2
  echo "Expected Project=$EXPECTED_PROJECT Environment=$EXPECTED_ENVIRONMENT Service=$EXPECTED_SERVICE" >&2
  exit 1
fi

echo "OK Railway CLI auth and target service access verified"
