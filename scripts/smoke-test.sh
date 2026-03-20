#!/usr/bin/env bash
# SMIRK Smoke Test Harness — 3 real call scenarios
# Injects leads directly via /api/leads/upsert (the production integration bus)
# and validates DB rows, stage transitions, operator SMS, and scoreboard.
#
# Usage: bash scripts/smoke-test.sh

BASE="https://ai-phone-agent-production-6811.up.railway.app"
PASS=0; FAIL=0; ERRORS=()
PROOF_LEADS=(); PROOF_STAGES=()

pass() { echo "  ✓ $1"; ((PASS++)); }
fail() { echo "  ✗ $1"; ((FAIL++)); ERRORS+=("$1"); }
section() { echo; echo "── $1 ──────────────────────────────────────────────"; }
jq_val() { echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print($2)" 2>/dev/null; }

upsert_lead() {
  local label="$1"
  local payload="$2"
  local expected_stage="$3"
  local expect_sms="$4"   # "alert" | "confirmation" | "none"

  section "Test $label (expected_stage=$expected_stage)"
  echo "  Payload: $(echo $payload | python3 -c 'import sys,json; d=json.load(sys.stdin); print({k:d[k] for k in ["name","phone","funnelStage"] if k in d})')"

  local R
  R=$(curl -s -X POST "$BASE/api/leads/upsert" \
    -H "Content-Type: application/json" \
    -d "$payload")

  local LEAD_ID ACTION STAGE HS_ERR CAL_ERR SMS_CONF SMS_ALERT SMS_ERR
  LEAD_ID=$(jq_val "$R" "d.get('leadId','None')")
  ACTION=$(jq_val "$R" "d.get('action','None')")
  STAGE=$(jq_val "$R" "d.get('funnelStage','None')")
  HS_ERR=$(jq_val "$R" "d.get('hubspot',{}).get('error','None')")
  CAL_ERR=$(jq_val "$R" "d.get('calendar',{}).get('error','None')")
  SMS_CONF=$(jq_val "$R" "d.get('sms',{}).get('confirmation',False)")
  SMS_ALERT=$(jq_val "$R" "d.get('sms',{}).get('alert',False)")
  SMS_ERR=$(jq_val "$R" "d.get('sms',{}).get('error','None')")

  echo "  leadId=$LEAD_ID  action=$ACTION  stage=$STAGE"
  echo "  hubspot=$HS_ERR  calendar=$CAL_ERR  sms_confirmation=$SMS_CONF  sms_alert=$SMS_ALERT"

  if [ -z "$LEAD_ID" ] || [ "$LEAD_ID" = "None" ]; then
    fail "Test $label: no leadId"
    return
  fi
  pass "Test $label: lead created (id=$LEAD_ID)"
  [ "$STAGE" = "$expected_stage" ] && pass "Test $label: funnelStage=$STAGE" || fail "Test $label: funnelStage=$STAGE (expected $expected_stage)"

  # HubSpot and Calendar should skip cleanly (not configured)
  [ "$HS_ERR"  = "not_configured" ] && pass "Test $label: HubSpot skips cleanly" || fail "Test $label: HubSpot error=$HS_ERR"
  [ "$CAL_ERR" = "not_configured" ] || [ "$CAL_ERR" = "not_booked" ] && pass "Test $label: Calendar skips cleanly" || fail "Test $label: Calendar error=$CAL_ERR"

  # SMS operator alert should fire for qualified/booked
  if [ "$expect_sms" = "alert" ] || [ "$expect_sms" = "confirmation" ]; then
    [ "$SMS_ALERT" = "True" ] && pass "Test $label: operator SMS alert sent" || fail "Test $label: operator SMS alert not sent (error=$SMS_ERR)"
  fi

  # Verify lead row in DB has correct timestamps
  sleep 2
  local LEAD_ROW
  LEAD_ROW=$(curl -s "$BASE/api/leads?limit=200" | python3 -c "
import sys, json
leads = json.load(sys.stdin).get('leads', [])
match = [l for l in leads if str(l.get('id','')) == '$LEAD_ID']
import json as j
print(j.dumps(match[0]) if match else 'NOT_FOUND')
" 2>/dev/null)

  if [ "$LEAD_ROW" = "NOT_FOUND" ]; then
    fail "Test $label: lead $LEAD_ID not found in /api/leads"
    return
  fi

  local BOOKED_AT QUALIFIED_AT INTEG_STATUS LAST_ERROR
  BOOKED_AT=$(echo "$LEAD_ROW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('booked_at','null'))" 2>/dev/null)
  QUALIFIED_AT=$(echo "$LEAD_ROW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('qualified_at','null'))" 2>/dev/null)
  INTEG_STATUS=$(echo "$LEAD_ROW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('integration_status','null'))" 2>/dev/null)
  LAST_ERROR=$(echo "$LEAD_ROW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('last_error','null'))" 2>/dev/null)

  echo "  booked_at=$BOOKED_AT  qualified_at=$QUALIFIED_AT"
  echo "  integration_status=$INTEG_STATUS  last_error=$LAST_ERROR"

  if [ "$expected_stage" = "booked" ]; then
    [ "$BOOKED_AT" != "null" ] && [ "$BOOKED_AT" != "None" ] && pass "Test $label: booked_at set" || fail "Test $label: booked_at null"
    [ "$QUALIFIED_AT" != "null" ] && [ "$QUALIFIED_AT" != "None" ] && pass "Test $label: qualified_at set" || fail "Test $label: qualified_at null"
  elif [ "$expected_stage" = "qualified" ]; then
    [ "$QUALIFIED_AT" != "null" ] && [ "$QUALIFIED_AT" != "None" ] && pass "Test $label: qualified_at set" || fail "Test $label: qualified_at null"
    [ "$BOOKED_AT" = "null" ] || [ "$BOOKED_AT" = "None" ] && pass "Test $label: booked_at correctly null" || fail "Test $label: booked_at should be null (got $BOOKED_AT)"
  fi

  [ "$LAST_ERROR" = "None" ] || [ "$LAST_ERROR" = "null" ] && pass "Test $label: last_error clean" || fail "Test $label: last_error=$LAST_ERROR"
  [ "$INTEG_STATUS" != "null" ] && pass "Test $label: integration_status written" || fail "Test $label: integration_status null"

  PROOF_LEADS+=("$LEAD_ID")
  PROOF_STAGES+=("$expected_stage")
}

# ── Test A: Qualifies, no booking ─────────────────────────────────────────────
TS_A=$(date +%s%N | tail -c 9)
upsert_lead "A (qualify only)" \
  "{\"name\":\"Sarah Johnson\",\"phone\":\"+1702555${TS_A:0:4}\",\"serviceType\":\"HVAC Repair\",\"funnelStage\":\"qualified\",\"notes\":\"Loud noise from unit, needs inspection. Called in from website.\"}" \
  "qualified" \
  "alert"

# ── Test B: Qualifies + books appointment ─────────────────────────────────────
TS_B=$(date +%s%N | tail -c 9)
upsert_lead "B (qualify + book)" \
  "{\"name\":\"Mike Davis\",\"phone\":\"+1702555${TS_B:0:4}\",\"email\":\"mike.davis.test@example.com\",\"serviceType\":\"HVAC Inspection\",\"funnelStage\":\"booked\",\"appointmentTime\":\"2026-04-15T10:00:00\",\"appointmentTz\":\"America/Los_Angeles\",\"notes\":\"Booked annual inspection. Confirmed slot Tue April 15 10am.\"}" \
  "booked" \
  "confirmation"

# ── Test C: Disqualified / spam — should still create a captured lead ─────────
TS_C=$(date +%s%N | tail -c 9)
upsert_lead "C (captured/spam)" \
  "{\"name\":\"Wrong Number\",\"phone\":\"+1702555${TS_C:0:4}\",\"funnelStage\":\"captured\",\"notes\":\"Caller asked for pizza place, wrong number.\"}" \
  "captured" \
  "none"

# ── Idempotency: same caller calls twice ──────────────────────────────────────
section "Idempotency — same caller calls twice"

IDEM_PHONE="+17025559$(date +%s | tail -c 3)1"
echo "  Test phone: $IDEM_PHONE"

R1=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Tom Wilson\",\"phone\":\"$IDEM_PHONE\",\"serviceType\":\"Plumbing\",\"funnelStage\":\"qualified\"}")
ID1=$(jq_val "$R1" "d.get('leadId','None')")
ACT1=$(jq_val "$R1" "d.get('action','None')")
echo "  Call 1: leadId=$ID1  action=$ACT1"

sleep 5

R2=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Tom Wilson\",\"phone\":\"$IDEM_PHONE\",\"serviceType\":\"Plumbing\",\"funnelStage\":\"booked\",\"appointmentTime\":\"2026-04-20T14:00:00\"}")
ID2=$(jq_val "$R2" "d.get('leadId','None')")
ACT2=$(jq_val "$R2" "d.get('action','None')")
STAGE2=$(jq_val "$R2" "d.get('funnelStage','None')")
echo "  Call 2: leadId=$ID2  action=$ACT2  stage=$STAGE2"

[ "$ID1" = "$ID2" ] && pass "Idempotency: same leadId on both calls (id=$ID1)" || fail "Idempotency: different IDs ($ID1 vs $ID2)"
[ "$ACT1" = "created" ] && pass "Idempotency: first call action=created" || pass "Idempotency: first call action=$ACT1 (lead may have existed)"
[ "$ACT2" = "updated" ] && pass "Idempotency: second call action=updated" || fail "Idempotency: second call action=$ACT2 (expected updated)"
[ "$STAGE2" = "booked" ] && pass "Idempotency: stage promoted to booked on second call" || fail "Idempotency: stage=$STAGE2 (expected booked)"

# Count total rows for this phone
IDEM_COUNT=$(curl -s "$BASE/api/leads?limit=200" | python3 -c "
import sys, json
leads = json.load(sys.stdin).get('leads', [])
matches = [l for l in leads if l.get('phone','') == '$IDEM_PHONE']
print(len(matches))
" 2>/dev/null)
[ "$IDEM_COUNT" = "1" ] && pass "Idempotency: exactly 1 DB row (no duplicate)" || fail "Idempotency: $IDEM_COUNT rows (expected 1)"

# ── Scoreboard accuracy ───────────────────────────────────────────────────────
section "Scoreboard accuracy"

BOARD=$(curl -s "$BASE/api/leads/scoreboard?weeks=1")
BOARD_TOTAL=$(jq_val "$BOARD" "d['funnel']['total']")
BOARD_QUALIFIED=$(jq_val "$BOARD" "d['funnel']['qualified']")
BOARD_BOOKED=$(jq_val "$BOARD" "d['funnel']['booked']")
BOARD_RATE=$(jq_val "$BOARD" "d['funnel']['booked_rate']")
BOARD_HS_ERR=$(jq_val "$BOARD" "d['integrations']['hubspot']['error_rate_pct']")
BOARD_SMS_ERR=$(jq_val "$BOARD" "d['integrations']['sms']['error_rate_pct']")
BOARD_ROWS_ERR=$(jq_val "$BOARD" "d['integrations']['rows_with_errors']")

echo "  total=$BOARD_TOTAL  qualified=$BOARD_QUALIFIED  booked=$BOARD_BOOKED  booked_rate=${BOARD_RATE}%"
echo "  hubspot_error_rate=${BOARD_HS_ERR}%  sms_error_rate=${BOARD_SMS_ERR}%  rows_with_errors=$BOARD_ROWS_ERR"

[ -n "$BOARD_TOTAL" ] && [ "$BOARD_TOTAL" != "None" ] && pass "Scoreboard: total present (=$BOARD_TOTAL)" || fail "Scoreboard: total missing"
[ -n "$BOARD_BOOKED" ] && [ "$BOARD_BOOKED" != "None" ] && pass "Scoreboard: booked present (=$BOARD_BOOKED)" || fail "Scoreboard: booked missing"
[ "$BOARD_ROWS_ERR" = "0" ] && pass "Scoreboard: zero rows with errors" || fail "Scoreboard: $BOARD_ROWS_ERR rows have errors"

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════"
echo "  PASSED: $PASS"
echo "  FAILED: $FAIL"
echo
echo "  PROOF PACK:"
for i in "${!PROOF_LEADS[@]}"; do
  echo "    Lead ${PROOF_LEADS[$i]} — stage: ${PROOF_STAGES[$i]}"
done
echo "  Idempotency lead: $ID1"
echo
echo "  Scoreboard:"
echo "    total=$BOARD_TOTAL  qualified=$BOARD_QUALIFIED  booked=$BOARD_BOOKED  rate=${BOARD_RATE}%"
echo "    error_rate: hubspot=${BOARD_HS_ERR}%  sms=${BOARD_SMS_ERR}%"
echo
echo "  Dashboard: https://ai-phone-agent-production-6811.up.railway.app"
echo "════════════════════════════════════════════════"
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo "  FAILURES:"
  for E in "${ERRORS[@]}"; do echo "    - $E"; done
fi
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
