#!/usr/bin/env node
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const failures = [];
const expect = (label, condition) => { if (!condition) failures.push(label); };

const urlSafety = read("src/public-url-safety.ts");
const alerts = read("src/monetization-alerts.ts");
const saas = read("src/saas.ts");
const buyerRoutes = read("src/routes/buyer-routes.ts");
const provisioningRoutes = read("src/routes/provisioning-routes.ts");
const workspaceAdminRoutes = read("src/routes/workspace-admin-routes.ts");
const app = read("src/App.tsx");

expect("trusted production origins are an immutable exact allowlist",
  urlSafety.includes("TRUSTED_PRODUCTION_APP_ORIGINS = Object.freeze")
  && urlSafety.includes('"https://ai-phone-agent-production-6811.up.railway.app"')
  && urlSafety.includes('"https://smirkcalls.com"')
  && urlSafety.includes('"https://www.smirkcalls.com"')
  && urlSafety.includes("TRUSTED_PRODUCTION_APP_ORIGIN_SET.has(url.origin)"));
expect("public external links require credential-free HTTPS public hostnames",
  urlSafety.includes('url.protocol !== "https:"')
  && urlSafety.includes("url.username || url.password")
  && urlSafety.includes("hasSafePublicHostname(url.hostname)"));
expect("buyer activation email validates trusted invite origin and sanitizes recovery APP_URL",
  alerts.includes("normalizeTrustedProductionAppUrl(inviteLink)")
  && alerts.includes("resolveTrustedProductionAppOrigin(process.env.APP_URL)"));
expect("paid checkout invite links never interpolate raw APP_URL",
  saas.includes("resolveTrustedProductionAppOrigin(process.env.APP_URL)")
  && !saas.includes('String(process.env.APP_URL || "").replace(/\\\/$/, "")'));
expect("invite resend sanitizes caller-provided app URL",
  saas.includes("resolveTrustedProductionAppOrigin(input.appUrl, process.env.APP_URL)"));
expect("buyer pricing and recovery routes sanitize public URLs",
  buyerRoutes.includes("firstSafePublicHttpsUrl(process.env.BOOKING_LINK")
  && buyerRoutes.includes("resolveTrustedProductionAppOrigin(env.LANDING_APP_URL, env.APP_URL, getAppUrl())"));
expect("provisioning responses and invite links sanitize public URLs",
  provisioningRoutes.includes("booking_link: getBuyerFacingBookingLink(env)")
  && provisioningRoutes.includes("resolveTrustedProductionAppOrigin(process.env.APP_URL, getAppUrl())"));
expect("operator-created workspace invite links use the same trusted production origin boundary",
  workspaceAdminRoutes.includes("resolveTrustedProductionAppOrigin(process.env.APP_URL, getAppUrl())")
  && !workspaceAdminRoutes.includes("`${getAppUrl()}/invite/"));
expect("browser revalidates API-provided fallback and recovery links before rendering",
  app.includes("fallback_url: normalizePublicHttpsUrl(plan?.fallback_url)")
  && app.includes("bookingLink: normalizePublicHttpsUrl(body.booking_link)")
  && app.includes("normalizeTrustedProductionAppUrl(body.recovery_url)"));

if (failures.length > 0) {
  console.error("FAIL public buyer URL safety contract drift:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK buyer-facing fallback, invite, and recovery URLs are sanitized against explicit HTTPS trust boundaries");
