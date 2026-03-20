#!/usr/bin/env bash
# Acceptance tests for the SMIRK leads core (Commit 3)
# Runs against: https://ai-phone-agent-production-6811.up.railway.app
# Exit code: 0 = all passed, 1 = at least one failed

BASE="https://ai-phone-agent-production-6811.up.railway.app"
PASS=0
FAIL=0
ERRORS=()

# ── helpers ───────────────────────────────────────────────────────────────────
pass() { echo "  ✓ $1"; ((PASS++)); }
fail() { echo "  ✗ $1"; ((FAIL++)); ERRORS+=("$1"); }
section() { echo; echo "── $1 ──────────────────────────────────────────────"; }

jq_val() { echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print($2)" 2>/dev/null; }

# ── ACCEPTANCE CHECK 1: Idempotency ──────────────────────────────────────────
section "AC-1: Same phone twice → update, not duplicate"

PHONE="+17750000099"

R1=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Idempotency Test\",\"phone\":\"$PHONE\",\"serviceType\":\"HVAC\",\"funnelStage\":\"qualified\"}")

R2=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Idempotency Test\",\"phone\":\"$PHONE\",\"serviceType\":\"HVAC\",\"funnelStage\":\"qualified\"}")

ID1=$(jq_val "$R1" "d['leadId']")
ID2=$(jq_val "$R2" "d['leadId']")
ACT1=$(jq_val "$R1" "d['action']")
ACT2=$(jq_val "$R2" "d['action']")

echo "  Call 1: leadId=$ID1 action=$ACT1"
echo "  Call 2: leadId=$ID2 action=$ACT2"

[ "$ID1" = "$ID2" ] && pass "Same leadId returned both times ($ID1)" || fail "Different leadIds: $ID1 vs $ID2"
[ "$ACT2" = "updated" ] && pass "Second call returned action=updated" || fail "Second call action was '$ACT2', expected 'updated'"

# Count rows for this phone
COUNT=$(curl -s "$BASE/api/leads/funnel" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['funnel']['total'])" 2>/dev/null)
echo "  Total leads in DB: $COUNT"

# ── ACCEPTANCE CHECK 2: Validation — missing required fields ──────────────────
section "AC-2: Missing required fields → 400 with explicit errors"

# 2a: No phone or email
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d '{"name":"No Contact"}')
[ "$R" = "400" ] && pass "No phone/email → HTTP 400" || fail "No phone/email → HTTP $R (expected 400)"

BODY=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d '{"name":"No Contact"}')
echo "  Error body: $BODY"
echo "$BODY" | grep -qi "phone\|email" && pass "Error message mentions phone/email" || fail "Error message does not mention phone or email"

# 2b: Bad phone format
R=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d '{"phone":"abc","name":"Bad Phone"}')
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d '{"phone":"abc","name":"Bad Phone"}')
[ "$HTTP" = "400" ] && pass "Bad phone format → HTTP 400" || fail "Bad phone format → HTTP $HTTP (expected 400)"
echo "  Error body: $R"

# 2c: Bad funnel stage
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+17750000098","funnelStage":"ready_to_buy"}')
[ "$HTTP" = "400" ] && pass "Invalid funnelStage → HTTP 400" || fail "Invalid funnelStage → HTTP $HTTP (expected 400)"

# 2d: Bad appointment time
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+17750000097","appointmentTime":"not-a-date"}')
[ "$HTTP" = "400" ] && pass "Bad appointmentTime → HTTP 400" || fail "Bad appointmentTime → HTTP $HTTP (expected 400)"

# ── ACCEPTANCE CHECK 3: Timestamps ───────────────────────────────────────────
section "AC-3: Funnel stage transitions set timestamps correctly"

TS_PHONE="+17750000096"

# 3a: qualified → qualified_at set
R=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Timestamp Test\",\"phone\":\"$TS_PHONE\",\"serviceType\":\"Plumbing\",\"funnelStage\":\"qualified\"}")
LEAD_ID=$(jq_val "$R" "d['leadId']")
echo "  Created lead $LEAD_ID at stage=qualified"

# Fetch the lead row to check timestamps
ROW=$(curl -s "$BASE/api/leads?limit=200" | python3 -c "
import sys,json
leads = json.load(sys.stdin).get('leads',[])
match = [l for l in leads if str(l.get('id','')) == '$LEAD_ID']
if match: print(json.dumps(match[0]))
else: print('{}')
" 2>/dev/null)

QA=$(jq_val "$ROW" "d.get('qualified_at','MISSING')")
BA=$(jq_val "$ROW" "d.get('booked_at','MISSING')")
echo "  qualified_at=$QA  booked_at=$BA"

[ "$QA" != "None" ] && [ "$QA" != "MISSING" ] && [ -n "$QA" ] \
  && pass "qualified_at is set for stage=qualified" \
  || fail "qualified_at is NULL for stage=qualified (got '$QA')"

[ "$BA" = "None" ] || [ "$BA" = "MISSING" ] || [ -z "$BA" ] \
  && pass "booked_at is NULL for stage=qualified (correct)" \
  || fail "booked_at should be NULL for stage=qualified (got '$BA')"

# 3b: Promote to booked → booked_at set
R2=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Timestamp Test\",\"phone\":\"$TS_PHONE\",\"funnelStage\":\"booked\",\"appointmentTime\":\"2026-04-01T10:00:00\",\"appointmentTz\":\"America/Los_Angeles\"}")
echo "  Promoted to booked: $(jq_val "$R2" "d['funnelStage']")"

ROW2=$(curl -s "$BASE/api/leads?limit=200" | python3 -c "
import sys,json
leads = json.load(sys.stdin).get('leads',[])
match = [l for l in leads if str(l.get('id','')) == '$LEAD_ID']
if match: print(json.dumps(match[0]))
else: print('{}')
" 2>/dev/null)

BA2=$(jq_val "$ROW2" "d.get('booked_at','MISSING')")
QA2=$(jq_val "$ROW2" "d.get('qualified_at','MISSING')")
echo "  After booked: qualified_at=$QA2  booked_at=$BA2"

[ "$BA2" != "None" ] && [ "$BA2" != "MISSING" ] && [ -n "$BA2" ] \
  && pass "booked_at is set after stage=booked" \
  || fail "booked_at is NULL after stage=booked (got '$BA2')"

[ "$QA2" != "None" ] && [ "$QA2" != "MISSING" ] && [ -n "$QA2" ] \
  && pass "qualified_at preserved after booked promotion" \
  || fail "qualified_at was cleared after booked promotion (got '$QA2')"

# 3c: Verify stage cannot go backwards (booked → qualified should stay booked)
R3=$(curl -s -X POST "$BASE/api/leads/upsert" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Timestamp Test\",\"phone\":\"$TS_PHONE\",\"funnelStage\":\"qualified\"}")
STAGE3=$(jq_val "$R3" "d['funnelStage']")
echo "  Attempted downgrade to qualified, got: $STAGE3"
[ "$STAGE3" = "booked" ] \
  && pass "Stage cannot go backwards (booked stays booked)" \
  || fail "Stage went backwards from booked to $STAGE3"

# ── ACCEPTANCE CHECK 4: KPI funnel counts ────────────────────────────────────
section "AC-4: KPI funnel returns stable, correct counts"

FUNNEL=$(curl -s "$BASE/api/leads/funnel")
echo "  Raw funnel response:"
echo "$FUNNEL" | python3 -m json.tool 2>/dev/null | grep -E 'captured|qualified|booked|follow_up|total|rate'

# Verify all expected keys are present
for KEY in captured qualified booked follow_up_due total captured_rate qualified_rate booked_rate; do
  VAL=$(jq_val "$FUNNEL" "d['funnel']['$KEY']")
  [ -n "$VAL" ] && [ "$VAL" != "None" ] \
    && pass "funnel.$KEY is present (=$VAL)" \
    || fail "funnel.$KEY is missing or null"
done

# Verify integrations block is present
for KEY in hubspot calendar sms operator_alert; do
  VAL=$(jq_val "$FUNNEL" "d['integrations']['$KEY']['configured']")
  [ -n "$VAL" ] \
    && pass "integrations.$KEY.configured is present (=$VAL)" \
    || fail "integrations.$KEY.configured is missing"
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
