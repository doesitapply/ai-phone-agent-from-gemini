#!/usr/bin/env python3
"""Analyze the current state of the Jul 27 batch vs the ledger."""
import json, csv

with open('outbound/pending_batch.json') as f:
    data = json.load(f)

batch = data['items']
drafted_on = data.get('drafted_on', '?')
print(f"Batch drafted_on: {drafted_on}")
print(f"Total items in pending_batch.json: {len(batch)}")

# Load ledger
sent_emails = {}
with open('outbound/campaign_ledger.csv') as f:
    reader = csv.DictReader(f)
    for row in reader:
        sent_emails[row['email']] = row

# Which batch items are already in ledger?
already_sent = [x for x in batch if x['email'] in sent_emails]
not_in_ledger = [x for x in batch if x['email'] not in sent_emails]

print(f"\nAlready in ledger: {len(already_sent)}")
print(f"NOT yet in ledger (unsent per ledger): {len(not_in_ledger)}")

if not_in_ledger:
    print("\nUnsent items (not in ledger):")
    for x in not_in_ledger:
        print(f"  - {x['email']} | {x.get('company','?')} | touch#{x.get('touch_number','?')}")

# Check live log
import subprocess
result = subprocess.run(['cat', '/tmp/campaign_send_jul27.log'], capture_output=True, text=True)
log_lines = result.stdout.strip().split('\n')
sent_in_log = [l for l in log_lines if 'Sent to' in l]
print(f"\nSent lines in live log: {len(sent_in_log)}")
if sent_in_log:
    print(f"Last sent: {sent_in_log[-1].strip()}")

# Check if process is still running
ps = subprocess.run(['pgrep', '-f', 'campaign.py send'], capture_output=True, text=True)
print(f"\nProcess running: {'YES (PID ' + ps.stdout.strip() + ')' if ps.stdout.strip() else 'NO'}")
