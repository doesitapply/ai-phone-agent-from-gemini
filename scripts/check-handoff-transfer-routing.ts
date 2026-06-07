#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreTeamMemberForEscalation, type TeamRoutingCandidate } from "../src/team-routing-score.ts";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const fail = (message: string): void => {
  console.error(`[check-handoff-transfer] ${message}`);
  process.exitCode = 1;
};

const expect = (condition: boolean, message: string): void => {
  if (!condition) fail(message);
};

const read = (relativePath: string): string => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

const cameron: TeamRoutingCandidate = {
  id: 1,
  name: "Cameron Church",
  role: "Owner",
  phone: "+17754204485",
  email: "cameron@example.com",
  is_on_call: false,
  handles_topics: ["sales", "billing", "strategy"],
  priority: 100,
};

const jesse: TeamRoutingCandidate = {
  id: 2,
  name: "Jesse Penman",
  role: "Sales Rep",
  phone: "+17755558280",
  email: "jesse@example.com",
  is_on_call: true,
  handles_topics: [],
  priority: 73,
};

expect(
  scoreTeamMemberForEscalation(jesse, "Please transfer me to Jesse.") >
    scoreTeamMemberForEscalation(cameron, "Please transfer me to Jesse."),
  "explicit Jesse requests must route to Jesse"
);

expect(
  scoreTeamMemberForEscalation(cameron, "Can you put Cameron on the phone?") >
    scoreTeamMemberForEscalation(jesse, "Can you put Cameron on the phone?"),
  "explicit Cameron requests must override another member being on call"
);

expect(
  scoreTeamMemberForEscalation(jesse, "I need a sales representative.") >
    scoreTeamMemberForEscalation(cameron, "I need a sales representative."),
  "generic role requests should still respect on-call routing"
);

const server = read("server.ts");
const functionCalling = read("src/function-calling.ts");
const tools = read("src/tools.ts");

expect(server.includes('transferPhone: typeof transferData?.transfer_phone === "string" ? transferData.transfer_phone : null'), "OpenRouter tool path must propagate transfer_phone to Twilio");
expect(server.includes('transferName: typeof transferData?.transfer_name === "string" ? transferData.transfer_name : null'), "OpenRouter tool path must propagate transfer_name to Twilio");
expect(server.includes("const transferNumber = routedPhone || env.HUMAN_TRANSFER_NUMBER || null"), "Twilio transfer branch must prefer routed team member phone");
expect(server.includes("dial.number(transferNumber)"), "Twilio transfer branch must dial the routed transfer number");
expect(server.includes('logEvent(callSid, "CALL_TRANSFERRED"'), "Twilio transfer branch must emit CALL_TRANSFERRED");

expect(functionCalling.includes('description: "The requested person, role, or topic to route to'), "escalate_to_human tool declaration must expose topic routing");
expect(functionCalling.includes("topic: (args.topic as string) || undefined"), "Gemini dispatch must pass topic into escalate_to_human");

expect(tools.includes("const routed = await findBestTeamMember(wsId, input.reason, input.topic)"), "escalate_to_human must route with reason plus topic");
expect(tools.includes("transfer_phone: routed?.phone ?? null"), "escalate_to_human must return the routed transfer phone");
expect(tools.includes("I'm connecting you with ${routed.name}"), "caller-facing handoff message should name the routed human when a phone exists");

if (process.exitCode) process.exit(process.exitCode);

console.log("[check-handoff-transfer] transfer routing checks passed");
