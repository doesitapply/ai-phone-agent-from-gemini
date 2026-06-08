import assert from "node:assert/strict";
import http from "node:http";
import { assertSafeWebsiteUrl, scanBusinessWebsite } from "../src/website-intake.ts";

const homepage = `<!doctype html>
<html>
  <head>
    <title>Fixture Plumbing | Reno Emergency Plumbing</title>
    <meta name="description" content="Fixture Plumbing provides emergency plumbing, water heater repair, drain cleaning, and honest service for Reno and Sparks.">
  </head>
  <body>
    <h1>Fixture Plumbing</h1>
    <p>Call (775) 555-0199 for emergency plumbing help.</p>
    <nav>
      <a href="/about">About</a>
      <a href="/services">Services</a>
      <a href="/contact">Contact</a>
      <a href="/faq">FAQ</a>
      <a href="/fixture.pdf">PDF</a>
    </nav>
  </body>
</html>`;

const pages: Record<string, string> = {
  "/": homepage,
  "/about": `<!doctype html><title>About Fixture Plumbing</title><p>Fixture Plumbing is licensed and insured. We are locally owned and serving Reno, Sparks, and surrounding areas.</p>`,
  "/services": `<!doctype html><title>Services</title><p>Services include drain cleaning, leak repair, water heater installation, fixture replacement, and emergency plumbing. Free estimates are available and pricing starts after inspection.</p>`,
  "/contact": `<!doctype html><title>Contact</title><p>Visit 123 Main Street, Reno, NV 89501. Hours are Monday-Friday 8am-6pm and Saturday 9am-2pm. Book an appointment by calling today.</p>`,
  "/faq": `<!doctype html><title>FAQ</title><p>Frequently asked questions: do you offer same day appointments? Yes, urgent issues are escalated for same day callback.</p>`,
};

const server = http.createServer((request, response) => {
  const body = pages[request.url || "/"];
  if (!body) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const address = server.address();
  assert(address && typeof address === "object", "fixture server did not expose a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await assert.rejects(
    () => assertSafeWebsiteUrl(baseUrl),
    /localhost|private network/i,
    "production safety should reject local/private URLs",
  );

  const result = await scanBusinessWebsite(
    { website: baseUrl, business_name: "Fixture Plumbing", location: "Reno, NV" },
    { allowPrivateHosts: true, timeoutMs: 2_000, maxPages: 5 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.resolvedWebsite, `${baseUrl}/`);
  assert(result.pages.length >= 4, "expected homepage plus likely same-origin pages");
  assert.equal(result.suggestedProfile.business_name, "Fixture Plumbing");
  assert(result.suggestedProfile.business_phone?.includes("775"), "expected phone suggestion");
  assert(result.suggestedProfile.business_address?.includes("Reno, NV"), "expected address suggestion");
  assert(result.facts.some((fact) => fact.label === "Services"), "expected services fact");
  assert(result.facts.some((fact) => fact.label === "Service area"), "expected service area fact");
  assert(result.knowledgeContent.includes("Website scan source"), "expected knowledge content");
  assert(result.knowledgeContent.includes("Source:"), "expected source-linked notes");

  console.log("Business data fixture scan passed.");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
