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
const executionCsvPath = path.join(outputDir, `first-${limit}-manual-touch-execution.csv`);
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

const primaryLaunchRegionOrder = [
  "reno_sparks_northern_nevada",
  "sacramento_greater_sacramento",
  "boise_treasure_valley",
];

const launchRegionOrder = [
  ...primaryLaunchRegionOrder,
  "salt_lake_wasatch_front",
  "fresno_central_valley",
];

const launchRegionLabels = {
  reno_sparks_northern_nevada: "Reno/Sparks/Northern Nevada",
  sacramento_greater_sacramento: "Sacramento/Greater Sacramento",
  boise_treasure_valley: "Boise/Treasure Valley",
  salt_lake_wasatch_front: "Salt Lake City/Wasatch Front",
  fresno_central_valley: "Fresno/Central Valley",
};

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

function verticalPhrase(value) {
  const key = String(value || "").toLowerCase();
  const phrases = {
    plumbing_hvac_electric: "home-service",
    hvac_plumbing_electric: "home-service",
    plumbing_hvac: "plumbing and HVAC",
    hvac_plumbing: "HVAC and plumbing",
    plumbing_electric: "plumbing and electrical",
    roofing_remodeling: "roofing and remodeling",
    hvac_refrigeration: "HVAC and refrigeration",
    auto_repair: "auto repair",
    garage_door: "garage door",
    pest_control: "pest control",
  };
  return phrases[key] || stateLabel(key || "home_service");
}

function companyKey(row) {
  return String(row.company || "").trim().toLowerCase();
}

function launchRegionKey(row) {
  const batch = `${row.batch || ""} ${row.input_file || ""}`.toLowerCase();
  if (/reno/.test(batch)) return "reno_sparks_northern_nevada";
  if (/sacramento/.test(batch)) return "sacramento_greater_sacramento";
  if (/boise/.test(batch)) return "boise_treasure_valley";
  if (/salt[-_\s]?lake/.test(batch)) return "salt_lake_wasatch_front";
  if (/fresno/.test(batch)) return "fresno_central_valley";

  const region = String(row.region || "").toLowerCase();
  if (/reno|sparks|northern nevada|tahoe/.test(region)) return "reno_sparks_northern_nevada";
  if (/sacramento/.test(region)) return "sacramento_greater_sacramento";
  if (/boise|treasure valley|garden city/.test(region)) return "boise_treasure_valley";
  if (/salt lake|wasatch/.test(region)) return "salt_lake_wasatch_front";
  if (/fresno|central valley/.test(region)) return "fresno_central_valley";
  return region.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function launchRegionLabel(row) {
  const key = launchRegionKey(row);
  return launchRegionLabels[key] || titleCase(key);
}

function verticalTokens(row) {
  return String(row.vertical || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function matchesVertical(row, vertical) {
  const tokens = verticalTokens(row);
  const wanted = String(vertical || "").toLowerCase();
  if (wanted === "electrician") return tokens.includes("electrician") || tokens.includes("electrical");
  if (wanted === "handyman") return tokens.includes("handyman") || tokens.includes("remodeling");
  return tokens.includes(wanted);
}

function firstNameOrTeam(ownerContact) {
  const value = String(ownerContact || "").trim();
  if (!value || /^public_|unknown/i.test(value)) return "team";
  return value.split(/\s+/)[0] || "team";
}

function draftFor(row) {
  const firstName = firstNameOrTeam(row.owner_contact);
  const vertical = verticalPhrase(row.vertical);
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

function draftSubject(row) {
  return draftFor(row).split(/\r?\n/)[0]?.replace(/^Subject:\s*/i, "").trim() || "";
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
  const byRegion = new Map();
  for (const row of rows) {
    const key = launchRegionKey(row);
    if (!byRegion.has(key)) byRegion.set(key, []);
    byRegion.get(key).push(row);
  }

  const sortedRegionRows = (regionRows) => {
    const ordered = [];
    const seen = new Set();
    for (const vertical of verticalOrder) {
      for (const row of regionRows) {
        const id = companyKey(row);
        if (!id || seen.has(id) || !matchesVertical(row, vertical)) continue;
        ordered.push(row);
        seen.add(id);
      }
    }
    for (const row of regionRows) {
      const id = companyKey(row);
      if (!id || seen.has(id)) continue;
      ordered.push(row);
      seen.add(id);
    }
    return ordered;
  };

  const availableRegions = new Set([...byRegion.keys()]);
  const targetRegions = primaryLaunchRegionOrder.filter((region) => availableRegions.has(region));
  const fallbackRegions = launchRegionOrder
    .filter((region) => availableRegions.has(region) && !targetRegions.includes(region))
    .concat([...availableRegions].filter((region) => !launchRegionOrder.includes(region)));
  const regionQueue = targetRegions.length >= 2
    ? targetRegions
    : [...targetRegions, ...fallbackRegions].slice(0, Math.max(2, targetRegions.length || 1));
  const laterRegions = fallbackRegions.filter((region) => !regionQueue.includes(region));
  const queues = new Map([...byRegion.entries()].map(([region, regionRows]) => [region, sortedRegionRows(regionRows)]));

  const selected = [];
  const seen = new Set();

  const takeRoundRobin = (regions) => {
    let progressed = true;
    while (selected.length < limit && progressed) {
      progressed = false;
      for (const region of regions) {
        const queue = queues.get(region) || [];
        let row = queue.shift();
        while (row && seen.has(companyKey(row))) row = queue.shift();
        if (!row) continue;
        selected.push(row);
        seen.add(companyKey(row));
        progressed = true;
        if (selected.length >= limit) return;
      }
    }
  };

  takeRoundRobin(regionQueue);
  if (selected.length >= limit) return selected;
  if (selected.length < limit) takeRoundRobin(laterRegions);
  if (selected.length >= limit) return selected;
  for (const row of rows) {
    const id = companyKey(row);
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
    "## Human Execution Log",
    "",
    `- Open \`${path.basename(executionCsvPath)}\` beside this packet while sending.`,
    "- Fill `sent_at`, `human_sender`, and `actual_contact_path` only after a human sends the touch.",
    "- Use `response_status` values: `no_response`, `auto_reply`, `interested`, `qualified`, `not_interested`, `bad_fit`, `do_not_contact`, or `bounce`.",
    "- Count `qualified` only when the owner/operator confirms missed calls matter, asks for proof, asks about pricing/setup, starts checkout, or introduces another qualified operator.",
    "- If the contact path looks like SMS, an automated dialer, a purchased list, or a voicemail drop, do not send. Set `skip_reason` and leave `sent_at` blank.",
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
    lines.push(`- Launch region: ${launchRegionLabel(row)}`);
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
    "launch_region",
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
    lines.push(headers.map((header) => csvEscape(header === "launch_region" ? launchRegionLabel(row) : row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function renderExecutionCsv(rows) {
  const headers = [
    "send_order",
    "company",
    "vertical",
    "launch_region",
    "channel",
    "message_variant",
    "contact_url",
    "draft_subject",
    "human_sender",
    "actual_contact_path",
    "sent_at",
    "touch_logged_at",
    "next_state_after_send",
    "touch_count_delta",
    "spend_cents_delta",
    "response_status",
    "qualified_reason",
    "objection",
    "proof_walkthrough_status",
    "checkout_status",
    "activation_status",
    "skip_reason",
    "notes",
  ];
  const lines = [headers.join(",")];
  rows.forEach((row, index) => {
    const record = {
      send_order: index + 1,
      company: row.company,
      vertical: row.vertical,
      launch_region: launchRegionLabel(row),
      channel: row.channel,
      message_variant: row.message_variant,
      contact_url: row.contact_url,
      draft_subject: draftSubject(row),
      human_sender: "",
      actual_contact_path: "",
      sent_at: "",
      touch_logged_at: "",
      next_state_after_send: "researched",
      touch_count_delta: "0",
      spend_cents_delta: "0",
      response_status: "no_response",
      qualified_reason: "",
      objection: "",
      proof_walkthrough_status: "not_requested",
      checkout_status: "not_started",
      activation_status: "not_started",
      skip_reason: "",
      notes: "Draft row. After human-reviewed send, fill sender/path/timestamp, set next_state_after_send=contacted, and touch_count_delta=1. No SMS, auto-dial, voicemail drop, purchased list, or unsupported claims.",
    };
    lines.push(headers.map((header) => csvEscape(record[header])).join(","));
  });
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
const executionCsv = renderExecutionCsv(selected);
const draftText = selected.map((row) => draftFor(row)).join("\n\n");
if (/\b(send\s+texts?|automated\s+dial|voicemail\s+drop|purchased-list blasting)\b/i.test(draftText)) {
  fail("packet drafts contain forbidden send language");
}

if (!checkOnly) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(markdownPath, markdown);
  fs.writeFileSync(csvPath, csv);
  fs.writeFileSync(executionCsvPath, executionCsv);
}

console.log(JSON.stringify({
  ok: true,
  check: checkOnly,
  wrote: checkOnly ? [] : [markdownPath, csvPath, executionCsvPath],
  selected_rows: selected.length,
  by_vertical: selected.reduce((map, row) => {
    map[row.vertical] = (map[row.vertical] || 0) + 1;
    return map;
  }, {}),
  by_region: selected.reduce((map, row) => {
    map[row.region] = (map[row.region] || 0) + 1;
    return map;
  }, {}),
  by_launch_region: selected.reduce((map, row) => {
    const region = launchRegionLabel(row);
    map[region] = (map[region] || 0) + 1;
    return map;
  }, {}),
  note: "No outreach is sent by this packet generator.",
}, null, 2));
