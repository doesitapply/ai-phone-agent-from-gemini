#!/usr/bin/env node
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('./railway.json', 'utf8'));
const healthcheckPath = String(config?.deploy?.healthcheckPath || '').trim();
const serverSource = fs.readFileSync('./server.ts', 'utf8');

if (!healthcheckPath) {
  console.error('FAIL railway.json is missing deploy.healthcheckPath');
  process.exit(1);
}

const escaped = healthcheckPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const routePattern = new RegExp(`app\\.(get|use)\\(\\s*["']${escaped}["']`);
const ok = routePattern.test(serverSource);

console.log(`Railway healthcheckPath: ${healthcheckPath}`);
console.log(`Route present in server.ts: ${ok ? 'yes' : 'no'}`);

if (!ok) {
  console.error(`FAIL ${healthcheckPath} is configured in railway.json but no matching route was found in server.ts`);
  process.exit(1);
}

console.log('OK Railway healthcheck path matches a live server route');
