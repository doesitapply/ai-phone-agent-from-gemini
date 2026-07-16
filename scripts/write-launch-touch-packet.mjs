#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const limit = Math.max(1, Math.min(100, Number.parseInt(limitArg?.slice("--limit=".length) || "20", 10) || 20));
const outputDir = path.resolve("output/launch-touch-packets");
const markdownPath = path.join(outputDir, `first-${limit}-manual-touch-packet.md`);
const csvPath = path.join(outputDir, `first-${limit}-manual-touch-packet.csv`);
const launchUrl = "https://smirkcalls.com/launch";

const verticalOrder = [
  "plumbing",
  "hvac",
  "roofing",
  "electrician",
  "handyman",
  "remodeling",
  "auto_repair",
  "landscaping",
  "pest_control",
  "garage_door",
];

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  const [headers = [], ...dataRows] = rows;
  return dataRows.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header.trim(), String(values[index] || "").trim()])),
  );
}

function csvEscape(value) {
  const text = String(value || "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toInt(value) {
  const num = Number.parseInt(String(value || "0"), 10);
  return Number.isFinite(num) ? Math.max(0, num) : 0;
}

function stateLabel(value) {
  return String(value || "home_service").replace(/_/g, " ");
}

function titleCase(value) {
  return stateLabel(value).replace(/\b\w/g, (char) => char.toUpperCase());
}

function firstNameOrTeam(ownerContact) {
  const value = String(ownerContact || "").trim();
  if (!value || /^public_|unknown/i.test(value)) return "team";
  return value.split(/\s+/)[0] || "team";
}

function draftFor(row) {
  const firstName = firstNameOrTeam(row.owner_contact);
  const vertical = titleCase(row.vertical).toLowerCase();
  const company = row.company;
  const variant = String(row.message_variant || "");
  if (variant.includes("urgent_job_calls") || variant.includes("trade")) {
    return [
      `Subject: Capturing urgent ${vertical} calls`,
      "",
      `Hi ${firstName},`,
      "",
      "I am testing SMIRK with home-service businesses that miss job calls while crews are already working.",
      "",
      `For ${vertical} teams, the narrow use case is catching the job details when a call gets missed: issue, urgency, service area, callback window, owner alert, and dashboard proof.`,
      "",
      `Would one proof call be useful for ${company}, or is missed-call recovery not a real problem for your team right now?`,
      "",
      `Proof page: ${launchUrl}`,
    ].join("\n");
  }
  if (variant.includes("after_hours")) {
    return [
      `Subject: After-hours call recovery for ${company}`,
      "",
      `Hi ${firstName},`,
      "",
      "I am testing SMIRK for home-service teams that need after-hours or busy-day calls turned into clear owner follow-up.",
      "",
      "The proof loop is simple: caller summary, owner alert, callback task, and dashboard proof. It is not a cold-texting campaign or a generic receptionist pitch.",
      "",
      `Would a 10-minute proof walkthrough be useful for ${company}?`,
      "",
      `See the sprint: ${launchUrl}`,
    ].join("\n");
  }
  return [
    `Subject: Quick missed-call question for ${company}`,
    "",
    `Hi ${firstName},`,
    "",
    "I am testing SMIRK with home-service businesses that miss job calls while crews are already working.",
    "",
    "The narrow use case: a missed or forwarded call becomes a caller summary, owner alert, callback task, and dashboard proof instead of sitting in voicemail.",
    "",
    `Would one proof call be useful for ${company}, or is missed-call recovery not a real problem for your team right now?`,
    "",
    `Start here: ${launchUrl}`,
  ].join("\n");
}

function loadProspects() {
  const dir = path.resolve("docs/launch");
  const files = fs.readdirSync(dir)
    .filter((file) => /^prospect-batch-.*\.csv$/.test(file))
    .sort()
    .map((file) => path.join("docs/launch", file));
  const rows = files.flatMap((file) => {
    const batch = path.basename(file, ".csv");
    return parseCsv(fs.readFileSync(path.resolve(file), "utf8")).map((row, index) => ({
      ...row,
      batch,
      input_file: file,
      input_index: index + 1,
    }));
  });
  return { files, rows };
}

function validateProspects(rows) {
  const missing = rows.filter((row) => !row.company || !row.contact_url || !row.vertical || !row.region);
  if (missing.length > 0) {
    fail("prospect rows are missing required packet fields", {
      count: missing.length,
      sample: missing.slice(0, 5).map((row) => ({ file: row.input_file, company: row.company })),
    });
  }

  const touched = rows.filter((row) => row.next_state !== "researched" || toInt(row.touch_count) !== 0 || toInt(row.spend_cents) !== 0);
  if (touched.length > 0) {
    fail("touch packet may only use researched zero-touch zero-spend rows", {
      count: touched.length,
      sample: touched.slice(0, 5).map((row) => ({
        company: row.company,
        next_state: row.next_state,
        touch_count: row.touch_count,
        spend_cents: row.spend_cents,
      })),
    });
  }

  const forbidden = rows.filter((row) => /\b(sms|text|auto[-_\s]?dial|voicemail[-_\s]?drop)\b/i.test([
    row.owner_contact,
    row.channel,
    row.message_variant,
    row.notes,
  ].join(" ")));
  if (forbidden.length > 0) {
    fail("touch packet input includes forbidden outreach language", {
      count: forbidden.length,
      sample: forbidden.slice(0, 5).map((row) => ({ company: row.company, channel: row.channel, message_variant: row.message_variant })),
    });
  }
}

function selectPacketRows(rows) {
  const byVertical = new Map();
  for (const row of rows) {
    const key = String(row.vertical || "unknown").split("_")[0];
    if (!byVertical.has(key)) byVertical.set(key, []);
    byVertical.get(key).push(row);
  }
  const selected = [];
  const seen = new Set();
  for (const vertical of verticalOrder) {
    const key = vertical.split("_")[0];
    const candidates = byVertical.get(key) || [];
    for (const row of candidates.slice(0, 4)) {
      const id = row.company.toLowerCase();
      if (seen.has(id)) continue;
      selected.push(row);
      seen.add(id);
      if (selected.length >= limit) return selected;
    }
  }
  for (const row of rows) {
    const id = row.company.toLowerCase();
    if (seen.has(id)) continue;
    selected.push(row);
    seen.add(id);
    if (selected.length >= limit) return selected;
  }
  return selected;
}

function renderMarkdown(rows, files) {
  const generatedAt = new Date().toISOString();
  const lines = [
    "# SMIRK First Manual Touch Packet",
    "",
    `Generated: ${generatedAt}`,
    `Rows: ${rows.length}`,
    "",
    "## Guardrails",
    "",
    "- This packet does not send outreach.",
    "- Use public contact pages, public business email, LinkedIn, or human-approved phone only.",
    "- Do not use cold SMS, automated dialing, voicemail drops, purchased lists, or unsupported revenue claims.",
    "- Log a touch in `/dashboard/launch` only after a human sends it.",
    "- If any company has a do-not-contact signal, skip it and log the objection.",
    "",
    "## Source Files",
    "",
    ...files.map((file) => `- ${file}`),
    "",
    "## Touch Queue",
    "",
  ];

  rows.forEach((row, index) => {
    lines.push(`### ${index + 1}. ${row.company}`);
    lines.push("");
    lines.push(`- Vertical: ${titleCase(row.vertical)}`);
    lines.push(`- Region: ${row.region}`);
    lines.push(`- Channel: ${row.channel}`);
    lines.push(`- Message variant: ${row.message_variant}`);
    lines.push(`- Public source: ${row.source_url || row.contact_url}`);
    lines.push(`- Contact path: ${row.contact_url}`);
    lines.push(`- Ledger state before touch: ${row.next_state}, touch_count=${toInt(row.touch_count)}, spend_cents=${toInt(row.spend_cents)}`);
    lines.push("");
    lines.push("Draft:");
    lines.push("");
    lines.push("```text");
    lines.push(draftFor(row));
    lines.push("```");
    lines.push("");
    lines.push("After human send:");
    lines.push("");
    lines.push("- Set next_state to `contacted`.");
    lines.push("- Increment touch_count by 1.");
    lines.push("- Keep spend_cents at 0.");
    lines.push("- Keep proof_walkthrough_status as `not_requested` unless they ask to see proof.");
    lines.push("");
  });

  return `${lines.join("\n")}\n`;
}

function renderCsv(rows) {
  const headers = [
    "company",
    "vertical",
    "region",
    "channel",
    "message_variant",
    "source_url",
    "contact_url",
    "next_state",
    "touch_count",
    "spend_cents",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

const { files, rows } = loadProspects();
validateProspects(rows);
const selected = selectPacketRows(rows);
if (selected.length < limit) {
  fail("not enough researched prospects for requested touch packet", { requested: limit, selected: selected.length });
}

const markdown = renderMarkdown(selected, files);
const csv = renderCsv(selected);
const draftText = selected.map((row) => draftFor(row)).join("\n\n");
if (/\b(send\s+texts?|automated\s+dial|voicemail\s+drop|purchased-list blasting)\b/i.test(draftText)) {
  fail("packet drafts contain forbidden send language");
}

if (!checkOnly) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(markdownPath, markdown);
  fs.writeFileSync(csvPath, csv);
}

console.log(JSON.stringify({
  ok: true,
  check: checkOnly,
  wrote: checkOnly ? [] : [markdownPath, csvPath],
  selected_rows: selected.length,
  by_vertical: selected.reduce((map, row) => {
    map[row.vertical] = (map[row.vertical] || 0) + 1;
    return map;
  }, {}),
  by_region: selected.reduce((map, row) => {
    map[row.region] = (map[row.region] || 0) + 1;
    return map;
  }, {}),
  note: "No outreach is sent by this packet generator.",
}, null, 2));
