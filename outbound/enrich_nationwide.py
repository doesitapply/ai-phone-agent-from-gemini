#!/usr/bin/env python3
"""Second-pass enrichment for nationwide prospects: crawl sites for rows with no
email yet, reusing the crawler from enrich.py, and update prospects_nationwide.csv
in place."""
import concurrent.futures as cf
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from enrich import crawl_prospect

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prospects_nationwide.csv")


def main():
    with open(PATH) as f:
        rows = list(csv.DictReader(f))
        fields = list(rows[0].keys())

    todo = [r for r in rows if not r["email"].strip()]
    print(f"Loaded {len(rows)} nationwide prospects; crawling {len(todo)} without email", flush=True)

    with cf.ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(crawl_prospect, dict(r)): r for r in todo}
        done = 0
        for fut in cf.as_completed(futs):
            res = fut.result()
            orig = futs[fut]
            for k in ("email", "email_source_page", "email_confidence", "crawl_status"):
                orig[k] = res.get(k, orig.get(k, ""))
            if orig["email"]:
                orig["channel"] = "email"
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(todo)} crawled", flush=True)

    with open(PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    hits = [r for r in rows if r["email"]]
    high = [r for r in hits if r["email_confidence"] == "high"]
    print(f"\nDone. {len(rows)} prospects | {len(hits)} emails ({len(high)} high-conf) | hit rate {len(hits)/len(rows)*100:.0f}%")


if __name__ == "__main__":
    sys.exit(main())
