#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ZipArchive } = require("archiver");

const args = process.argv.slice(2);
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const limit = Math.max(1, Math.min(200, Number.parseInt(limitArg?.slice("--limit=".length) || "20", 10) || 20));
const outputDir = path.resolve("output");
const packetDir = path.join(outputDir, "launch-touch-packets");
const archiveDir = path.join(outputDir, "launch-packet-archives");
const latestZipPath = path.join(outputDir, "smirk-launch-packet.zip");
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const archivePath = path.join(archiveDir, `smirk-launch-packet-${timestamp}.zip`);
const packetStem = `first-${limit}-manual-touch`;
const packetFiles = [
  {
    path: path.join(packetDir, `${packetStem}-packet.md`),
    name: `${packetStem}-packet.md`,
    kind: "markdown packet",
  },
  {
    path: path.join(packetDir, `${packetStem}-packet.csv`),
    name: `${packetStem}-packet.csv`,
    kind: "source packet csv",
  },
  {
    path: path.join(packetDir, `${packetStem}-execution.csv`),
    name: `${packetStem}-execution.csv`,
    kind: "human execution csv",
  },
];

const commands = [
  ["npm", ["run", "-s", "check:billing-lifecycle"]],
  ["npm", ["run", "-s", "import:launch-ledger:all:validate"]],
  ["npm", ["run", "-s", "write:launch-touch-packet", "--", `--limit=${limit}`]],
  ["npm", ["run", "-s", "check:launch-touch-execution", "--", path.relative(process.cwd(), packetFiles[2].path)]],
];

function fail(error, detail = {}) {
  console.error(JSON.stringify({ ok: false, error, ...detail }, null, 2));
  process.exit(1);
}

function runCommand([cmd, cmdArgs]) {
  const display = [cmd, ...cmdArgs].join(" ");
  console.log(`\n=== ${display} ===`);
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit", env: process.env });
  if (result.error) fail("launch-zip-command-error", { command: display, message: result.error.message });
  if (result.status !== 0) fail("launch-zip-command-failed", { command: display, status: result.status, signal: result.signal });
  return display;
}

function fileSummary(file) {
  const stat = fs.statSync(file.path);
  return {
    name: file.name,
    kind: file.kind,
    source_path: path.relative(process.cwd(), file.path),
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function writeZip(manifest, handoffText) {
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.rmSync(archivePath, { force: true });

  const output = fs.createWriteStream(archivePath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  const completion = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", (err) => {
      if (err.code === "ENOENT") return;
      reject(err);
    });
    archive.on("error", reject);
  });

  archive.pipe(output);
  for (const file of packetFiles) {
    archive.file(file.path, { name: file.name });
  }
  archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: "manifest.json" });
  archive.append(handoffText, { name: "telegram-handoff.txt" });
  archive.finalize();
  await completion;
}

const ran = commands.map(runCommand);
for (const file of packetFiles) {
  if (!fs.existsSync(file.path)) fail("launch-packet-file-missing", { missing: path.relative(process.cwd(), file.path) });
  const stat = fs.statSync(file.path);
  if (!stat.isFile() || stat.size <= 0) fail("launch-packet-file-empty", { file: path.relative(process.cwd(), file.path) });
}

const manifest = {
  generated_at: new Date().toISOString(),
  repo: path.resolve("."),
  branch: spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" }).stdout.trim(),
  commit: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  limit,
  packet_files: packetFiles.map(fileSummary),
  commands_run: ran,
  latest_zip_path: latestZipPath,
  no_side_effects: [
    "No outreach was sent.",
    "No SMS was sent.",
    "No calls were placed.",
    "No paid spend was started.",
    "No Stripe smoke or production cleanup apply was run.",
    "The execution CSV is a human handoff sheet; it must not be counted until a human sends and logs touches.",
  ],
  telegram_command: "/process-packet Here is the fresh SMIRK 20-row execution packet. Parse the CSV, structure the outreach sequences, and standby for human-approved trigger execution.",
};

const handoffText = [
  "SMIRK Telegram / Hermes Handoff",
  "",
  `Zip file: ${latestZipPath}`,
  `Archive copy: ${archivePath}`,
  "",
  "Computer Use directive:",
  "1. Open Telegram.",
  "2. Search for the Hermes chat.",
  `3. Attach ${latestZipPath}.`,
  "4. Send this exact message:",
  manifest.telegram_command,
  "5. Wait until Telegram shows the file upload as complete before ending the frame.",
  "",
  "Guardrails:",
  "- This zip does not authorize sending outreach.",
  "- This zip does not authorize SMS, automated dialing, paid spend, proof calls, Stripe smoke, or production data deletion.",
  "- Hermes should prepare drafts and standby for human-approved trigger execution only.",
  "",
].join("\n");

await writeZip(manifest, handoffText);
fs.copyFileSync(archivePath, latestZipPath);

const archiveStat = fs.statSync(archivePath);
const latestStat = fs.statSync(latestZipPath);

console.log(JSON.stringify({
  ok: true,
  archive_path: archivePath,
  latest_zip_path: latestZipPath,
  archive_bytes: archiveStat.size,
  latest_bytes: latestStat.size,
  archive_sha256: sha256(archivePath),
  latest_sha256: sha256(latestZipPath),
  packet_files: manifest.packet_files,
  telegram_command: manifest.telegram_command,
  note: "Zip is ready for manual or Computer Use transport. No outreach, SMS, calls, payments, paid spend, Stripe smoke, or production cleanup was triggered.",
}, null, 2));
