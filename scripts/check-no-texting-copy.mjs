#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const textLikeExtensions = /\.(cjs|js|jsx|json|md|mdx|mjs|ts|tsx|txt)$/i;
const ignoredTextFiles =
  /(^|\/)(dist|dist-server|node_modules|output|tmp)\/|(^|\/)(package-lock|pnpm-lock)\.yaml$|(^|\/)package-lock\.json$|^scripts\/(?:check-no-texting-copy|check-first-dollar-guard-coverage)\.mjs$/i;

const listCandidateTextFiles = () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);

  return [...new Set([...tracked, ...untracked])]
    .filter((filePath) => !ignoredTextFiles.test(filePath))
    .filter((filePath) => textLikeExtensions.test(filePath) || /\.bak\b/i.test(filePath))
    .map((filePath) => path.join(repoRoot, filePath));
};

const files = process.env.NO_TEXTING_COPY_FILES
  ? process.env.NO_TEXTING_COPY_FILES.split(path.delimiter)
      .filter(Boolean)
      .map((filePath) => path.resolve(filePath))
  : listCandidateTextFiles();

const bannedClaims = [
  ["call or text", /call\s+or\s+text/i],
  ["text back", /text\s*-?\s*back/i],
  ["text customers", /text\s+customers/i],
  ["automated text", /automated\s+text/i],
  ["send texts", /send\s+texts?/i],
  ["sends text messages", /sends?\s+text\s+messages?/i],
  ["reply by text", /reply\s+by\s+text/i],
  ["SMS as outreach channel", /\bSMS\b.{0,48}\b(?:outreach\s+channel|explicit\s+opt-in|existing\s+relationship|default\s+strategy)\b/i],
  ["reply here", /reply\s+here/i],
  ["Suggested reply", /Suggested\s+reply/i],
  ["SMS follow-up", /\bSMS\b.{0,24}follow-?up|follow-?up.{0,24}\bSMS\b/i],
  ["AI Phone Agent positioning", /\bAI\s+Phone\s+Agent\b/i],
  ["broad AI phone agent positioning", /\b(?:a|an|the|professional|active)\s+AI\s+phone\s+agent\b/i],
  ["conversational AI phone agent positioning", /\bconversational\s+AI\s+phone\s+agent\b/i],
  ["make and receive phone calls positioning", /\bmake\s+and\s+receive\s+phone\s+calls\b/i],
  ["No missed calls", /No\s+missed\s+calls/i],
  ["Zero missed calls", /Zero\s+missed\s+calls/i],
  ["0 missed inbound calls", /0\s+missed\s+inbound\s+calls/i],
  ["full front-desk positioning", /\bfull\s+front-?desk\b/i],
  ["professional front desk positioning", /\bprofessional\s+front\s+desk\b/i],
  ["full autonomous dispatcher positioning", /\bfull\s+autonomous\s+dispatcher\b/i],
  ["full autonomous customer support positioning", /\bfull\s+autonomous\s+customer\s+support\b/i],
  ["books appointments", /books\s+appointments/i],
  ["book appointments", /book\s+appointments/i],
  ["booking flow", /booking\s+flow/i],
  ["booking appointment", /booking\s+appointment/i],
  ["appointment capture", /appointment\s+capture/i],
  ["appointment booking", /appointment\s+booking/i],
  ["appointment scheduling", /appointment\s+scheduling/i],
  ["schedules appointments", /schedules?\s+appointments?/i],
  ["booking unless configured", /booking\s+unless\b.{0,60}\bconfigured/i],
  ["calendar booking", /calendar\s+booking/i],
  ["booking tools", /booking\s+tools/i],
  ["go ahead and book", /\bgo\s+ahead\s+and\s+book\b/i],
  ["book that for you", /\bbook\s+that\s+for\s+you\b/i],
  ["scheduling team follow-up", /\bscheduling\s+team\s+reach\s+out\b/i],
  ["existing bookings availability", /\bexisting\s+bookings?\s+at\b/i],
  ["book appointment tool guidance", /appropriate\s+tools\b.{0,80}\bbook_appointment\b/i],
  ["booking scheduling self-handle routing", /booking\/scheduling\s*→\s*AI\s+handles/i],
  ["book setup", /\bbook\s+setup(?:\s+call)?\b/i],
  ["book a setup call", /\bbook\s+a\s+setup\s+call\b/i],
  ["book free demo", /\bbook\s+your\s+free\b.{0,32}\bdemo\b/i],
  ["booking email", /\bbooking\s+email\b/i],
  ["calendar confirmation close", /\byou'?re\s+on\s+his\s+calendar\b/i],
  ["confirm booking out loud", /\bconfirm\s+the\s+booking\s+out\s+loud\b/i],
  ["appointment tool can book during call", /\bbook\/reschedule\/cancel\s+appointments?\s+during\s+the\s+call\b|book\s+a\s+service\s+appointment|only\s+say\s+an\s+appointment\s+is\s+booked/i],
  ["guided setup call", /\bguided\s+setup\s+call\b/i],
  ["dashboard booking link label", /\bBooking\s+Link\b/i],
  ["manual callback and booking", /manual\s+callback\s+and\s+booking/i],
  ["conversion booking or lead", /calls\s*→\s*booking\s+or\s+lead/i],
  ["claim booked for time", /\bbooked\s+for\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)/i],
  ["upcoming appointment", /upcoming\s+appointment/i],
  ["upcoming appointments", /upcoming\s+appointments/i],
  ["confirmed appointment language", /you're\s+all\s+confirmed/i],
  ["cancelled appointment language", /appointment\s+has\s+been\s+cancelled/i],
  ["reschedule appointment language", /\bpress\s+2\s+to\s+reschedule\b/i],
  ["scheduling as AI-handled work", /callbacks\s*[·-]\s*follow-ups\s*[·-]\s*scheduling/i],
  ["calendar booking capability", /calendar\s+booking\s+capability/i],
  ["silent booking", /use\s+(?:the\s+)?calendar\b.{0,40}\bsilently/i],
  ["claim booked after booking succeeds", /say\s+it\s+is\s+booked\s+after\s+(?:the\s+)?booking\s+succeeds/i],
  ["routed live transfer", /routed\s+live\s+transfer/i],
  ["live bridge completed", /live\s+bridge\s+completed/i],
  ["live escalation capability", /can\s+receive\s+live\s+escalations/i],
  ["live escalation metric", /No\s+escalations/i],
  ["live demo submission", /live\s+demo\s+submission/i],
  ["No-nonsense dispatch", /No-nonsense\s+dispatch/i],
  ["dispatch real workers", /dispatch\s+real\s+workers/i],
  ["owner or dispatcher", /owner\s+or\s+dispatcher/i],
  ["Owner / Dispatcher", /Owner\s*\/\s*Dispatcher/i],
];

const allowedNegativeContext =
  /\b(not|never|no|without|disabled|excluded|removed|replace|replaces|out of|does not include|do not promise|do not offer|deferred|unnecessary|not needed|irrelevant|optional only|no active product flow|intentionally narrow|must avoid|skipped)\b/i;

const failures = [];
const noNegativeContextLabels = new Set(["No missed calls", "Zero missed calls", "0 missed inbound calls"]);

const hasAllowedNegativeContext = (line, pattern) => {
  const match = line.match(pattern);
  if (!match || typeof match.index !== "number") return false;
  const start = Math.max(0, match.index - 48);
  const end = Math.min(line.length, match.index + match[0].length + 48);
  return allowedNegativeContext.test(line.slice(start, end));
};

for (const filePath of files) {
  if (!fs.existsSync(filePath)) continue;

  const relPath = path.relative(repoRoot, filePath);
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const [label, pattern] of bannedClaims) {
      if (pattern.test(line) && (noNegativeContextLabels.has(label) || !hasAllowedNegativeContext(line, pattern))) {
        failures.push(`${relPath}:${index + 1}: ${label}`);
      }
    }
  });
}

if (failures.length > 0) {
  console.error("FAIL excluded texting/dispatcher/scheduling promises found in SMIRK copy or prompts:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`OK no excluded texting/dispatcher/scheduling promises found in ${files.length} SMIRK copy/prompt files`);
