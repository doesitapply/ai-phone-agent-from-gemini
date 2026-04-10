import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const inPath = process.argv[2];
const outPath = process.argv[3];
if (!inPath || !outPath) {
  console.error('Usage: node scripts/md-to-pdf.mjs <in.md> <out.pdf>');
  process.exit(2);
}

const md = readFileSync(inPath, 'utf8');
const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Minimal markdown-ish rendering: headings, code blocks, lists, paragraphs.
let html = '';
let inCode = false;
for (const rawLine of md.split(/\r?\n/)) {
  const line = rawLine;
  if (line.trim().startsWith('```')) {
    inCode = !inCode;
    html += inCode ? '<pre><code>' : '</code></pre>';
    continue;
  }
  if (inCode) {
    html += esc(line) + '\n';
    continue;
  }
  if (/^#\s+/.test(line)) html += `<h1>${esc(line.replace(/^#\s+/,''))}</h1>`;
  else if (/^##\s+/.test(line)) html += `<h2>${esc(line.replace(/^##\s+/,''))}</h2>`;
  else if (/^###\s+/.test(line)) html += `<h3>${esc(line.replace(/^###\s+/,''))}</h3>`;
  else if (/^\s*[-*]\s+/.test(line)) html += `<div class="li">• ${esc(line.replace(/^\s*[-*]\s+/,''))}</div>`;
  else if (line.trim() === '') html += '<div class="sp"></div>';
  else html += `<p>${esc(line)}</p>`;
}

const doc = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.35; color: #111; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  h2 { font-size: 16px; margin: 16px 0 8px; }
  h3 { font-size: 13px; margin: 14px 0 6px; }
  p { margin: 0 0 6px; }
  .li { margin: 0 0 4px 10px; }
  .sp { height: 6px; }
  pre { background: #f6f8fa; padding: 10px; border-radius: 6px; overflow-x: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 10.5px; }
</style>
</head>
<body>
${html}
</body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(doc, { waitUntil: 'load' });
await page.pdf({ path: outPath, format: 'Letter', printBackground: true, margin: { top: '0.5in', bottom: '0.6in', left: '0.6in', right: '0.6in' } });
await browser.close();
console.log(outPath);
