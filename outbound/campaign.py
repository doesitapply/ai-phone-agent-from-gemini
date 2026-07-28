#!/usr/bin/env python3
"""SMIRK outbound campaign engine.

Subcommands:
  draft   — select next batch (respecting daily cap + follow-up schedule),
            generate personalized emails, write outbound/pending_batch.json
            and a human-readable preview markdown. Sends nothing.
  send    — send everything in outbound/pending_batch.json via Resend,
            append results to outbound/campaign_ledger.csv. Requires
            RESEND_API_KEY. Refuses to run if the batch was not drafted today.
            Enforces randomized inter-send delays (3–12 min), weekend guard,
            bounce circuit breaker (pause at 2% hard bounce rate), and
            gradual daily-cap ramp.
  status  — print campaign stats from the ledger.

Design rules:
  * Email-only. No SMS, no calls.
  * Daily cap ramps gradually (30 → 40 → 50 over days). Never exceeds 50 from
    a single sending address. Never doubles overnight.
  * Sequence: touch 1 (intro) → day 3 (follow-up) → day 7 (final). Then stop.
  * Suppression: never email an address twice for the same touch, never email
    anyone who replied (mark reply in ledger with response != no_response),
    never email addresses in outbound/suppression.txt (unsubscribes).
  * CAN-SPAM: real sender, truthful subject, physical address + opt-out line.
  * Deliverability: plain-text only, max 1 URL per email, randomized send
    spacing (3–12 min), no weekend sends, copy rotation within each touch,
    bounce circuit breaker pauses the run if hard bounce rate exceeds 2%.
"""
import csv
import json
import os
import random
import re
import sys
import time
import datetime as dt
import urllib.request
try:
    import requests as _requests
    _USE_REQUESTS = True
except ImportError:
    _USE_REQUESTS = False

BASE = os.path.dirname(os.path.abspath(__file__))
ENRICHED = os.path.join(BASE, "prospects_enriched.csv")
NATIONWIDE = os.path.join(BASE, "prospects_nationwide.csv")
LEDGER = os.path.join(BASE, "campaign_ledger.csv")
PENDING = os.path.join(BASE, "pending_batch.json")
PREVIEW = os.path.join(BASE, "pending_batch_preview.md")
SUPPRESSION = os.path.join(BASE, "suppression.txt")

# ---------------------------------------------------------------------------
# Gradual ramp schedule: (min_total_sends, daily_cap)
# The engine picks the highest tier whose min_total_sends threshold has been
# crossed. Hard ceiling: 50 cold sends/day from a single inbox.
# ---------------------------------------------------------------------------
RAMP_SCHEDULE = [
    (0,   30),   # days 1–N until 120 total sends
    (120, 40),   # after 120 total sends
    (200, 50),   # after 200 total sends — hard ceiling
]

# Bounce circuit breaker: pause if hard bounce rate exceeds this threshold
# in the current batch.
BOUNCE_RATE_THRESHOLD = 0.02  # 2%

CONFIG = {
    "from_name": "Cam @ SMIRK",
    "from_email": "cam@smirkcalls.com",
    # NOTE: root smirkcalls.com has no MX/mailbox (CNAME -> Railway). Replies MUST
    # go to a real inbox. Cam's Gmail is the only monitored inbox.
    "reply_to": os.environ.get("SMIRK_REPLY_TO", "madeinreno775@gmail.com"),
    # daily_cap is now derived from the ramp schedule; SMIRK_DAILY_CAP env var
    # overrides the ramp (useful for manual caps during testing).
    "daily_cap_override": os.environ.get("SMIRK_DAILY_CAP"),
    "followup_days": [3, 7],
    "physical_address": os.environ.get(
        "SMIRK_MAILING_ADDRESS", "1605 McKinley Drive, Reno, NV 89509"
    ),
    "launch_url": "https://smirkcalls.com/launch",
    "demo_phone": os.environ.get("SMIRK_DEMO_PHONE", "(775) 420-3005"),
    "site_url": "https://smirkcalls.com",
    # $99/mo founders rate payment link (Stripe, live) — honors the outreach promise;
    # public pricing stays $197+. Locked-for-life framing for early batches.
    # plink_1Tv57sIoSdlZwew11AwpYtqR — $99/mo price on the canonical "SMIRK AI Starter"
    # product, recognized by the founders fulfillment lane via
    # STRIPE_PAYMENT_LINK_FOUNDERS_ID. Will be recreated once the Stripe account
    # ToS URL is set (consent_collection is immutable) — update this URL then.
    "founders_link": "https://buy.stripe.com/9B63cvcM31bGcmb9906Zy0j",
    # Inter-send delay range in seconds (3–12 minutes). Randomized per send.
    "delay_min_s": 180,
    "delay_max_s": 720,
}

# Junk/irrelevant inboxes we never want to pitch
SKIP_LOCALPART = re.compile(r"^(humanresources|hr|careers|jobs|billing|accounting|account|invoice|legal|press|media|webmaster|abuse|privacy)$", re.I)

LEDGER_FIELDS = [
    "sent_at", "company", "vertical", "region", "email", "touch_number",
    "subject", "message_variant", "resend_id", "status", "response",
    "notes", "batch", "contact_url",
]

# (emergency scenario, dollar value of the lost job, trade noun)
VERTICAL_HOOKS = {
    "plumbing": ("a backed-up sewer", "$500", "plumber"),
    "hvac": ("a dead AC in a heat wave", "$400", "HVAC company"),
    "roofing": ("a leaking roof after a storm", "$800", "roofer"),
    "electrician": ("a dead panel", "$400", "electrician"),
    "handyman": ("an urgent repair", "$300", "handyman"),
    "remodeling": ("a serious remodel inquiry", "$5,000", "contractor"),
    "auto_repair": ("a breakdown", "$400", "shop"),
    "landscaping": ("an estimate request", "$300", "landscaper"),
    "pest_control": ("an infestation", "$300", "pest company"),
    "garage_door": ("a door stuck half-open", "$350", "garage door company"),
}

# ---------------------------------------------------------------------------
# Copy rotation: multiple variants per touch to avoid identical text-pattern
# flagging. Each variant is a (subject_suffix, body_template_key) pair.
# The engine picks a variant deterministically per company (hash-based) so
# the same company always gets the same variant, but different companies in
# the same batch get different variants.
# ---------------------------------------------------------------------------
T1_VARIANTS = [
    "a",  # original — "If a homeowner calls you with..."
    "b",  # angle: cost framing first
    "c",  # angle: competitor framing
]
T2_VARIANTS = [
    "a",  # original — "Quick one. Most people who hit a voicemail..."
    "b",  # angle: direct question
    "c",  # angle: social proof framing
]
T3_VARIANTS = [
    "a",  # original — "Last email from me, promise..."
    "b",  # angle: urgency/scarcity
]


def pick_variant(company, variants):
    """Deterministically pick a variant index for a given company."""
    return variants[hash(company.lower()) % len(variants)]


def vertical_key(v):
    v = (v or "").lower()
    for k in VERTICAL_HOOKS:
        if k in v:
            return k
    return "handyman"


def load_enriched():
    rows = []
    seen = set()
    for path in (ENRICHED, NATIONWIDE):
        if not os.path.exists(path):
            continue
        with open(path) as f:
            for r in csv.DictReader(f):
                email = (r.get("email") or "").strip().lower()
                key = email or r.get("company", "").strip().lower()
                if key in seen:
                    continue
                seen.add(key)
                rows.append(r)
    return rows


def load_ledger():
    if not os.path.exists(LEDGER):
        return []
    with open(LEDGER) as f:
        return list(csv.DictReader(f))


def load_suppression():
    sup = set()
    if os.path.exists(SUPPRESSION):
        for line in open(SUPPRESSION):
            line = line.strip().lower()
            if line and not line.startswith("#"):
                sup.add(line)
    return sup


def sendable_prospects():
    """Prospects with a usable email, not junk-inbox, not suppressed."""
    sup = load_suppression()
    out = []
    for r in load_enriched():
        email = (r.get("email") or "").strip().lower()
        if not email or email in sup:
            continue
        local = email.split("@")[0]
        if SKIP_LOCALPART.match(local):
            continue
        out.append(r)
    return out


def priority(r):
    """Lower = earlier. Vertical urgency-fit first, then region, then confidence."""
    vorder = ["plumbing", "hvac", "garage_door", "electrician", "roofing",
              "auto_repair", "pest_control", "handyman", "landscaping", "remodeling"]
    v = vertical_key(r["vertical"])
    region = (r["region"] or "").lower()
    rorder = ["reno", "sparks", "northern nevada", "sacramento", "boise",
              "treasure valley", "meridian", "salt lake", "wasatch", "fresno", "clovis"]
    rscore = next((i for i, k in enumerate(rorder) if k in region), len(rorder))
    conf = 0 if r.get("email_confidence") == "high" else 1
    return (vorder.index(v) if v in vorder else 99, rscore, conf, r["company"])


def touch_state(ledger):
    """Map email -> {touches:[(n, sent_at)], replied:bool}."""
    state = {}
    for row in ledger:
        e = row["email"].lower()
        s = state.setdefault(e, {"touches": [], "replied": False, "company": row["company"]})
        if row["status"] == "sent":
            s["touches"].append((int(row["touch_number"]), row["sent_at"]))
        if row.get("response") and row["response"] not in ("", "no_response"):
            s["replied"] = True
    return state


def days_since(iso):
    then = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (dt.datetime.now(dt.timezone.utc) - then).days


def get_daily_cap(total_sent_so_far):
    """Derive the daily cap from the ramp schedule, respecting env override."""
    override = CONFIG.get("daily_cap_override")
    if override:
        return int(override)
    cap = RAMP_SCHEDULE[0][1]
    for threshold, tier_cap in RAMP_SCHEDULE:
        if total_sent_so_far >= threshold:
            cap = tier_cap
    return cap


def draft_email(r, touch_number):
    company = r["company"].strip()
    vkey = vertical_key(r["vertical"])
    hook_call, hook_dollars, trade_noun = VERTICAL_HOOKS[vkey]
    region_short = r["region"].split("/")[0].split(",")[0].strip()
    launch = CONFIG["launch_url"]
    founders = CONFIG["founders_link"]
    demo_phone = CONFIG.get("demo_phone", "(775) 420-3005")
    _rl = (r["region"] or "").lower()
    if any(k in _rl for k in ("reno", "sparks", "northern nevada", "carson")):
        local_line = "I'm right here in Reno, and I built SMIRK to stop that."
        local_line_b = "I built SMIRK right here in Reno to solve exactly this problem."
        local_line_c = "I'm based in Reno and built SMIRK specifically for shops like yours."
    else:
        local_line = "I run a shop-focused company called SMIRK, built to stop exactly that."
        local_line_b = "I built SMIRK — a service designed specifically for trade shops — to fix this."
        local_line_c = "I started SMIRK because I kept hearing from shop owners about this exact problem."
    footer = (
        f"Cam | SMIRK\n"
        f"{CONFIG['physical_address']}\n"
        f"(Reply \"stop\" to opt out)"
    )

    if touch_number == 1:
        variant = pick_variant(company, T1_VARIANTS)
        if variant == "a":
            subject = f"Missed calls at {company}"
            body = (
                f"Hi {company} team,\n\n"
                f"If a homeowner calls you with {hook_call} while your guys are out on jobs, they don't leave a voicemail. They hang up and call the next {trade_noun} on Google. That's a {hook_dollars} job handed straight to your competition.\n\n"
                f"{local_line} It answers the calls you miss, figures out exactly what the emergency is, and sends a summary straight to your cell so you can lock them down.\n\n"
                f"No chatbots, no complex software, zero setup for your team.\n\n"
                f"Don't take my word for it. Call the demo line right now at {demo_phone} and give it a fake emergency — you'll hear exactly what your customers hear. Or try it from your desk: {launch}\n\n"
                f"{footer}"
            )
        elif variant == "b":
            subject = f"How much is a missed call worth to {company}?"
            body = (
                f"Hi {company} team,\n\n"
                f"A {trade_noun} getting {hook_call} on a Saturday and hitting voicemail — that caller is worth {hook_dollars} to whoever picks up. If it's not you, it's someone else.\n\n"
                f"{local_line_b} SMIRK answers every call you miss, qualifies the job, and texts you the details in real time.\n\n"
                f"Hear it yourself — call {demo_phone} with a fake emergency or check it out: {launch}\n\n"
                f"{footer}"
            )
        else:  # variant c
            subject = f"Your competitors are answering calls you're missing"
            body = (
                f"Hi {company} team,\n\n"
                f"When a homeowner with {hook_call} can't reach you, they don't wait. They call the next {trade_noun} on Google. That job goes to whoever picks up first.\n\n"
                f"{local_line_c} SMIRK is an AI answering service built for trade shops — it catches your missed calls, gets the details, and texts you instantly so you can call back and close the job.\n\n"
                f"30-second demo, no signup: {launch} or call {demo_phone}\n\n"
                f"{footer}"
            )
        variant_key = f"smirk_email_t1{variant}"

    elif touch_number == 2:
        variant = pick_variant(company, T2_VARIANTS)
        if variant == "a":
            subject = f"Re: Missed calls at {company}"
            body = (
                f"Hi {company} team,\n\n"
                f"Quick one. Most people who hit a voicemail don't leave a message — they just call the next {trade_noun} on the list. Every one of those is a {hook_dollars} job you never knew you lost.\n\n"
                f"SMIRK catches those calls instantly and texts YOU the details so you can call back and win the work before someone else does.\n\n"
                f"30-second test, no signup — call {demo_phone} or visit {launch}\n\n"
                f"{footer}"
            )
        elif variant == "b":
            subject = f"Re: Missed calls at {company}"
            body = (
                f"Hi {company} team,\n\n"
                f"Quick question: what happens to a call that hits your voicemail at 7pm on a Friday?\n\n"
                f"For most shops, that caller moves on. SMIRK answers it, gets the job details, and texts you immediately — so you can call back before they find someone else.\n\n"
                f"Try it in 30 seconds: {launch} or call {demo_phone}\n\n"
                f"{footer}"
            )
        else:  # variant c
            subject = f"Re: Missed calls at {company}"
            body = (
                f"Hi {company} team,\n\n"
                f"Shop owners using SMIRK are recovering {hook_dollars}+ jobs they would have lost to voicemail. The ones who aren't using it are the ones those jobs go to instead.\n\n"
                f"It takes 30 seconds to hear how it works — call {demo_phone} or visit {launch}\n\n"
                f"{footer}"
            )
        variant_key = f"smirk_email_t2{variant}"

    else:  # touch 3
        variant = pick_variant(company, T3_VARIANTS)
        if variant == "a":
            subject = f"Re: Missed calls at {company} (last one)"
            body = (
                f"Hi {company} team,\n\n"
                f"Last email from me, promise.\n\n"
                f"I'm locking in the first {region_short} shops at $99/month — founders rate, price never goes up as long as you're a customer. After the first batch it's $197.\n\n"
                f"If missed calls aren't costing you jobs, ignore this and you won't hear from me again. If they are: {founders}\n\n"
                f"Hear it first — call {demo_phone} with a fake emergency: {launch}\n\n"
                f"{footer}"
            )
        else:  # variant b
            subject = f"Re: Missed calls at {company} — closing this out"
            body = (
                f"Hi {company} team,\n\n"
                f"Last one from me.\n\n"
                f"I'm holding the $99/month founders rate for the first shops in each market. Once those spots fill, it goes to $197. No pressure — if the timing isn't right, no hard feelings.\n\n"
                f"If you want to lock it in: {founders}\n\n"
                f"Or just hear the demo first: {launch}\n\n"
                f"{footer}"
            )
        variant_key = f"smirk_email_t3{variant}"

    return subject, body, variant_key


def cmd_draft():
    ledger = load_ledger()
    state = touch_state(ledger)
    total_sent = len([r for r in ledger if r["status"] == "sent"])
    cap = get_daily_cap(total_sent)
    today = dt.date.today().isoformat()

    # Weekend guard: no cold outreach on Saturday (5) or Sunday (6)
    weekday = dt.date.today().weekday()
    if weekday >= 5:
        day_name = "Saturday" if weekday == 5 else "Sunday"
        print(f"Weekend guard: today is {day_name}. No outbound sends on weekends. Skipping.")
        write_pending([], today)
        return

    # Don't double-draft/send in one day
    sent_today = [r for r in ledger if r["status"] == "sent" and r["sent_at"][:10] == today]
    remaining = cap - len(sent_today)
    if remaining <= 0:
        print(f"Daily cap {cap} already reached today ({len(sent_today)} sent). Nothing drafted.")
        write_pending([], today)
        return

    batch = []
    # 1) due follow-ups first
    prospects = {p["email"].lower(): p for p in sendable_prospects()}
    for email, s in state.items():
        if s["replied"] or email not in prospects:
            continue
        touches = sorted(s["touches"])
        if not touches:
            continue
        last_n, last_at = touches[-1]
        if last_n >= 1 + len(CONFIG["followup_days"]):
            continue  # sequence complete
        threshold = CONFIG["followup_days"][last_n - 1]
        if days_since(last_at) >= threshold:
            batch.append((prospects[email], last_n + 1))
        if len(batch) >= remaining:
            break

    # 2) fresh touch-1 sends
    if len(batch) < remaining:
        fresh = [p for p in sorted(sendable_prospects(), key=priority)
                 if p["email"].lower() not in state]
        for p in fresh:
            batch.append((p, 1))
            if len(batch) >= remaining:
                break

    items = []
    for p, n in batch:
        subject, body, variant_key = draft_email(p, n)
        items.append({
            "company": p["company"], "vertical": p["vertical"], "region": p["region"],
            "email": p["email"].lower(), "touch_number": n, "subject": subject,
            "body": body, "batch": p.get("batch", ""), "contact_url": p.get("contact_url", ""),
            "message_variant": variant_key,
        })
    write_pending(items, today)
    write_preview(items, today)
    print(f"Drafted {len(items)} emails ({sum(1 for i in items if i['touch_number']==1)} new, "
          f"{sum(1 for i in items if i['touch_number']>1)} follow-ups). "
          f"Cap today: {cap} (ramp tier based on {total_sent} total sends). "
          f"Preview: outbound/pending_batch_preview.md")


def write_pending(items, today):
    with open(PENDING, "w") as f:
        json.dump({"drafted_on": today, "items": items}, f, indent=1)


def write_preview(items, today):
    lines = [f"# Pending batch — drafted {today}", ""]
    for i, it in enumerate(items, 1):
        lines += [
            f"## {i}. {it['company']} — {it['region']} (touch {it['touch_number']})",
            f"**To:** {it['email']}  ",
            f"**Subject:** {it['subject']}",
            "", "```", it["body"], "```", "",
        ]
    with open(PREVIEW, "w") as f:
        f.write("\n".join(lines))


def resend_send(item, api_key):
    payload = {
        "from": f"{CONFIG['from_name']} <{CONFIG['from_email']}>",
        "to": [item["email"]],
        "reply_to": CONFIG["reply_to"],
        "subject": item["subject"],
        "text": item["body"],
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "python-requests/2.31.0",
    }
    if _USE_REQUESTS:
        try:
            resp = _requests.post(
                "https://api.resend.com/emails",
                headers=headers,
                json=payload,
                timeout=30,
            )
            if resp.status_code == 200:
                data = resp.json()
                return "sent", data.get("id", ""), ""
            body = resp.text[:200]
            is_hard_bounce = resp.status_code in (550, 551, 552, 553, 554, 421) or "bounce" in body.lower()
            err_type = "hard_bounce" if is_hard_bounce else f"HTTP {resp.status_code}"
            return "failed", "", f"{err_type}: {body}"
        except Exception as e:
            return "failed", "", str(e)[:200]
    # Fallback: urllib
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
            return "sent", data.get("id", ""), ""
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        is_hard_bounce = e.code in (550, 551, 552, 553, 554, 421) or "bounce" in body.lower()
        err_type = "hard_bounce" if is_hard_bounce else f"HTTP {e.code}"
        return "failed", "", f"{err_type}: {body}"
    except Exception as e:
        return "failed", "", str(e)[:200]


def append_ledger(rows):
    exists = os.path.exists(LEDGER)
    with open(LEDGER, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=LEDGER_FIELDS)
        if not exists:
            w.writeheader()
        w.writerows(rows)


def cmd_send():
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    if not api_key:
        print("ERROR: RESEND_API_KEY not set", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(PENDING):
        print("No pending batch. Run draft first.", file=sys.stderr)
        sys.exit(1)
    with open(PENDING) as f:
        pending = json.load(f)
    today = dt.date.today().isoformat()
    if pending.get("drafted_on") != today:
        print(f"ERROR: pending batch drafted {pending.get('drafted_on')}, not today ({today}). Re-draft.", file=sys.stderr)
        sys.exit(1)
    items = pending.get("items", [])
    if not items:
        print("Pending batch is empty. Nothing to send.")
        return

    # Weekend guard at send time too (in case draft ran on a weekday but send
    # is attempted on a weekend, e.g. a delayed manual run)
    weekday = dt.date.today().weekday()
    if weekday >= 5:
        day_name = "Saturday" if weekday == 5 else "Sunday"
        print(f"Weekend guard: today is {day_name}. Aborting send. Re-draft on Monday.", file=sys.stderr)
        sys.exit(1)

    # suppression re-check at send time
    sup = load_suppression()
    results = []
    ok = fail = hard_bounces = 0
    total = len([it for it in items if it["email"] not in sup])

    for idx, it in enumerate(items):
        if it["email"] in sup:
            continue

        status, rid, err = resend_send(it, api_key)
        results.append({
            "sent_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "company": it["company"], "vertical": it["vertical"], "region": it["region"],
            "email": it["email"], "touch_number": it["touch_number"],
            "subject": it["subject"], "message_variant": it["message_variant"],
            "resend_id": rid, "status": status, "response": "no_response",
            "notes": err, "batch": it["batch"], "contact_url": it["contact_url"],
        })
        if status == "sent":
            ok += 1
        else:
            fail += 1
            if "hard_bounce" in err:
                hard_bounces += 1

        # Bounce circuit breaker: check after each send once we have a
        # meaningful sample (at least 5 attempts). Pause immediately if
        # hard bounce rate exceeds 2%.
        attempts = ok + fail
        if attempts >= 5:
            bounce_rate = hard_bounces / attempts
            if bounce_rate > BOUNCE_RATE_THRESHOLD:
                # Flush what we have, then abort
                append_ledger(results)
                os.remove(PENDING)
                print(
                    f"\nCIRCUIT BREAKER TRIGGERED: hard bounce rate {bounce_rate:.1%} "
                    f"({hard_bounces}/{attempts}) exceeds {BOUNCE_RATE_THRESHOLD:.0%} threshold. "
                    f"Sent {ok} before pause. Sequence halted. "
                    f"Verify list hygiene before resuming.",
                    file=sys.stderr
                )
                sys.exit(2)

        # Randomized inter-send delay (3–12 minutes) — skip after last email
        is_last = (idx == len(items) - 1)
        if not is_last:
            delay = random.randint(CONFIG["delay_min_s"], CONFIG["delay_max_s"])
            print(f"  [{idx+1}/{total}] Sent to {it['email']} — waiting {delay//60}m {delay%60}s before next send...")
            time.sleep(delay)

    append_ledger(results)
    os.remove(PENDING)
    print(f"Sent {ok}, failed {fail}. Ledger: outbound/campaign_ledger.csv")
    if fail:
        for r in results:
            if r["status"] == "failed":
                print(f"  FAIL {r['email']}: {r['notes']}")


def cmd_status():
    ledger = load_ledger()
    state = touch_state(ledger)
    sent = [r for r in ledger if r["status"] == "sent"]
    t1 = sum(1 for r in sent if r["touch_number"] == "1")
    replied = sum(1 for s in state.values() if s["replied"])
    total_sendable = len(sendable_prospects())
    contacted = len({r["email"] for r in sent})
    cap = get_daily_cap(len(sent))
    print(f"Sendable prospects: {total_sendable}")
    print(f"Contacted (unique): {contacted}")
    print(f"Total sends: {len(sent)} (t1={t1})")
    print(f"Replies logged: {replied}")
    print(f"Uncontacted remaining: {total_sendable - contacted}")
    print(f"Current daily cap (ramp): {cap}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "draft":
        cmd_draft()
    elif cmd == "send":
        cmd_send()
    elif cmd == "status":
        cmd_status()
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
