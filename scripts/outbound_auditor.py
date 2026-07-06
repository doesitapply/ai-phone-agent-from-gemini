#!/usr/bin/env python3
"""
SMIRK local revenue-leakage audit generator.

This is intentionally not a spam bot. It reads a manually curated list of local
businesses, records off-hours availability observations, and writes reviewable
Markdown drafts. It does not send email, submit forms, or scrape search results.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TARGETS = ROOT / "input" / "outbound-auditor-targets.json"
DEFAULT_OUTPUT = ROOT / "outputs" / "outbound-audits"


def load_targets(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"Target file missing: {path}\nCreate it from docs/outbound-auditor-targets.example.json.")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit("Target file must be a JSON array.")
    return data


def check_website(url: str, allow_network: bool) -> dict:
    if not url:
        return {"checked": False, "status": "missing_url"}
    if not allow_network:
        return {"checked": False, "status": "network_disabled", "url": url}
    try:
        req = Request(url, method="HEAD", headers={"User-Agent": "SMIRK local manual audit/1.0"})
        with urlopen(req, timeout=8) as response:
            return {"checked": True, "status": response.status, "url": url}
    except Exception as exc:
        return {"checked": True, "status": "unreachable", "url": url, "error": str(exc)}


def render_audit(target: dict, website_check: dict, now: dt.datetime) -> str:
    name = str(target.get("business_name") or "Unknown business").strip()
    trade = str(target.get("trade") or "local service business").strip()
    phone = str(target.get("phone") or "").strip()
    owner = str(target.get("owner_name") or "Owner").strip()
    observed = str(target.get("manual_observation") or "No manual observation entered yet.").strip()
    estimated_job = str(target.get("estimated_missed_job_value") or "$300-$1,500").strip()

    return f"""# Missed-Call Leakage Audit: {name}

Generated: {now.isoformat(timespec="seconds")}

## Business

- Name: {name}
- Trade: {trade}
- Phone: {phone or "Not entered"}
- Owner/contact: {owner}
- Website check: {json.dumps(website_check, ensure_ascii=True)}

## Manual Observation

{observed}

## Revenue Risk

One urgent missed call in {trade} can realistically represent {estimated_job} in recoverable work. The risk is not that every call is valuable; the risk is that the highest-intent calls happen while the crew is under a sink, on a roof, driving, or already on another job.

## Reviewable Email Draft

Subject: Quick missed-call audit for {name}

Hi {owner},

I was reviewing after-hours availability for local {trade} companies and noticed a possible gap: when a homeowner has an urgent problem and the phone does not get answered, they usually call the next business immediately.

SMIRK is a simple missed-call recovery layer. It answers the overflow call, captures who called and what they need, then sends the owner a callback-ready summary and task.

This is not an autodialer or mass texting tool. It is an inbound safety net for calls you already earned.

If you want, I can show you the exact dashboard using a local demo with plumbing/HVAC/electrical examples.
"""


def write_audits(targets: list[dict], output_dir: Path, allow_network: bool) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now().astimezone()
    written: list[Path] = []
    for target in targets:
        name = str(target.get("business_name") or "unknown").lower()
        slug = "".join(ch if ch.isalnum() else "-" for ch in name).strip("-") or "unknown"
        website_check = check_website(str(target.get("website") or "").strip(), allow_network)
        body = render_audit(target, website_check, now)
        path = output_dir / f"{now.strftime('%Y%m%d-%H%M%S')}-{slug}.md"
        path.write_text(body, encoding="utf-8")
        written.append(path)
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate manual-review SMIRK local revenue leakage audits.")
    parser.add_argument("--targets", default=str(DEFAULT_TARGETS), help="Path to manually curated JSON target list.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Directory for generated Markdown audits.")
    parser.add_argument("--allow-network-check", action="store_true", help="Allow HEAD checks for explicitly listed websites only.")
    args = parser.parse_args()

    targets = load_targets(Path(args.targets))
    written = write_audits(targets, Path(args.output), args.allow_network_check)
    print(json.dumps({"ok": True, "written": [str(path) for path in written]}, indent=2))


if __name__ == "__main__":
    main()
