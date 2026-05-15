#!/usr/bin/env node
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const saas = fs.readFileSync(new URL('../src/saas.ts', import.meta.url), 'utf8');

const expect = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL ${msg}`);
    process.exitCode = 1;
  }
};

const serverHas = (snippet) => server.includes(snippet);
const appHas = (snippet) => app.includes(snippet);
const saasHas = (snippet) => saas.includes(snippet);

expect(serverHas('app.get("/api/pricing"'), 'pricing API route is not mounted at /api/pricing');
expect(serverHas("name: 'SMIRK AI Starter'"), 'server canonical starter plan name is not SMIRK AI Starter');
expect(serverHas("price: 299"), 'server canonical starter price is not $299');
expect(serverHas("name: 'SMIRK AI Pro'"), 'server canonical pro plan name is not SMIRK AI Pro');
expect(serverHas("price: 599"), 'server canonical pro price is not $599');
expect(serverHas("name: 'SMIRK AI Enterprise'"), 'server canonical enterprise plan name is not SMIRK AI Enterprise');
expect(serverHas("price: 1499"), 'server canonical enterprise price is not $1499');
expect(serverHas("cta: 'Start Starter Plan'"), 'starter CTA is out of sync');
expect(serverHas("cta: 'Start Pro Plan'"), 'pro CTA is out of sync');
expect(serverHas("cta: 'Start Enterprise Plan'"), 'enterprise CTA is out of sync');
expect(serverHas("features: ['AI call answering', 'Lead capture', 'Owner email alerts', 'Call summaries', 'Basic dashboard access']"), 'starter features still imply texting or are out of sync');

expect(appHas('if (pathname === "/pricing")'), 'public pricing page route is missing');
expect(appHas('if (pathname === "/success")'), 'public success page route is missing');
expect(appHas('Starter ($299/mo) · Pro ($599/mo) · Enterprise ($1499/mo) — simple monthly plans, no trial maze'), 'dashboard upgrade CTA pricing copy is out of sync');
expect(appHas('starter: "Starter — $299/mo"'), 'workspace plan label for starter is out of sync');
expect(appHas('pro: "Pro — $599/mo"'), 'workspace plan label for pro is out of sync');
expect(appHas('enterprise: "Enterprise — $1499/mo"'), 'workspace plan label for enterprise is out of sync');
expect(saasHas('starter:    { calls: 500,  minutes: 1000, agents: 3,  label: "Starter — $299/mo" }'), 'workspace starter limits are out of sync');
expect(saasHas('pro:        { calls: 2000, minutes: 5000, agents: 9,  label: "Pro — $599/mo" }'), 'workspace pro limits are out of sync');
expect(saasHas('enterprise: { calls: -1,   minutes: -1,   agents: -1, label: "Enterprise — $1499/mo" }'), 'workspace enterprise limits are out of sync');

if (process.exitCode) process.exit(process.exitCode);
console.log('OK pricing copy matches canonical live plan values');
