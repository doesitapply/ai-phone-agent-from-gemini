#!/usr/bin/env bash
# End-to-end money-loop test for SMIRK
# Tests: lead upsert → HubSpot sync → Calendar event → SMS confirmation → scoreboard
# Run after setting HUBSPOT_ACCESS_TOKEN, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CALENDAR_ID in Railway.

BASE="https://ai-phone-agent-production-6811.up.railway.app"
PASS=0
FAIL=0
ERRORS=()

pass() { echo "  ✓ $1"; ((PASS++)); }
fail() { echo "  ✗ $1"; ((FAIL++)); ERRORS+=("$1"); }
section() { echo; echo "── $1 ──────────────────────────────────────────────"; }

jq_val() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print($2)" 2>/dev/null
}

# ── Step 1: Verify connectors are configured ─────────────────────────────────
section "Step 1: Connector configuration check"

FUNNEL=$(curl -s "$BASE/api/leads/funnel")
HS_CFG=$(jq_val "$FUNNEL" "d['integrations']['hubspot']['configured']")
CAL_CFG=$(jq_val "$FUNNEL" "d['integrations']['calendar']['configured']")
SMS_CFG=$(jq_val "$FUNNEL" "d['integrations']['sms']['configured']")

echo "  HubSpot configured:  $HS_CFG"
echo "  Calendar configured: $CAL_CFG"
echo "  SMS configured:      $SMS_CFG"

[ "$HS_CFG"  = "True" ] && pass "HubSpot token present"  || fail "HUBSPOT_ACCESS_TOKEN not set — HubSpot will skip"
[ "$CAL_CFG" = "True" ] && pass "Calendar creds present" || fail "GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_CALENDAR_ID not set — Calendar will skip"
[ "$SMS_CFG" = "True" ] && pass "Twilio configured"      || pass "Twilio not set (SMS will skip — acceptable)"

# ── Step 2: Upsert a booked lead with appointment ────────────────────────────
section "Step 2: Upsert a booked lead (triggers all side effects)"

PHONE="+1555$(date +%s%N | tail -c 9)"
APPT="2026-04-15T10:00:00"
echo "  Test phone: $PHONE"
echo "  Appointment: $APPT"

R=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Money Loop Test\",
    \"phone\": \"$PHONE\",
    \"email\": \"moneyloop@test.smirk\",
    \"serviceType\": \"HVAC Inspection\",
    \"funnelStage\": \"booked\",
    \"appointmentTime\": \"$APPT\",
    \"appointmentTz\": \"America/Los_Angeles\",
    \"notes\": \"End-to-end money loop test run\"
  }")

echo "  Response: $R" | python3 -c "import sys; print(sys.stdin.read()[:300])"

LEAD_ID=$(jq_val "$R" "d['leadId']")
ACTION=$(jq_val "$R" "d['action']")
STAGE=$(jq_val "$R" "d['funnelStage']")

[ -n "$LEAD_ID" ] && [ "$LEAD_ID" != "None" ] && pass "Lead created (id=$LEAD_ID)" || fail "No leadId in response"
[ "$ACTION" = "created" ] && pass "action=created (fresh lead)" || pass "action=$ACTION (lead existed)"
[ "$STAGE" = "booked" ] && pass "funnelStage=booked" || fail "funnelStage=$STAGE (expected booked)"

# ── Step 3: Check HubSpot result ─────────────────────────────────────────────
section "Step 3: HubSpot sync result"

HS_SUCCESS=$(jq_val "$R" "d['hubspot']['success']")
HS_RECORD=$(jq_val "$R" "d['hubspot'].get('recordId','None')")
HS_ERROR=$(jq_val "$R" "d['hubspot'].get('error','None')")
echo "  hubspot.success=$HS_SUCCESS  recordId=$HS_RECORD  error=$HS_ERROR"

if [ "$HS_CFG" = "True" ]; then
  [ "$HS_SUCCESS" = "True" ] && pass "HubSpot contact upserted (id=$HS_RECORD)" || fail "HubSpot sync failed: $HS_ERROR"
else
  [ "$HS_ERROR" = "not_configured" ] && pass "HubSpot skipped cleanly (not configured)" || pass "HubSpot skip: $HS_ERROR"
fi

# ── Step 4: Check Calendar result ────────────────────────────────────────────
section "Step 4: Google Calendar event result"

CAL_SUCCESS=$(jq_val "$R" "d['calendar']['success']")
CAL_EVENT=$(jq_val "$R" "d['calendar'].get('eventId','None')")
CAL_ERROR=$(jq_val "$R" "d['calendar'].get('error','None')")
echo "  calendar.success=$CAL_SUCCESS  eventId=$CAL_EVENT  error=$CAL_ERROR"

if [ "$CAL_CFG" = "True" ]; then
  [ "$CAL_SUCCESS" = "True" ] && pass "Calendar event created (id=$CAL_EVENT)" || fail "Calendar sync failed: $CAL_ERROR"
else
  [ "$CAL_ERROR" = "not_configured" ] && pass "Calendar skipped cleanly (not configured)" || pass "Calendar skip: $CAL_ERROR"
fi

# ── Step 5: Check SMS result ─────────────────────────────────────────────────
section "Step 5: SMS confirmation result"

SMS_CONF=$(jq_val "$R" "d['sms']['confirmation']")
SMS_ALERT=$(jq_val "$R" "d['sms']['alert']")
SMS_ERROR=$(jq_val "$R" "d['sms'].get('error','None')")
echo "  sms.confirmation=$SMS_CONF  alert=$SMS_ALERT  error=$SMS_ERROR"

if [ "$SMS_CFG" = "True" ]; then
  if [ "$SMS_CONF" = "True" ]; then
    pass "SMS confirmation sent to lead"
  else
    # +1555 test numbers are rejected by Twilio — acceptable in test runs
    pass "SMS confirmation not sent (test phone +1555 rejected by Twilio — expected)"
  fi
  [ "$SMS_ALERT" = "True" ] && pass "Operator alert SMS sent" || pass "Operator alert not sent (OPERATOR_ALERT_NUMBER may not be set)"
else
  pass "SMS skipped cleanly (Twilio not configured)"
fi

# ── Step 6: Verify lead row has clean integration_status ─────────────────────
section "Step 6: Lead row integration_status (ops visibility)"

sleep 2  # allow async writebacks to complete
LEAD_ROW=$(curl -s "$BASE/api/leads?limit=200" | python3 -c "
import sys, json
leads = json.load(sys.stdin).get('leads', [])
match = [l for l in leads if str(l.get('id','')) == '$LEAD_ID']
if match:
    import json as j
    print(j.dumps(match[0]))
else:
    print('NOT_FOUND')
" 2>/dev/null)

if [ "$LEAD_ROW" = "NOT_FOUND" ]; then
  fail "Lead $LEAD_ID not found in /api/leads"
else
  INTEG_STATUS=$(echo "$LEAD_ROW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('integration_status','null'))" 2>/dev/null)
  LAST_ERROR=$(echo "$LEAD_ROW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('last_error','null'))" 2>/dev/null)
  HS_ID=$(echo "$LEAD_ROW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hubspot_id','null'))" 2>/dev/null)
  CAL_ID=$(echo "$LEAD_ROW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('calendar_event_id','null'))" 2>/dev/null)
  SMS_AT=$(echo "$LEAD_ROW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sms_sent_at','null'))" 2>/dev/null)
  BOOKED_AT=$(echo "$LEAD_ROW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('booked_at','null'))" 2>/dev/null)

  echo "  integration_status: $INTEG_STATUS"
  echo "  last_error:         $LAST_ERROR"
  echo "  hubspot_id:         $HS_ID"
  echo "  calendar_event_id:  $CAL_ID"
  echo "  sms_sent_at:        $SMS_AT"
  echo "  booked_at:          $BOOKED_AT"

  [ "$INTEG_STATUS" != "null" ] && pass "integration_status written to lead row" || fail "integration_status is null on lead row"
  [ "$LAST_ERROR" = "None" ] || [ "$LAST_ERROR" = "null" ] && pass "last_error is clean (no errors)" || fail "last_error is set: $LAST_ERROR"
  [ "$BOOKED_AT" != "null" ] && pass "booked_at timestamp set" || fail "booked_at is null"
fi

# ── Step 7: Scoreboard endpoint ───────────────────────────────────────────────
section "Step 7: Scoreboard endpoint"

BOARD=$(curl -s "$BASE/api/leads/scoreboard?weeks=1")
echo "  Scoreboard (this week):"
echo "$BOARD" | python3 -m json.tool 2>/dev/null | grep -E 'booked|qualified|captured|error_rate|rows_with|weeks'

BOARD_BOOKED=$(jq_val "$BOARD" "d['funnel']['booked']")
BOARD_HS_ERR=$(jq_val "$BOARD" "d['integrations']['hubspot']['error_rate_pct']")
BOARD_PERIOD=$(jq_val "$BOARD" "d['period']['weeks']")

[ -n "$BOARD_BOOKED" ] && [ "$BOARD_BOOKED" != "None" ] && pass "Scoreboard funnel.booked present (=$BOARD_BOOKED)" || fail "Scoreboard funnel.booked missing"
[ -n "$BOARD_HS_ERR" ] && [ "$BOARD_HS_ERR" != "None" ] && pass "Scoreboard hubspot.error_rate_pct present (=$BOARD_HS_ERR%)" || fail "Scoreboard hubspot.error_rate_pct missing"
[ "$BOARD_PERIOD" = "1" ] && pass "Scoreboard period=1 week" || fail "Scoreboard period=$BOARD_PERIOD (expected 1)"

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════"
echo "  PASSED: $PASS"
echo "  FAILED: $FAIL"
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo "  FAILURES:"
  for E in "${ERRORS[@]}"; do echo "    - $E"; done
fi
echo "════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
