#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  buildLaunchTouchApproval,
  launchTouchDraftSubject,
  sha256Text,
  validateLaunchTouchExecutionApproval,
} from "./lib/launch-touch-approval.mjs";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const companyNameFilters = args
  .filter((arg) => arg.startsWith("--company="))
  .map((arg) => String(arg.slice("--company=".length) || "").trim())
  .filter(Boolean);
const companyNameFilter = companyNameFilters.length === 1 ? companyNameFilters[0] : "";
const maxPacketRows = 200;
const defaultLimit = companyNameFilters.length > 0 ? String(companyNameFilters.length) : "20";
const limit = Math.max(1, Math.min(maxPacketRows, Number.parseInt(limitArg?.slice("--limit=".length) || defaultLimit, 10) || Number(defaultLimit)));
const outputDir = path.resolve("output/launch-touch-packets");
const packetNameSuffix = companyNameFilters.length === 1
  ? `-${slugForFile(companyNameFilter)}`
  : companyNameFilters.length > 1
    ? `-selected-${sha256Text(companyNameFilters.join("\n")).slice(0, 10)}`
    : "";
const packetStem = `first-${limit}${packetNameSuffix}-manual-touch`;
const markdownPath = path.join(outputDir, `${packetStem}-packet.md`);
const csvPath = path.join(outputDir, `${packetStem}-packet.csv`);
const executionCsvPath = path.join(outputDir, `${packetStem}-execution.csv`);
const approvalManifestPath = path.join(outputDir, `${packetStem}-approval.json`);
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

function slugForFile(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "selected";
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
  const greeting = firstName === "team" ? `${company} team` : firstName;
  const variant = String(row.message_variant || "");
  if (variant.includes("urgent_job_calls") || variant.includes("trade")) {
    return [
      `Subject: Capturing urgent ${vertical} calls`,
      "",
      `Hi ${greeting},`,
      "",
      `I'm testing SMIRK with ${vertical} businesses that want a simple backup path for urgent callers who reach you when the office is busy, after-hours, or while crews are already on jobs.`,
      "",
      "The narrow use case is not a chatbot. It captures the caller's issue, urgency, service area, callback window, and sends the owner/operator a callback-ready summary with dashboard proof.",
      "",
      "Would one review-only proof call be useful, or should I leave this off your plate?",
      "",
      "Proof page:",
      launchUrl,
    ].join("\n");
  }
  if (variant.includes("after_hours")) {
    return [
      `Subject: After-hours call recovery for ${company}`,
      "",
      `Hi ${firstName},`,
      "",
      "I'm testing SMIRK for home-service teams that want a simple backup path for urgent callers who reach you when the office is busy, after-hours, or while crews are already on jobs.",
      "",
      "The narrow use case is not a chatbot. It captures the caller's issue, urgency, service area, callback window, and sends the owner/operator a callback-ready summary with dashboard proof.",
      "",
      `Would a 10-minute review-only proof walkthrough be useful for ${company}?`,
      "",
      `See the sprint: ${launchUrl}`,
    ].join("\n");
  }
  return [
    `Subject: Quick missed-call question for ${company}`,
    "",
    `Hi ${firstName},`,
    "",
    "I'm testing SMIRK with home-service businesses that want a simple backup path for urgent callers who reach you when the office is busy, after-hours, or while crews are already on jobs.",
    "",
    "The narrow use case is not a chatbot: a call to the dedicated recovery number can become a caller summary, owner alert, callback task, and dashboard proof instead of sitting in voicemail.",
    "",
    `Would one review-only proof call be useful for ${company}, or should I leave this off your plate?`,
    "",
    `Start here: ${launchUrl}`,
  ].join("\n");
}

function draftSubject(row) {
  return launchTouchDraftSubject(draftFor(row));
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
  const missing = rows.filter((row) => !row.company || !row.channel || !row.contact_url || !row.vertical || !row.region);
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
    row.source_url,
    row.contact_url,
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

function renderMarkdown(rows, files, approval, generatedAt) {
  const lines = [
    "# SMIRK First Manual Touch Packet",
    "",
    `Generated: ${generatedAt}`,
    `Rows: ${rows.length}`,
    "",
    "## Exact Outreach Approval Boundary",
    "",
    "- Status: prepared only; no outreach is approved or sent by this packet.",
    `- Approval payload SHA-256: \`${approval.payload_sha256}\``,
    "- The hash binds the ordered target names, channels, public contact paths, and exact individualized drafts below.",
    "- Any target, channel, contact path, or copy change requires a newly generated hash and a new approval.",
    `- Canonical approval manifest: \`${path.basename(approvalManifestPath)}\``,
    "",
    "Exact approval token:",
    "",
    "```text",
    approval.exact_approval_token,
    "```",
    "",
    "## Guardrails",
    "",
    "- This packet does not send outreach.",
    "- Use public contact pages, public business email, LinkedIn, or human-approved phone only.",
    "- Do not use cold SMS, automated dialing, voicemail drops, purchased lists, or unsupported revenue claims.",
    "- If a contact form includes an SMS consent checkbox, do not opt in; skip the send if SMS consent is required.",
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
    const approvedTarget = approval.payload.targets[index];
    lines.push(`### ${index + 1}. ${row.company}`);
    lines.push("");
    lines.push(`- Vertical: ${titleCase(row.vertical)}`);
    lines.push(`- Region: ${row.region}`);
    lines.push(`- Launch region: ${launchRegionLabel(row)}`);
    lines.push(`- Channel: ${row.channel}`);
    lines.push(`- Message variant: ${row.message_variant}`);
    lines.push(`- Public source: ${row.source_url || row.contact_url}`);
    lines.push(`- Contact path: ${row.contact_url}`);
    lines.push(`- Exact draft SHA-256: \`${approvedTarget.draft_sha256}\``);
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
    "draft_sha256",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    const record = {
      ...row,
      launch_region: launchRegionLabel(row),
      draft_sha256: sha256Text(draftFor(row)),
    };
    lines.push(headers.map((header) => csvEscape(record[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function renderExecutionCsv(rows, approval) {
  const headers = [
    "send_order",
    "company",
    "vertical",
    "launch_region",
    "channel",
    "message_variant",
    "contact_url",
    "draft_subject",
    "draft_sha256",
    "approval_batch_sha256",
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
      draft_sha256: approval.payload.targets[index].draft_sha256,
      approval_batch_sha256: approval.payload_sha256,
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
if (new Set(companyNameFilters.map((name) => name.toLowerCase())).size !== companyNameFilters.length) {
  fail("company filters must be unique", { companies: companyNameFilters });
}
if (companyNameFilters.length > 0 && limit !== companyNameFilters.length) {
  fail("explicit company filters must match the requested packet limit", {
    requested_limit: limit,
    company_filters: companyNameFilters.length,
  });
}
const selected = companyNameFilters.length > 0
  ? companyNameFilters.map((company) => {
    const matches = rows.filter((row) => companyKey(row) === company.toLowerCase());
    if (matches.length !== 1) {
      fail("company filter must match exactly one researched prospect", {
        company,
        matches: matches.length,
      });
    }
    return matches[0];
  })
  : selectPacketRows(rows);
if (selected.length < limit) {
  fail("not enough researched prospects for requested touch packet", { requested: limit, selected: selected.length });
}

let builtApproval;
try {
  builtApproval = buildLaunchTouchApproval(selected, draftFor);
} catch (error) {
  fail("could not build a safe launch touch approval manifest", {
    failures: error?.failures || [],
    error: error?.message || String(error),
  });
}
const { approval, manifest: approvalManifestObject, generatedAt } = builtApproval;
const markdown = renderMarkdown(selected, files, approval, generatedAt);
const csv = renderCsv(selected);
const executionCsv = renderExecutionCsv(selected, approval);
const approvalManifest = `${JSON.stringify(approvalManifestObject, null, 2)}\n`;
const draftText = selected.map((row) => draftFor(row)).join("\n\n");
if (/\b(send\s+texts?|automated\s+dial|voicemail\s+drop|purchased-list blasting)\b/i.test(draftText)) {
  fail("packet drafts contain forbidden send language");
}

if (checkOnly) {
  const requiredArtifacts = [markdownPath, csvPath, executionCsvPath, approvalManifestPath];
  const missingArtifacts = requiredArtifacts.filter((file) => !fs.existsSync(file));
  if (missingArtifacts.length > 0) {
    fail("launch touch packet artifacts are missing", {
      missing: missingArtifacts,
      next_action: "Generate the exact packet before checking its integrity. Packet generation is not outreach approval.",
    });
  }

  const existingExecutionRows = parseCsv(fs.readFileSync(executionCsvPath, "utf8"));
  const integrity = validateLaunchTouchExecutionApproval({
    rows: existingExecutionRows,
    executionFile: executionCsvPath,
  });
  if (!integrity.ok) {
    fail("launch touch packet approval integrity failed", {
      approval_manifest: integrity.manifestPath,
      failures: integrity.failures,
      owner_approval_proven: false,
    });
  }
  if (integrity.payloadSha256 !== approval.payload_sha256) {
    fail("launch touch packet is stale relative to current researched inputs or draft code", {
      existing_approval_payload_sha256: integrity.payloadSha256,
      current_approval_payload_sha256: approval.payload_sha256,
      owner_approval_proven: false,
      next_action: "Regenerate the packet and obtain a new exact approval token before any send.",
    });
  }
  const existingGeneratedAt = String(integrity.manifest.generated_at);
  const expectedMarkdown = renderMarkdown(selected, files, approval, existingGeneratedAt);
  if (fs.readFileSync(markdownPath, "utf8") !== expectedMarkdown) {
    fail("launch touch markdown packet does not match its canonical approval manifest", {
      markdown_path: markdownPath,
      owner_approval_proven: false,
    });
  }
  if (fs.readFileSync(csvPath, "utf8") !== csv) {
    fail("launch touch source packet CSV is stale or altered", {
      csv_path: csvPath,
      owner_approval_proven: false,
    });
  }
} else {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(markdownPath, markdown);
  fs.writeFileSync(csvPath, csv);
  fs.writeFileSync(executionCsvPath, executionCsv);
  fs.writeFileSync(approvalManifestPath, approvalManifest);
}

console.log(JSON.stringify({
  ok: true,
  check: checkOnly,
  company_filter: companyNameFilter || null,
  company_filters: companyNameFilters,
  approval_payload_sha256: approval.payload_sha256,
  exact_approval_token: approval.exact_approval_token,
  wrote: checkOnly ? [] : [markdownPath, csvPath, executionCsvPath, approvalManifestPath],
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
  max_packet_rows: maxPacketRows,
  approval_integrity_verified: checkOnly,
  owner_approval_proven: false,
}, null, 2));
