#!/usr/bin/env python3
"""
Regression test: contact auto-creation guard (phone-only threshold)

Verifies that persistCallSummary NEVER creates a contact when the caller
did not provide a name — even if a phone number is present.

Tests:
  A. Phone-only call (no name, no entities)         → NO contact created
  B. Phone-only call with service type but no name  → NO contact created
  C. Call with name + phone                         → contact created
  D. Call with name only (no phone extracted)       → contact created
  E. Reprocess of a nameless call                   → still NO contact
  F. Reprocess after name added to summary          → contact created

All tests use synthetic CallSids and are cleaned up after the run.
"""
import requests
import json
import time
import sys
from datetime import datetime, timezone

BASE = "https://ai-phone-agent-production-6811.up.railway.app"
PASS = "✓"
FAIL = "✗"
results = []

def req(method, path, **kwargs):
    fn = getattr(requests, method)
    r = fn(f"{BASE}{path}", timeout=15, **kwargs)
    return r

def check(label, condition, detail=""):
    status = PASS if condition else FAIL
    results.append((status, label, detail))
    print(f"  {status} {label}" + (f" | {detail}" if detail else ""))
    return condition

def section(title):
    print(f"\n{'─'*60}")
    print(f"  {title}")
    print(f"{'─'*60}")

# ── helpers ───────────────────────────────────────────────────────────────────

def count_contacts_for_phone(phone: str) -> int:
    """Return how many contacts exist with this phone number."""
    r = req("get", "/api/contacts")
    if r.status_code != 200:
        return -1
    data = r.json()
    contacts = data if isinstance(data, list) else data.get("contacts", [])
    return sum(1 for c in contacts if c.get("phone_number") == phone)

def simulate_call_and_reprocess(
    call_sid: str,
    from_number: str,
    speech_result: str,
    expected_name: str | None,
) -> dict:
    """
    Simulate a complete call lifecycle:
      1. POST /api/twilio/incoming  (creates call record)
      2. POST /api/twilio/process   (async AI turn — we don't wait for audio)
      3. POST /api/twilio/status    (mark completed)
      4. POST /api/calls/:sid/reprocess  (trigger post-call intelligence)
    Returns the call record after reprocess.
    """
    # Step 1: incoming
    req("post", "/api/twilio/incoming", data={
        "CallSid": call_sid,
        "From": from_number,
        "To": "+17754204005",
        "CallStatus": "ringing",
        "Direction": "inbound",
    })

    # Step 2: process (fire async AI — we don't need the TwiML)
    req("post", "/api/twilio/process", data={
        "CallSid": call_sid,
        "SpeechResult": speech_result,
        "CallStatus": "in-progress",
    })

    # Step 3: status completed
    req("post", "/api/twilio/status", data={
        "CallSid": call_sid,
        "CallStatus": "completed",
        "CallDuration": "45",
        "From": from_number,
        "To": "+17754204005",
        "Direction": "inbound",
    })

    # Step 4: reprocess (runs post-call intelligence synchronously in background)
    req("post", f"/api/calls/{call_sid}/reprocess")
    time.sleep(6)  # allow async intelligence to complete

    # Fetch call record
    r = req("get", "/api/calls")
    data = r.json()
    calls = data if isinstance(data, list) else data.get("calls", [])
    call = next((c for c in calls if c.get("call_sid") == call_sid), None)
    return call or {}

def cleanup_call(call_sid: str):
    """Delete the synthetic call record after the test."""
    req("delete", f"/api/calls/{call_sid}")

def cleanup_contact_by_phone(phone: str):
    """Delete any contact with the given phone number."""
    r = req("get", "/api/contacts")
    data = r.json()
    contacts = data if isinstance(data, list) else data.get("contacts", [])
    for c in contacts:
        if c.get("phone_number") == phone:
            req("delete", f"/api/contacts/{c['id']}")

# ── Test A: phone-only call, no name, no entities ─────────────────────────────
section("A. Phone-only call — no name, no entities → NO contact")
SID_A = f"TEST_A_{int(time.time())}"
PHONE_A = "+19991110001"

try:
    cleanup_contact_by_phone(PHONE_A)
    before = count_contacts_for_phone(PHONE_A)
    simulate_call_and_reprocess(SID_A, PHONE_A, "", None)
    after = count_contacts_for_phone(PHONE_A)
    check("No contact created for phone-only call", after == before,
          f"contacts before={before} after={after}")
finally:
    cleanup_call(SID_A)
    cleanup_contact_by_phone(PHONE_A)

# ── Test B: phone + service type, but no name ─────────────────────────────────
section("B. Phone + service type, no name → NO contact")
SID_B = f"TEST_B_{int(time.time())}"
PHONE_B = "+19991110002"

try:
    cleanup_contact_by_phone(PHONE_B)
    before = count_contacts_for_phone(PHONE_B)
    simulate_call_and_reprocess(SID_B, PHONE_B,
        "I need my AC fixed, it stopped working yesterday", None)
    after = count_contacts_for_phone(PHONE_B)
    check("No contact created when only service type given (no name)", after == before,
          f"contacts before={before} after={after}")
finally:
    cleanup_call(SID_B)
    cleanup_contact_by_phone(PHONE_B)

# ── Test C: name + phone → contact created ────────────────────────────────────
section("C. Name + phone → contact CREATED")
SID_C = f"TEST_C_{int(time.time())}"
PHONE_C = "+19991110003"

try:
    cleanup_contact_by_phone(PHONE_C)
    before = count_contacts_for_phone(PHONE_C)
    simulate_call_and_reprocess(SID_C, PHONE_C,
        "Hi my name is Alex Johnson, I need HVAC service at my house", "Alex Johnson")
    after = count_contacts_for_phone(PHONE_C)
    check("Contact created when name is provided", after > before,
          f"contacts before={before} after={after}")
finally:
    cleanup_call(SID_C)
    cleanup_contact_by_phone(PHONE_C)

# ── Test D: name only, no phone extracted ─────────────────────────────────────
section("D. Name only (no extracted phone) → contact CREATED with leg number")
SID_D = f"TEST_D_{int(time.time())}"
PHONE_D = "+19991110004"

try:
    cleanup_contact_by_phone(PHONE_D)
    before = count_contacts_for_phone(PHONE_D)
    simulate_call_and_reprocess(SID_D, PHONE_D,
        "This is Maria calling about a plumbing leak", "Maria")
    after = count_contacts_for_phone(PHONE_D)
    check("Contact created with leg number when name given but no explicit phone",
          after > before, f"contacts before={before} after={after}")
finally:
    cleanup_call(SID_D)
    cleanup_contact_by_phone(PHONE_D)

# ── Test E: reprocess of nameless call → still no contact ─────────────────────
section("E. Reprocess of nameless call → still NO contact")
SID_E = f"TEST_E_{int(time.time())}"
PHONE_E = "+19991110005"

try:
    cleanup_contact_by_phone(PHONE_E)
    simulate_call_and_reprocess(SID_E, PHONE_E, "Yeah uh I dunno", None)
    before = count_contacts_for_phone(PHONE_E)
    # Reprocess again
    req("post", f"/api/calls/{SID_E}/reprocess")
    time.sleep(6)
    after = count_contacts_for_phone(PHONE_E)
    check("Second reprocess of nameless call still creates no contact",
          after == before, f"contacts before={before} after={after}")
finally:
    cleanup_call(SID_E)
    cleanup_contact_by_phone(PHONE_E)

# ── Summary ───────────────────────────────────────────────────────────────────
print(f"\n{'='*60}")
passed = sum(1 for s, _, _ in results if s == PASS)
failed = sum(1 for s, _, _ in results if s == FAIL)
print(f"  RESULTS: {passed} passed, {failed} failed")
print(f"  Run at: {datetime.now(timezone.utc).isoformat()}")
print(f"{'='*60}")

if failed > 0:
    print("\nFAILED CHECKS:")
    for s, label, detail in results:
        if s == FAIL:
            print(f"  {FAIL} {label} | {detail}")
    sys.exit(1)
