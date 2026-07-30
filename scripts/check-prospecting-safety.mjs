#!/usr/bin/env node
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const failures = [];
const expect = (label, condition) => {
  if (!condition) failures.push(label);
};

const prospectingRoutes = read("src/routes/prospecting-routes.ts");
const leadRoutes = read("src/routes/lead-routes.ts");
const prospector = read("src/prospector.ts");
const sequence = read("src/sequence-engine.ts");
const server = read("server.ts");
const app = read("src/App.tsx");
const pkg = JSON.parse(read("package.json"));

const activeProspectingUi = app.slice(
  app.indexOf("function ProspectingPage()"),
  app.indexOf("// ── Analytics Page", app.indexOf("function ProspectingPage()")),
);
const activeLeadHunterUi = app.slice(
  app.indexOf("function LeadHunterPage()"),
  app.indexOf("// ── Live Control Page", app.indexOf("function LeadHunterPage()")),
);

expect(
  "prospecting contact endpoints return the explicit approval-required code",
  prospectingRoutes.includes("PROSPECTING_CONTACT_APPROVAL_REQUIRED"),
);
expect(
  "prospecting status changes do not schedule external actions",
  prospectingRoutes.includes('externalActions: "not_scheduled"')
    && !prospectingRoutes.includes("scheduleFollowUpSteps")
    && !prospectingRoutes.includes("RESEND_API_KEY")
    && !prospectingRoutes.includes("TWILIO_PHONE_NUMBER")
    && !prospectingRoutes.includes("calls.create")
    && !prospectingRoutes.includes("api.resend.com"),
);
expect(
  "legacy campaign launch cannot place calls",
  leadRoutes.includes("PROSPECTING_CONTACT_APPROVAL_REQUIRED")
    && !leadRoutes.includes("calls.create")
    && !leadRoutes.includes("checkOutboundCompliance"),
);
expect(
  "metered lead research and personalization fail closed",
  leadRoutes.includes("LEAD_RESEARCH_SPEND_APPROVAL_REQUIRED")
    && !leadRoutes.includes("searchLeadsApollo")
    && !leadRoutes.includes("searchLeadsGoogleMaps")
    && !leadRoutes.includes("generatePersonalizedPitch"),
);
expect(
  "the prospect store has no provider contact implementation",
  !prospector.includes("calls.create")
    && !prospector.includes("checkOutboundCompliance")
    && !prospector.includes("buildPitchSystemPrompt")
    && !prospector.includes("places.googleapis.com"),
);
expect(
  "campaign reads and mutations are workspace scoped",
  prospector.includes("WHERE workspace_id = ${workspaceId}")
    && prospector.includes("WHERE id = ${id} AND workspace_id = ${workspaceId}")
    && prospector.includes("workspace_id\n    )")
    && prospector.includes("${workspaceId}")
    && prospector.includes("ALTER COLUMN workspace_id DROP DEFAULT"),
);
expect(
  "lead reads and mutations are workspace scoped through their campaign",
  prospector.includes("JOIN prospecting_campaigns c ON c.id = l.campaign_id")
    && prospector.includes("c.workspace_id = ${workspaceId}")
    && prospector.includes("WHERE c.id = prospect_leads.campaign_id"),
);
expect(
  "sequence automation defaults off and disables historical enabled campaigns",
  sequence.includes("PROSPECT_SEQUENCE_AUTOMATION_ENABLED = false")
    && sequence.includes("sequence_enabled BOOLEAN NOT NULL DEFAULT FALSE")
    && sequence.includes("ALTER COLUMN sequence_enabled SET DEFAULT FALSE")
    && sequence.includes("SET sequence_enabled = FALSE"),
);
expect(
  "sequence scheduling and execution are provider-free no-ops",
  !sequence.includes("calls.create")
    && !sequence.includes("api.resend.com")
    && sequence.includes("return { executed: 0, failed: 0 };")
    && sequence.includes("return 0;"),
);
expect(
  "the server has no prospect sequence background executor",
  !server.includes("executeDueSequenceSteps"),
);
expect(
  "active prospecting UI exposes research review rather than dialing",
  activeProspectingUi.includes("Prospect Research Queue")
    && activeProspectingUi.includes("No cold SMS")
    && !/auto-dial|dial-next|Dial One|Launch Auto-Dial|Auto-running/i.test(activeProspectingUi),
);
expect(
  "active lead UI does not expose metered search controls",
  activeLeadHunterUi.includes("External research paused")
    && !activeLeadHunterUi.includes("/api/leads/search/maps")
    && !activeLeadHunterUi.includes("/api/leads/search/apollo"),
);
expect(
  "portable prospecting safety verification is exposed",
  pkg.scripts?.["check:prospecting-safety"]
    === "node scripts/check-prospecting-safety.mjs && node --import tsx --test tests/prospecting_safety.test.ts",
);

if (failures.length) {
  console.error("Prospecting safety contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK prospect research is workspace-scoped and all contact or metered-search paths fail closed");
