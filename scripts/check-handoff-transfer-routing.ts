#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreTeamMemberForEscalation, type TeamRoutingCandidate } from "../src/team-routing-score.ts";
import { chooseSafeHumanTransferTarget, detectExplicitHumanTransferRequest, isSamePhoneNumber } from "../src/handoff-transfer.ts";

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

expect(isSamePhoneNumber("+1 (775) 420-4485", "+17754204485"), "phone comparison must normalize formatting");

const recoveredTarget = chooseSafeHumanTransferTarget([
  { phone: null, name: "missing routed phone", source: "tool" },
  { phone: "+17755558280", name: "Jesse Penman", source: "handoff_record" },
  { phone: "+17754204485", name: "fallback owner", source: "env" },
], ["+17754204485", "+17755553005"]);
expect(recoveredTarget?.phone === "+17755558280", "transfer target should recover latest handoff phone before unsafe env fallback");

const unsafeTarget = chooseSafeHumanTransferTarget([
  { phone: "+17754204485", name: "Cameron Church", source: "tool" },
  { phone: "+17755553005", name: "Twilio line", source: "env" },
], ["+17754204485", "+17755553005"]);
expect(unsafeTarget === null, "transfer target must not dial the active caller or Twilio line");

expect(
  detectExplicitHumanTransferRequest("I want to talk to a human.")?.reason.includes("explicitly requested"),
  "explicit human requests must be detected before the AI provider path"
);

expect(
  detectExplicitHumanTransferRequest("Can you connect me with Jesse?")?.topic === "jesse",
  "explicit named-person transfer requests must preserve the routing topic"
);

expect(
  detectExplicitHumanTransferRequest("I need a human right now.")?.topic === "human",
  "direct need/want human phrasing must trigger transfer detection"
);

expect(
  detectExplicitHumanTransferRequest("Get me a representative.")?.topic === "representative",
  "short imperative transfer phrasing must trigger transfer detection"
);

expect(
  detectExplicitHumanTransferRequest("Do not transfer me, just answer the question.") === null,
  "negated transfer language must not trigger a live handoff"
);

expect(
  detectExplicitHumanTransferRequest("I don't want to talk to a human.") === null,
  "negated human-talk language must not trigger a live handoff"
);

expect(
  detectExplicitHumanTransferRequest("I want information about your missed-call assistant.") === null,
  "product questions about the missed-call assistant must not be mistaken for human transfer requests"
);

const server = read("server.ts");
const functionCalling = read("src/function-calling.ts");
const tools = read("src/tools.ts");

expect(server.includes('transferPhone: typeof transferData?.transfer_phone === "string" ? transferData.transfer_phone : null'), "OpenRouter tool path must propagate transfer_phone to Twilio");
expect(server.includes('transferName: typeof transferData?.transfer_name === "string" ? transferData.transfer_name : null'), "OpenRouter tool path must propagate transfer_name to Twilio");
expect(server.includes("const handoffTarget = await getLatestHandoffTransferTarget(callSid)"), "Twilio transfer branch must recover latest handoff target before env fallback");
expect(server.includes("chooseSafeHumanTransferTarget"), "Twilio transfer branch must reject unsafe self-transfer targets");
expect(server.includes('callerId: bridgeCallerId || undefined'), "Twilio transfer branch must use the Twilio/business line as caller ID");
expect(server.includes("dial.number(transferTarget.phone)"), "Twilio transfer branch must dial the selected safe transfer target");
expect(server.includes('upsertPendingTwimlDb(callSid, true, finalTwiml'), "Twilio transfer branch must persist transfer TwiML for cross-instance response polling");
expect(server.includes('logEvent(callSid, "CALL_TRANSFERRED"'), "Twilio transfer branch must emit CALL_TRANSFERRED");
expect(server.includes("const explicitTransferRequest = detectExplicitHumanTransferRequest(speechResult)"), "phone handler must detect explicit human transfer requests before AI provider selection");
expect(server.includes('dispatchTool("escalate_to_human"'), "explicit transfer branch must call the local handoff tool even when OpenClaw is enabled");
expect(
  server.indexOf("const explicitTransferRequest = detectExplicitHumanTransferRequest(speechResult)") <
    server.indexOf("const needsEscalation = escalationPhrases.some"),
  "explicit transfer branch must run before the provider-specific escalation hint"
);

expect(functionCalling.includes('description: "The requested person, role, or topic to route to'), "escalate_to_human tool declaration must expose topic routing");
expect(functionCalling.includes("topic: (args.topic as string) || undefined"), "Gemini dispatch must pass topic into escalate_to_human");

expect(tools.includes("const routed = await findBestTeamMember(wsId, input.reason, input.topic)"), "escalate_to_human must route with reason plus topic");
expect(tools.includes("transfer_phone: routed?.phone ?? null"), "escalate_to_human must return the routed transfer phone");
expect(tools.includes("I'm connecting you with ${routed.name}"), "caller-facing handoff message should name the routed human when a phone exists");

if (process.exitCode) process.exit(process.exitCode);

console.log("[check-handoff-transfer] transfer routing checks passed");
