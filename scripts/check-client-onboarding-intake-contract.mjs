import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const includesChecks = [
  ["src/function-calling.ts", "name: \"create_client_onboarding_intake\"", "Gemini tool declaration exists"],
  ["src/function-calling.ts", "call create_client_onboarding_intake", "tool rule tells the phone agent to create onboarding intakes"],
  ["src/function-calling.ts", "owner review, 10% deposit, workspace setup, confirmation", "phone agent explains the deposit-to-activation path"],
  ["src/function-calling.ts", "Do not end with vague phrases", "phone agent has articulation guardrails"],
  ["src/tools.ts", "export const createClientOnboardingIntake", "server tool implementation exists"],
  ["src/tools.ts", "getAuthorizedOnboardingCaller", "trusted caller authorization exists"],
  ["src/tools.ts", "can_initiate_onboarding", "trusted operator permission is checked"],
  ["src/tools.ts", "voice_operator_onboarding", "trusted operator source is recorded"],
  ["src/tools.ts", "voice_direct_onboarding", "direct caller source is recorded"],
  ["src/tools.ts", "deposit_status", "deposit status is stored"],
  ["src/tools.ts", "balance_status", "balance status is stored"],
  ["src/tools.ts", "sendProvisioningAlert", "owner provisioning alert is sent"],
  ["src/tools.ts", "CLIENT_ONBOARDING_INTAKE_CREATED", "onboarding intake event is logged"],
  ["src/events.ts", "CLIENT_ONBOARDING_INTAKE_CREATED", "onboarding event is typed"],
  ["src/saas.ts", "CREATE TABLE IF NOT EXISTS provisioning_requests", "provisioning request table is initialized"],
  ["src/saas.ts", "ADD COLUMN IF NOT EXISTS deposit_percent", "deposit percent migration exists"],
  ["src/saas.ts", "ADD COLUMN IF NOT EXISTS onboarding_source", "onboarding source migration exists"],
  ["src/db.ts", "can_receive_handoffs BOOLEAN NOT NULL DEFAULT TRUE", "team handoff permission column exists"],
  ["src/db.ts", "can_initiate_onboarding BOOLEAN NOT NULL DEFAULT FALSE", "team onboarding permission column exists"],
  ["src/team-routes.ts", "can_receive_handoffs", "team API persists handoff permission"],
  ["src/team-routes.ts", "can_initiate_onboarding", "team API persists onboarding permission"],
  ["src/team-routing.ts", "COALESCE(can_receive_handoffs, TRUE) = TRUE", "handoff routing honors handoff permission"],
  ["src/team-routing.ts", "LENGTH(REGEXP_REPLACE(COALESCE(phone, ''),", "handoff routing requires a phone number"],
  ["src/App.tsx", "Client Intake", "team UI exposes client intake permission"],
  ["src/App.tsx", "Human Handoff", "team UI exposes human handoff permission"],
  ["server.ts", "Do not end with vague phrases", "runtime prompt has articulation guardrails"],
  ["server.ts", "10% deposit", "runtime prompt explains deposit path"],
  ["server.ts", "trusted employee, operator, or owner", "runtime prompt supports trusted employee onboarding"],
  ["server.ts", "voice_operator_onboarding", "dashboard provisioning API exposes voice operator onboarding rows"],
  ["server.ts", "voice_direct_onboarding", "dashboard provisioning API exposes direct voice onboarding rows"],
];

const failures = [];

for (const [relativePath, needle, description] of includesChecks) {
  const text = read(relativePath);
  if (!text.includes(needle)) failures.push(`${description}: missing ${needle} in ${relativePath}`);
}

const toolsText = read("src/tools.ts");
const depositClampOk = /Math\.max\(1,\s*Math\.min\(Math\.round\(Number\(input\.deposit_percent \|\| 10\)\),\s*50\)\)/.test(toolsText);
if (!depositClampOk) failures.push("deposit percent must be clamped between 1 and 50 in src/tools.ts");

if (failures.length) {
  console.error("Client onboarding intake contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Client onboarding intake contract passed.");
