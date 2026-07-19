#!/usr/bin/env python3
"""SMIRK outbound enrichment: crawl prospect websites for public contact emails.

Reads docs/launch/prospect-batch-*.csv, crawls each company's site (homepage +
contact/about pages), extracts public emails, scores/dedupes them, and writes
outbound/prospects_enriched.csv.

Compliant scope: public business contact emails only, from the business's own
official website. No purchased lists, no guessed permutations sent blind.
"""
import csv
import glob
import re
import sys
import time
import concurrent.futures as cf
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
CONTACT_PATHS = ["", "/contact", "/contact-us", "/about", "/about-us", "/contactus"]
BAD_EMAIL_PAT = re.compile(
    r"(example\.com|sentry|wixpress|schema|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|"
    r"noreply|no-reply|donotreply|@2x|godaddy|placeholder|yourdomain|domain\.com|"
    r"@[0-9.]+$|u003e|\.js$|\.css$)", re.I)
GENERIC_PREFIX_RANK = {
    # lower = better
    "owner": 0, "office": 1, "info": 2, "contact": 3, "service": 4, "sales": 5,
    "hello": 6, "support": 7, "admin": 8, "team": 9,
}


def fetch(url, timeout=12):
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True)
        if r.status_code == 200 and "text/html" in r.headers.get("content-type", "text/html"):
            return r.text
    except Exception:
        pass
    return None


def extract_emails(html, site_domain):
    if not html:
        return []
    found = set()
    # mailto links first (highest confidence)
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.select('a[href^="mailto:"]'):
        addr = a.get("href", "")[7:].split("?")[0].strip()
        if addr and EMAIL_RE.fullmatch(addr):
            found.add((addr.lower(), "mailto"))
    # visible text / raw html
    text = soup.get_text(" ")
    for m in EMAIL_RE.finditer(text):
        found.add((m.group(0).lower().strip(".") , "text"))
    for m in EMAIL_RE.finditer(html):
        found.add((m.group(0).lower().strip("."), "raw"))
    out = []
    for addr, src in found:
        if BAD_EMAIL_PAT.search(addr):
            continue
        if len(addr) > 60:
            continue
        out.append((addr, src))
    return out


def score_email(addr, src, site_domain):
    score = 0
    local, _, domain = addr.partition("@")
    if site_domain and (domain == site_domain or domain.endswith("." + site_domain)):
        score += 50  # same-domain email is best
    elif domain in ("gmail.com", "yahoo.com", "aol.com", "outlook.com", "hotmail.com", "msn.com", "icloud.com", "att.net", "sbcglobal.net", "charter.net", "comcast.net"):
        score += 25  # owner-operated businesses often use personal domains; acceptable
    else:
        score -= 20  # third-party domain, likely junk from embedded widgets
    if src == "mailto":
        score += 20
    prefix = local.split("+")[0]
    score += (10 - GENERIC_PREFIX_RANK.get(prefix, 5))
    return score


def site_domain_of(url):
    try:
        host = urlparse(url).netloc.lower()
        host = host.split(":")[0]
        if host.startswith("www."):
            host = host[4:]
        return host
    except Exception:
        return ""


def crawl_prospect(row):
    url = (row.get("contact_url") or row.get("source_url") or "").strip()
    result = dict(row)
    result["email"] = ""
    result["email_source_page"] = ""
    result["email_confidence"] = ""
    result["crawl_status"] = "no_url"
    if not url.startswith("http"):
        return result
    base = url
    dom = site_domain_of(url)
    candidates = {}
    pages_tried = []
    root = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
    seen_pages = set()
    for path in CONTACT_PATHS:
        page = base if path == "" else urljoin(root + "/", path.lstrip("/"))
        if page in seen_pages:
            continue
        seen_pages.add(page)
        html = fetch(page)
        pages_tried.append(page)
        if html is None:
            continue
        result["crawl_status"] = "crawled"
        for addr, src in extract_emails(html, dom):
            s = score_email(addr, src, dom)
            if addr not in candidates or s > candidates[addr][0]:
                candidates[addr] = (s, page)
        # also follow an on-page contact link if we haven't found a good hit yet
        if path == "" and not any(s >= 60 for s, _ in candidates.values()):
            try:
                soup = BeautifulSoup(html, "html.parser")
                for a in soup.find_all("a", href=True):
                    href = a["href"]
                    if re.search(r"contact", href, re.I) and not href.startswith("mailto"):
                        cu = urljoin(page, href)
                        if site_domain_of(cu) == dom and cu not in seen_pages:
                            seen_pages.add(cu)
                            h2 = fetch(cu)
                            if h2:
                                for addr, src in extract_emails(h2, dom):
                                    s = score_email(addr, src, dom)
                                    if addr not in candidates or s > candidates[addr][0]:
                                        candidates[addr] = (s, cu)
                            break
            except Exception:
                pass
        time.sleep(0.2)
    if result["crawl_status"] != "crawled":
        result["crawl_status"] = "unreachable"
    if candidates:
        best = sorted(candidates.items(), key=lambda kv: -kv[1][0])[0]
        addr, (score, page) = best
        if score >= 30:
            result["email"] = addr
            result["email_source_page"] = page
            result["email_confidence"] = "high" if score >= 60 else "medium"
    return result


def main():
    rows = []
    for f in sorted(glob.glob("docs/launch/prospect-batch-*.csv")):
        batch = re.search(r"batch-(\d+)", f).group(1)
        for r in csv.DictReader(open(f)):
            r["batch"] = batch
            rows.append(r)
    print(f"Loaded {len(rows)} prospects", flush=True)
    results = []
    with cf.ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(crawl_prospect, r): r for r in rows}
        done = 0
        for fut in cf.as_completed(futs):
            results.append(fut.result())
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(rows)} crawled", flush=True)
    # stable order: batch then company
    results.sort(key=lambda r: (r["batch"], r["company"]))
    fields = list(rows[0].keys()) + ["email", "email_source_page", "email_confidence", "crawl_status"]
    with open("outbound/prospects_enriched.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(results)
    hits = [r for r in results if r["email"]]
    high = [r for r in hits if r["email_confidence"] == "high"]
    unreachable = [r for r in results if r["crawl_status"] == "unreachable"]
    print(f"\nDone. {len(results)} prospects | {len(hits)} emails found ({len(high)} high-confidence) | {len(unreachable)} sites unreachable")
    print(f"Hit rate: {len(hits)/len(results)*100:.0f}%")


if __name__ == "__main__":
    sys.exit(main())
