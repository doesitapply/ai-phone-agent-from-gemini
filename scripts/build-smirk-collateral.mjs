#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outDir = path.resolve("output/marketing/smirk-collateral");
fs.mkdirSync(outDir, { recursive: true });

const css = `
  :root {
    --ink: #161a18;
    --coal: #17201b;
    --line: #25352c;
    --green: #00c875;
    --mint: #e9fff3;
    --amber: #f0a818;
    --paper: #f7faf6;
    --soft: #edf4ee;
    --muted: #5c695f;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #d9ded9; color: var(--ink); font-family: Inter, Arial, Helvetica, sans-serif; }
  @page { size: Letter; margin: 0; }
  .sheet {
    width: 8.5in;
    min-height: 11in;
    background: #ffffff;
    margin: 0 auto;
    padding: 0.48in;
    display: flex;
    flex-direction: column;
    gap: 0.22in;
  }
  .email {
    width: 600px;
    min-height: 560px;
    background: #ffffff;
    margin: 0 auto;
    padding: 32px;
  }
  .brand { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
  .mark { display: flex; align-items: center; gap: 12px; font-weight: 900; letter-spacing: 0; }
  .logo {
    width: 42px; height: 42px; background: var(--green); color: #04120b;
    display: grid; place-items: center; font-weight: 900; font-size: 23px;
    clip-path: polygon(0 0, 100% 0, 100% 72%, 72% 100%, 0 100%);
  }
  .brand-name { font-size: 27px; line-height: 1; }
  .tag { font-size: 11px; font-weight: 800; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; }
  .hero {
    background: var(--coal); color: #ffffff; border: 2px solid var(--line);
    padding: 34px; min-height: 2.25in; display: flex; flex-direction: column; justify-content: space-between;
  }
  h1 { margin: 0; font-size: 48px; line-height: 0.98; letter-spacing: 0; }
  h2 { margin: 0; font-size: 30px; line-height: 1.02; letter-spacing: 0; }
  h3 { margin: 0; font-size: 17px; line-height: 1.15; letter-spacing: 0; }
  p { margin: 0; font-size: 15px; line-height: 1.45; }
  .hero p { max-width: 6.8in; color: #d8e4db; font-size: 17px; }
  .grid { display: grid; gap: 14px; }
  .grid-2 { grid-template-columns: 1fr 1fr; }
  .grid-3 { grid-template-columns: repeat(3, 1fr); }
  .panel { border: 1.5px solid #cfd9d0; background: var(--paper); padding: 18px; }
  .panel.dark { background: var(--coal); border-color: var(--line); color: #ffffff; }
  .panel.dark p, .panel.dark .muted { color: #d8e4db; }
  .label { font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 7px; }
  .big { font-size: 25px; line-height: 1.08; font-weight: 900; }
  .muted { color: var(--muted); }
  .checks { display: grid; gap: 9px; margin-top: 10px; }
  .check { display: grid; grid-template-columns: 18px 1fr; gap: 9px; align-items: start; font-size: 14px; line-height: 1.3; }
  .dot { width: 14px; height: 14px; margin-top: 2px; background: var(--green); border: 2px solid #062317; }
  .steps { display: grid; gap: 10px; counter-reset: step; }
  .step { display: grid; grid-template-columns: 36px 1fr; gap: 12px; align-items: start; padding: 12px; border: 1.5px solid #cfd9d0; background: #fff; }
  .step::before {
    counter-increment: step; content: counter(step); width: 36px; height: 36px;
    display: grid; place-items: center; background: var(--green); color: #03140b; font-weight: 900;
  }
  .cta {
    display: grid; grid-template-columns: 1fr auto; gap: 18px; align-items: center;
    border: 2px solid var(--coal); padding: 18px 20px; background: var(--mint);
  }
  .url { font-weight: 900; font-size: 21px; white-space: nowrap; }
  .price { font-weight: 900; font-size: 36px; line-height: 1; }
  .small { font-size: 12px; line-height: 1.35; }
  .tiny { font-size: 10px; line-height: 1.35; color: var(--muted); }
  .rule { height: 2px; background: var(--line); opacity: 0.18; }
  .email h1 { font-size: 34px; }
  .email .hero { min-height: 0; padding: 24px; }
  .email .cta { grid-template-columns: 1fr; }
`;

const shell = (title, body, mode = "sheet") => `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<main class="${mode}">
${body}
</main>
</body>
</html>`;

const brand = `<div class="brand">
  <div class="mark"><div class="logo">S</div><div><div class="brand-name">SMIRK</div><div class="tag">Missed-call recovery</div></div></div>
  <div class="tag">Home services first</div>
</div>`;

const flyer = shell("SMIRK missed-call recovery flyer", `
${brand}
<section class="hero">
  <h1>Catch urgent calls when your team is busy.</h1>
  <p>SMIRK gives home-service businesses a backup path for callers who reach you after-hours, during rush windows, or while crews are already on jobs.</p>
</section>
<section class="grid grid-3">
  <div class="panel"><div class="label">Captures</div><div class="big">Issue, urgency, area, callback window.</div></div>
  <div class="panel"><div class="label">Alerts</div><div class="big">Owner-ready summary by email and dashboard.</div></div>
  <div class="panel"><div class="label">Proof</div><div class="big">Call record, task queue, next action.</div></div>
</section>
<section class="grid grid-2">
  <div class="panel dark">
    <div class="label">Built for</div>
    <div class="checks">
      <div class="check"><span class="dot"></span><span>Plumbing, HVAC, electrical, roofing, remodeling, and handyman crews.</span></div>
      <div class="check"><span class="dot"></span><span>Dedicated recovery number with smart voicemail and callback-ready capture.</span></div>
      <div class="check"><span class="dot"></span><span>Owners who want callback-ready details without replacing their team.</span></div>
    </div>
  </div>
  <div class="panel">
    <div class="label">Not this</div>
    <p>Not a cold-texting campaign. Not automated phone spam. Not a promise that every missed call is lost revenue.</p>
    <div class="rule" style="margin: 18px 0;"></div>
    <div class="label">This</div>
    <p>A practical missed-call recovery layer that helps urgent callers leave useful job details and gives the owner/operator a clean callback queue.</p>
  </div>
</section>
<section class="cta">
  <div>
    <div class="label">See the proof loop</div>
    <div class="url">smirkcalls.com/launch</div>
    <p class="small muted" style="margin-top: 8px;">Review-only proof calls are available by request. No cold SMS in this launch sprint.</p>
  </div>
  <div>
    <div class="label">Starter</div>
    <div class="price">$197/mo</div>
  </div>
</section>
<p class="tiny">Use current screenshots and product behavior only. Do not add unsupported revenue guarantees, loss claims, or unlimited usage claims.</p>
`);

const leavebehind = shell("SMIRK proof loop handout", `
${brand}
<section class="hero">
  <h1>What happens after a missed call?</h1>
  <p>SMIRK turns a caller's rough voicemail moment into a clear follow-up record an owner can act on.</p>
</section>
<section class="steps">
  <div class="step"><div><h3>Caller reaches the dedicated SMIRK recovery number.</h3><p class="muted">Prove the capture and callback loop before directing real missed calls to it.</p></div></div>
  <div class="step"><div><h3>SMIRK captures the job context.</h3><p class="muted">Issue, urgency, service area, caller details, and requested callback window.</p></div></div>
  <div class="step"><div><h3>The owner/operator gets a callback-ready summary.</h3><p class="muted">The alert is written for action, not for decoration.</p></div></div>
  <div class="step"><div><h3>A task lands in the dashboard.</h3><p class="muted">Open recovery work stays visible until somebody handles it.</p></div></div>
  <div class="step"><div><h3>The proof view shows what happened.</h3><p class="muted">Call status, summary, task state, and the next action are visible without exposing private details in marketing assets.</p></div></div>
</section>
<section class="grid grid-2">
  <div class="panel">
    <div class="label">Guardrails</div>
    <p>No cold SMS. No automated phone spam. No uncapped testing. No unsupported money claims.</p>
  </div>
  <div class="panel dark">
    <div class="label">Best fit</div>
    <p>Owner-operated home-service businesses that care about urgent callback details after-hours or during busy jobs.</p>
  </div>
</section>
<section class="cta">
  <div>
    <div class="label">Proof page</div>
    <div class="url">smirkcalls.com/launch</div>
  </div>
  <div class="small"><strong>Ask for:</strong><br>one review-only proof call, no send automation.</div>
</section>
`);

const emailInsert = shell("SMIRK email insert", `
${brand}
<section class="hero">
  <h1>Missed-call recovery for home services.</h1>
  <p>For urgent callers who reach you when the office is busy, after-hours, or while crews are already on jobs.</p>
</section>
<section class="panel" style="margin-top: 18px;">
  <div class="label">SMIRK captures</div>
  <div class="checks">
    <div class="check"><span class="dot"></span><span>Caller issue and urgency.</span></div>
    <div class="check"><span class="dot"></span><span>Service area and callback window.</span></div>
    <div class="check"><span class="dot"></span><span>Owner/operator alert and dashboard proof.</span></div>
  </div>
</section>
<section class="cta" style="margin-top: 18px;">
  <div>
    <div class="label">Review the proof loop</div>
    <div class="url">smirkcalls.com/launch</div>
    <p class="small muted" style="margin-top: 8px;">Not a chatbot replacement. Not a cold SMS campaign.</p>
  </div>
</section>
`, "email");

const assets = [
  { id: "smirk-flyer-letter", html: flyer, width: 1275, height: 1650, pdf: true },
  { id: "smirk-proof-loop-handout", html: leavebehind, width: 1275, height: 1650, pdf: true },
  { id: "smirk-email-insert", html: emailInsert, width: 600, height: 560, pdf: false },
];

const usage = `# SMIRK Collateral Kit

Generated by \`npm run build:smirk-collateral\`.

Use these files:
- \`smirk-flyer-letter.pdf\` for print handouts.
- \`smirk-flyer-letter.png\` for email attachments or quick previews.
- \`smirk-proof-loop-handout.pdf\` for owner conversations.
- \`smirk-proof-loop-handout.png\` for email attachments or quick previews.
- \`smirk-email-insert.png\` for short outreach emails.

Safe positioning:
- Missed-call recovery for home-service businesses.
- Backup path for urgent callers when the office is busy, after-hours, or crews are on jobs.
- Captures issue, urgency, service area, callback window, owner/operator alert, and dashboard proof.

Do not add:
- "You are losing money."
- "Critical leaks."
- "Guaranteed revenue."
- "Free labor."
- "AI replaces your receptionist."
- SMS-first language.

Live-send guardrail:
These assets are for review, print, and approved manual outreach only. Do not auto-send email, SMS, Telegram, or paid ads without an explicit approval for that exact gate.
`;

for (const asset of assets) {
  fs.writeFileSync(path.join(outDir, `${asset.id}.html`), asset.html);
}
fs.writeFileSync(path.join(outDir, "README.md"), usage);

const browser = await chromium.launch();
try {
  for (const asset of assets) {
    const page = await browser.newPage({ viewport: { width: asset.width, height: asset.height }, deviceScaleFactor: 1 });
    await page.setContent(asset.html, { waitUntil: "load" });
    await page.screenshot({ path: path.join(outDir, `${asset.id}.png`), fullPage: true });
    if (asset.pdf) {
      await page.pdf({
        path: path.join(outDir, `${asset.id}.pdf`),
        format: "Letter",
        printBackground: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      });
    }
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`Wrote SMIRK collateral assets to ${outDir}`);
