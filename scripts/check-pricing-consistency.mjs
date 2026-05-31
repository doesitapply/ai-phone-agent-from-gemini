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
expect(serverHas("price: 197"), 'server canonical starter price is not $197');
expect(serverHas("name: 'SMIRK AI Pro'"), 'server canonical pro plan name is not SMIRK AI Pro');
expect(serverHas("price: 397"), 'server canonical pro price is not $397');
expect(serverHas("name: 'SMIRK AI Agency'"), 'server canonical agency plan name is not SMIRK AI Agency');
expect(serverHas("price: 697"), 'server canonical agency price is not $697');
expect(serverHas("cta: 'Start Starter Plan'"), 'starter CTA is out of sync');
expect(serverHas("cta: 'Start Pro Plan'"), 'pro CTA is out of sync');
expect(serverHas("cta: 'Start Agency Plan'"), 'agency CTA is out of sync');
expect(serverHas("features: ['Smart voicemail', 'Missed-call recovery', 'Lead capture', 'Owner email alerts', 'Call summaries', 'Basic dashboard access']"), 'starter features still imply texting or are out of sync');

expect(appHas('if (pathname === "/pricing")'), 'public pricing page route is missing');
expect(appHas('if (pathname === "/success")'), 'public success page route is missing');
expect(appHas('if (pathname === "/cancel")'), 'public cancel page route is missing');
expect(appHas('function PublicSuccessPage()'), 'public success page component is missing');
expect(appHas('function PublicCancelPage()'), 'public cancel page component is missing');
expect(appHas('Payment received'), 'public success page headline is out of sync');
expect(appHas('Your SMIRK setup is being prepared'), 'public success page activation copy is out of sync');
expect(appHas('Checkout canceled'), 'public cancel page headline is out of sync');
expect(appHas('No charge was made'), 'public cancel page no-charge copy is out of sync');
expect(appHas('Starter ($197/mo) · Pro ($397/mo) · Agency ($697/mo) — simple monthly plans, no trial maze'), 'dashboard upgrade CTA pricing copy is out of sync');
expect(appHas('starter: "Starter — $197/mo"'), 'workspace plan label for starter is out of sync');
expect(appHas('pro: "Pro — $397/mo"'), 'workspace plan label for pro is out of sync');
expect(appHas('enterprise: "Agency — $697/mo"'), 'workspace plan label for agency is out of sync');
expect(saasHas('starter:    { calls: 500,  minutes: 1000, agents: 3,  label: "Starter — $197/mo" }'), 'workspace starter limits are out of sync');
expect(saasHas('pro:        { calls: 2000, minutes: 5000, agents: 9,  label: "Pro — $397/mo" }'), 'workspace pro limits are out of sync');
expect(saasHas('enterprise: { calls: -1,   minutes: -1,   agents: -1, label: "Agency — $697/mo" }'), 'workspace agency limits are out of sync');

if (process.exitCode) process.exit(process.exitCode);
console.log('OK pricing copy matches canonical live plan values');
