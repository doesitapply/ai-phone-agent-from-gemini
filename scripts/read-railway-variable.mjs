#!/usr/bin/env node
import { readRailwayEnvValue } from "./railway-json.mjs";

const key = String(process.argv[2] || "").trim();
if (!key) {
  console.error("Usage: node scripts/read-railway-variable.mjs KEY");
  process.exit(2);
}

const value = readRailwayEnvValue(key, { quiet: true });
if (!value) process.exit(1);
process.stdout.write(value);
