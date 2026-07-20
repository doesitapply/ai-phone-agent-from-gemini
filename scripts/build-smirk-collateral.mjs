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
  .booklet { margin: 0 auto; width: 8.5in; background: #d9ded9; }
  .booklet .sheet { page-break-after: always; break-after: page; }
  .booklet .sheet:last-child { page-break-after: auto; break-after: auto; }
  .flyer-front, .flyer-back {
    gap: 0.105in;
    background: #fbfbf6;
    height: 11in;
    min-height: 11in;
    padding: 0.32in;
    overflow: hidden;
  }
  .flyer-front .grid, .flyer-back .grid { gap: 10px; }
  .flyer-front .panel, .flyer-back .panel { padding: 12px; }
  .flyer-front h2, .flyer-back h2 { font-size: 25px; }
  .flyer-front .big, .flyer-back .big { font-size: 22px; }
  .flyer-front p, .flyer-back p { font-size: 13px; line-height: 1.34; }
  .flyer-front .small, .flyer-back .small { font-size: 11px; }
  .flyer-front .tiny, .flyer-back .tiny { font-size: 8.5px; }
  .industrial-hero {
    background: #151916;
    color: #f8fff9;
    border: 4px solid #111;
    padding: 20px;
    min-height: 2.18in;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    position: relative;
    overflow: hidden;
  }
  .industrial-hero::after {
    content: "";
    position: absolute;
    inset: 12px;
    border: 1px solid rgba(255,255,255,0.16);
    pointer-events: none;
  }
  .industrial-hero h1 {
    font-family: Impact, Haettenschweiler, "Arial Black", sans-serif;
    font-size: 50px;
    line-height: 0.9;
    letter-spacing: 0;
    text-transform: uppercase;
    max-width: 7in;
  }
  .industrial-hero p {
    color: #dce9df;
    font-size: 14px;
    max-width: 6.9in;
    margin-top: 10px;
  }
  .stripe-label {
    align-self: flex-start;
    background: var(--green);
    color: #03140b;
    font-weight: 900;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 6px 10px;
    margin-bottom: 12px;
  }
  .feature-list { display: grid; gap: 7px; }
  .feature-row {
    display: grid;
    grid-template-columns: 112px 1fr;
    gap: 13px;
    padding: 8px 10px;
    background: #fff;
    border: 1.5px solid #ced8ce;
  }
  .feature-row strong {
    display: block;
    font-size: 11px;
    line-height: 1.1;
    text-transform: uppercase;
    color: #101512;
  }
  .feature-row span { font-size: 11.5px; line-height: 1.28; color: #29362d; }
  .phone-cta {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 18px;
    background: #00c875;
    color: #03140b;
    border: 4px solid #111;
    padding: 12px 16px;
  }
  .phone-number {
    font-family: Impact, Haettenschweiler, "Arial Black", sans-serif;
    font-size: 34px;
    line-height: 0.95;
    letter-spacing: 0;
    white-space: nowrap;
  }
  .comparison {
    width: 100%;
    border-collapse: collapse;
    background: #fff;
    border: 2px solid #111;
    font-size: 10.5px;
  }
  .comparison th {
    background: #161a18;
    color: #fff;
    text-align: left;
    padding: 7px 6px;
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .comparison td {
    border-top: 1px solid #cbd6ce;
    border-right: 1px solid #cbd6ce;
    padding: 6px;
    line-height: 1.18;
    vertical-align: top;
  }
  .comparison td:last-child { border-right: 0; }
  .comparison .win { background: #e9fff3; font-weight: 800; color: #083d25; }
  .mode-card {
    border: 2px solid #111;
    background: #fff;
    padding: 10px;
    min-height: 1.24in;
  }
  .mode-card h3 {
    font-family: Impact, Haettenschweiler, "Arial Black", sans-serif;
    font-size: 19px;
    text-transform: uppercase;
    margin-bottom: 6px;
  }
  .footer-band {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 18px;
    align-items: end;
    background: #151916;
    color: #fff;
    padding: 12px 16px;
    border: 3px solid #111;
  }
  .footer-band .muted { color: #bdcabe; }
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

const demoPhone = "(775) 420-4485";

const dualModeFrontBody = `
${brand.replace("Home services first", "Reno trades launch")}
<section class="industrial-hero">
  <div>
    <div class="stripe-label">For plumbers, HVAC, electricians, and busy trades</div>
    <h1>The $500 phone call you might have missed.</h1>
    <p>When a homeowner has water on the floor, no heat, or a job that cannot wait, they usually call until somebody answers. If you are under a sink, driving, or already on a job, the next shop on Google may get that call.</p>
  </div>
  <p><strong>Introducing SMIRK:</strong> a 24/7 frontline call-recovery layer for independent trade businesses in Reno.</p>
</section>
<section class="grid grid-2">
  <div class="panel dark">
    <div class="label">The expensive problem</div>
    <h2>Your phone is interrupting the highest-value person in the business.</h2>
    <p style="margin-top: 12px;">Sales calls, robocalls, simple questions, after-hours callbacks, and real emergency jobs all hit the same cell phone.</p>
  </div>
  <div class="panel">
    <div class="label">The no-barrier fix</div>
    <h2>SMIRK fits into your existing phone workflow.</h2>
    <p style="margin-top: 12px;">Use it as the front line or as missed-call backup. Calls are captured, summarized, and routed without making your crew learn new software.</p>
  </div>
</section>
<section class="feature-list">
  <div class="feature-row">
    <strong>Filters the noise</strong>
    <span>Routine callers, sales pitches, robocalls, and simple questions can be handled without interrupting the truck.</span>
  </div>
  <div class="feature-row">
    <strong>Finds the job</strong>
    <span>SMIRK asks for the issue, urgency, service area, and callback window so the owner gets a useful summary instead of a vague voicemail.</span>
  </div>
  <div class="feature-row">
    <strong>Transfers when it matters</strong>
    <span>In frontline mode, urgent calls can be routed toward your cell with an owner-confirmation step before connecting.</span>
  </div>
  <div class="feature-row">
    <strong>Looks professional</strong>
    <span>Small shops get a calm, consistent call experience even when the owner is in a crawlspace, in traffic, or standing next to a running truck.</span>
  </div>
  <div class="feature-row">
    <strong>Minimal setup</strong>
    <span>Forward calls to SMIRK as your main front line or as backup voicemail. Your staff keeps working the way they already work.</span>
  </div>
</section>
<section class="phone-cta">
  <div>
    <div class="label" style="color:#062317;">Try the demo line</div>
    <p class="small" style="font-weight:800;">Call as a stressed homeowner. Leave the job details. Review the summary and callback workflow.</p>
  </div>
  <div class="phone-number">${demoPhone}</div>
</section>
<p class="tiny">Forwarding and live-transfer behavior depends on phone-carrier setup and approved account configuration. This flyer avoids guaranteed revenue claims; the point is to recover and organize urgent caller details.</p>
`;

const dualModeBackBody = `
${brand.replace("Home services first", "Reno local")}
<section class="industrial-hero" style="min-height: 1.85in;">
  <div>
    <div class="stripe-label">Dual Mode Setup</div>
    <h1>Stop using field hours as a receptionist.</h1>
    <p>You do not need more interruptions. You need a front line that captures the job and only pulls you in when it matters.</p>
  </div>
</section>
<section>
  <h2>SMIRK vs. the traditional setup</h2>
  <table class="comparison" style="margin-top: 12px;">
    <thead>
      <tr>
        <th>Feature</th>
        <th>SMIRK</th>
        <th>Human answering service</th>
        <th>Free carrier voicemail</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Monthly cost</td>
        <td class="win">Founders local launch: $99/mo</td>
        <td>Often $300-$600+/mo</td>
        <td>$0</td>
      </tr>
      <tr>
        <td>Availability</td>
        <td class="win">24/7 routed capture</td>
        <td>Coverage and queues vary</td>
        <td>24/7 recording only</td>
      </tr>
      <tr>
        <td>Urgent live transfer</td>
        <td class="win">Owner-confirmed transfer path</td>
        <td>Possible, quality varies</td>
        <td>No</td>
      </tr>
      <tr>
        <td>Call filtering</td>
        <td class="win">Spam, sales, routine questions, and urgency triage</td>
        <td>Usually message-taking or broad bridging</td>
        <td>None</td>
      </tr>
      <tr>
        <td>Delay</td>
        <td class="win">Fast routed answer</td>
        <td>Queue and agent delay varies</td>
        <td>Caller waits through rings</td>
      </tr>
      <tr>
        <td>Follow-up record</td>
        <td class="win">Transcript, summary, urgency, task, dashboard proof</td>
        <td>Manual notes</td>
        <td>Audio message only</td>
      </tr>
    </tbody>
  </table>
</section>
<section class="grid grid-2">
  <div class="mode-card">
    <h3>Option A: Frontline Receptionist</h3>
    <p>SMIRK answers routed main-line calls, filters junk, captures job details, and can transfer confirmed urgent calls toward your cell phone with a confirmation step before connecting.</p>
  </div>
  <div class="mode-card">
    <h3>Option B: Missed-Call Backup</h3>
    <p>When you are under a sink, on another line, or done for the day, SMIRK answers, captures the emergency details, and sends an urgency-scored summary for callback.</p>
  </div>
</section>
<section class="grid grid-3">
  <div class="panel">
    <div class="label">Price</div>
    <div class="big">$99/mo</div>
    <p class="small muted" style="margin-top: 6px;">Founders local launch rate for the first batch of Reno shops.</p>
  </div>
  <div class="panel">
    <div class="label">Terms</div>
    <div class="big">Cancel anytime</div>
    <p class="small muted" style="margin-top: 6px;">No long contract. Keep it if it earns its place.</p>
  </div>
  <div class="panel">
    <div class="label">Setup</div>
    <div class="big">Phone-line friendly</div>
    <p class="small muted" style="margin-top: 6px;">Use forwarding/frontline routing or missed-call backup.</p>
  </div>
</section>
<section class="footer-band">
  <div>
    <h2>SMIRK</h2>
    <p class="small muted">Smart Missed-Call Recovery and Reception</p>
    <p class="small" style="margin-top: 8px;">1605 McKinley Drive, Reno, NV 89509 | https://smirkcalls.com</p>
  </div>
  <div style="text-align:right;">
    <div class="label" style="color:#bdcabe;">Call</div>
    <div class="phone-number" style="color:#00c875; font-size:34px;">${demoPhone}</div>
    <p class="tiny" style="color:#bdcabe; margin-top: 8px;">Built by Cameron Church. Reno local.</p>
  </div>
</section>
`;

const dualModeFlyer = shell("SMIRK dual mode trades flyer", `
<section class="sheet flyer-front">${dualModeFrontBody}</section>
<section class="sheet flyer-back">${dualModeBackBody}</section>
`, "booklet");

const dualModeFront = shell("SMIRK dual mode flyer front", dualModeFrontBody, "sheet flyer-front");
const dualModeBack = shell("SMIRK dual mode flyer back", dualModeBackBody, "sheet flyer-back");

const assets = [
  { id: "smirk-flyer-letter", html: flyer, width: 1275, height: 1650, pdf: true },
  { id: "smirk-proof-loop-handout", html: leavebehind, width: 1275, height: 1650, pdf: true },
  { id: "smirk-email-insert", html: emailInsert, width: 600, height: 560, pdf: false },
  { id: "smirk-dual-mode-flyer", html: dualModeFlyer, width: 1275, height: 3300, pdf: true },
  { id: "smirk-dual-mode-flyer-front", html: dualModeFront, width: 1275, height: 1650, pdf: false },
  { id: "smirk-dual-mode-flyer-back", html: dualModeBack, width: 1275, height: 1650, pdf: false },
];

const usage = `# SMIRK Collateral Kit

Generated by \`npm run build:smirk-collateral\`.

Use these files:
- \`smirk-dual-mode-flyer.pdf\` for the two-sided Reno trades flyer.
- \`smirk-dual-mode-flyer-front.png\` and \`smirk-dual-mode-flyer-back.png\` for email previews or print proofing.
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

Dual-mode flyer notes:
- The demo number is ${demoPhone}.
- The local founders rate is framed as a launch offer, not the public Starter price.
- The CTA is call-only until SMS guardrails are explicitly approved for this use.

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
