#!/usr/bin/env bash
# Acceptance tests for the SMIRK leads core (Commit 3+)
# Runs against: https://ai-phone-agent-production-6811.up.railway.app
# Exit code: 0 = all passed, 1 = at least one failed

BASE="https://ai-phone-agent-production-6811.up.railway.app"
PASS=0
FAIL=0
ERRORS=()

# Use a timestamp-based suffix so each run uses fresh phones
TS=$(date +%s | tail -c 5)
PHONE_IDEM="+1775${TS}0001"
PHONE_TS="+1775${TS}0002"

pass() { echo "  ✓ $1"; ((PASS++)); }
fail() { echo "  ✗ $1"; ((FAIL++)); ERRORS+=("$1"); }
section() { echo; echo "── $1 ──────────────────────────────────────────────"; }

jq_val() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print($2)" 2>/dev/null
}

get_lead_field() {
  local LEAD_ID="$1"
  local FIELD="$2"
  curl -s "$BASE/api/leads?limit=200" | python3 -c "
import sys, json
leads = json.load(sys.stdin).get('leads', [])
match = [l for l in leads if str(l.get('id','')) == '$LEAD_ID']
if match:
    val = match[0].get('$FIELD')
    print(val if val is not None else 'NULL')
else:
    print('NOT_FOUND')
" 2>/dev/null
}

# ── ACCEPTANCE CHECK 1: Idempotency ──────────────────────────────────────────
section "AC-1: Same phone twice → update, not duplicate"

R1=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Idempotency Test\",\"phone\":\"$PHONE_IDEM\",\"serviceType\":\"HVAC\",\"funnelStage\":\"qualified\"}")

R2=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Idempotency Test\",\"phone\":\"$PHONE_IDEM\",\"serviceType\":\"HVAC\",\"funnelStage\":\"qualified\"}")

ID1=$(jq_val "$R1" "d['leadId']")
ID2=$(jq_val "$R2" "d['leadId']")
ACT1=$(jq_val "$R1" "d['action']")
ACT2=$(jq_val "$R2" "d['action']")

echo "  Call 1: leadId=$ID1 action=$ACT1"
echo "  Call 2: leadId=$ID2 action=$ACT2"

if [ "$ID1" = "$ID2" ] && [ -n "$ID1" ] && [ "$ID1" != "None" ]; then
  pass "Same leadId returned both times ($ID1)"
else
  fail "Different leadIds: $ID1 vs $ID2"
fi

if [ "$ACT1" = "created" ]; then
  pass "First call returned action=created"
else
  fail "First call action was '$ACT1', expected 'created'"
fi

if [ "$ACT2" = "updated" ]; then
  pass "Second call returned action=updated"
else
  fail "Second call action was '$ACT2', expected 'updated'"
fi

# ── ACCEPTANCE CHECK 2: Validation — missing required fields ──────────────────
section "AC-2: Missing required fields → 400 with explicit errors"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d '{"name":"No Contact"}')
[ "$HTTP" = "400" ] && pass "No phone/email → HTTP 400" || fail "No phone/email → HTTP $HTTP (expected 400)"

BODY=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d '{"name":"No Contact"}')
echo "  Error body: $BODY"
echo "$BODY" | grep -qi "phone\|email" && pass "Error message mentions phone/email" || fail "Error message does not mention phone or email"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d '{"phone":"abc","name":"Bad Phone"}')
[ "$HTTP" = "400" ] && pass "Bad phone format → HTTP 400" || fail "Bad phone format → HTTP $HTTP (expected 400)"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"+1775${TS}0099\",\"funnelStage\":\"ready_to_buy\"}")
[ "$HTTP" = "400" ] && pass "Invalid funnelStage → HTTP 400" || fail "Invalid funnelStage → HTTP $HTTP (expected 400)"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"+1775${TS}0098\",\"appointmentTime\":\"not-a-date\"}")
[ "$HTTP" = "400" ] && pass "Bad appointmentTime → HTTP 400" || fail "Bad appointmentTime → HTTP $HTTP (expected 400)"

# ── ACCEPTANCE CHECK 3: Timestamps ───────────────────────────────────────────
section "AC-3: Funnel stage transitions set timestamps correctly"

# 3a: Create at qualified → qualified_at set, booked_at NULL
R=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Timestamp Test\",\"phone\":\"$PHONE_TS\",\"serviceType\":\"Plumbing\",\"funnelStage\":\"qualified\"}")
LEAD_ID=$(jq_val "$R" "d['leadId']")
ACT=$(jq_val "$R" "d['action']")
echo "  Created lead $LEAD_ID (action=$ACT) at stage=qualified"

sleep 1  # small delay to ensure DB write is visible

QA=$(get_lead_field "$LEAD_ID" "qualified_at")
BA=$(get_lead_field "$LEAD_ID" "booked_at")
echo "  qualified_at=$QA  booked_at=$BA"

if [ "$QA" != "NULL" ] && [ "$QA" != "NOT_FOUND" ] && [ -n "$QA" ]; then
  pass "qualified_at is set for stage=qualified"
else
  fail "qualified_at is NULL for stage=qualified (got '$QA')"
fi

if [ "$BA" = "NULL" ] || [ -z "$BA" ]; then
  pass "booked_at is NULL for stage=qualified (correct)"
else
  fail "booked_at should be NULL for stage=qualified (got '$BA')"
fi

# 3b: Promote to booked → booked_at set, qualified_at preserved
R2=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Timestamp Test\",\"phone\":\"$PHONE_TS\",\"funnelStage\":\"booked\",\"appointmentTime\":\"2026-04-01T10:00:00\",\"appointmentTz\":\"America/Los_Angeles\"}")
STAGE2=$(jq_val "$R2" "d['funnelStage']")
echo "  Promoted to booked: $STAGE2"

sleep 1

BA2=$(get_lead_field "$LEAD_ID" "booked_at")
QA2=$(get_lead_field "$LEAD_ID" "qualified_at")
echo "  After booked: qualified_at=$QA2  booked_at=$BA2"

if [ "$BA2" != "NULL" ] && [ "$BA2" != "NOT_FOUND" ] && [ -n "$BA2" ]; then
  pass "booked_at is set after stage=booked"
else
  fail "booked_at is NULL after stage=booked (got '$BA2')"
fi

if [ "$QA2" != "NULL" ] && [ "$QA2" != "NOT_FOUND" ] && [ -n "$QA2" ]; then
  pass "qualified_at preserved after booked promotion"
else
  fail "qualified_at was cleared after booked promotion (got '$QA2')"
fi

# 3c: Attempt downgrade booked → qualified → should stay booked
R3=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Timestamp Test\",\"phone\":\"$PHONE_TS\",\"funnelStage\":\"qualified\"}")
STAGE3=$(jq_val "$R3" "d['funnelStage']")
echo "  Attempted downgrade to qualified, got: $STAGE3"
if [ "$STAGE3" = "booked" ]; then
  pass "Stage cannot go backwards (booked stays booked)"
else
  fail "Stage went backwards from booked to '$STAGE3'"
fi

# ── ACCEPTANCE CHECK 4: KPI funnel counts ────────────────────────────────────
section "AC-4: KPI funnel returns stable, correct counts"

FUNNEL=$(curl -s "$BASE/api/leads/funnel")
echo "  Raw funnel response:"
echo "$FUNNEL" | python3 -m json.tool 2>/dev/null | grep -E 'captured|qualified|booked|follow_up|total|rate'

for KEY in captured qualified booked follow_up_due total captured_rate qualified_rate booked_rate; do
  VAL=$(jq_val "$FUNNEL" "d['funnel']['$KEY']")
  if [ -n "$VAL" ] && [ "$VAL" != "None" ]; then
    pass "funnel.$KEY is present (=$VAL)"
  else
    fail "funnel.$KEY is missing or null"
  fi
done

for KEY in hubspot calendar sms operator_alert; do
  VAL=$(jq_val "$FUNNEL" "d['integrations']['$KEY']['configured']")
  [ -n "$VAL" ] && pass "integrations.$KEY.configured is present (=$VAL)" || fail "integrations.$KEY.configured is missing"
done

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
