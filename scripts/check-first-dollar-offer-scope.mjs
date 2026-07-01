#!/usr/bin/env node
import { readFileSync } from "node:fs";

const surfaces = [
  "src/components/SetupWizard.tsx",
  "src/routes/workspace-profile-routes.ts",
  "src/db.ts",
];

const bannedClaims = [
  ["demo as default intake path", /\bseeing a quick demo\b|\brequest a demo\b|\bdemo\/setup\b|\bplan selection\/demo\b/i],
  ["full-answer mode as first-dollar promise", /\bFull Answer\b|\bfull answering\b|\bFull Answer Mode\b/i],
  ["multi-plan ladder in default prompt", /\bStarter,\s*Pro,\s*Agency\b|\bPro is \$397\b|\bAgency is \$697\b/i],
  ["advanced integrations as first-dollar promise", /\bCRM\/webhook\b|\badvanced routing\b|\bmulti-agent\b|\bpriority deployment\b/i],
  ["smart voicemail positioning in default prompt", /\bSmart Voicemail\b|\bsmart voicemail\b/i],
];

const requiredClaims = [
  ["missed-call recovery offer", /\bMissed-Call Recovery\b|\bmissed-call recovery\b/i],
  ["owner email alerts", /\bowner email alerts?\b|\bowner notifications?\b/i],
  ["callback task", /\bcallback tasks?\b/i],
  ["proof dashboard", /\bproof dashboard\b/i],
];

const failures = [];

for (const file of surfaces) {
  const text = readFileSync(file, "utf8");
  for (const [label, pattern] of bannedClaims) {
    if (pattern.test(text)) {
      failures.push(`${file}: ${label}`);
    }
  }
}

const combined = surfaces.map((file) => readFileSync(file, "utf8")).join("\n");
for (const [label, pattern] of requiredClaims) {
  if (!pattern.test(combined)) {
    failures.push(`prompt/onboarding surfaces missing ${label}`);
  }
}

if (failures.length) {
  console.error("FAIL first-dollar offer scope drift found:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`OK first-dollar offer scope is narrow across ${surfaces.length} prompt/onboarding files`);

