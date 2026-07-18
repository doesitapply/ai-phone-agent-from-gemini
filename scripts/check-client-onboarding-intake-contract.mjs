import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const includesChecks = [
  ["src/function-calling.ts", "name: \"create_client_onboarding_intake\"", "Gemini tool declaration exists"],
  ["src/function-calling.ts", "call create_client_onboarding_intake", "tool rule tells the phone agent to create onboarding intakes"],
  ["src/function-calling.ts", "secure published recurring checkout, confirmed payment, workspace setup, then buyer activation", "phone agent explains the published checkout-to-activation path"],
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
  ["src/saas.ts", "ALTER COLUMN deposit_percent SET DEFAULT 100", "legacy deposit column defaults to the full checkout amount"],
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
  ["server.ts", "secure published recurring checkout", "runtime prompt explains the published checkout path"],
  ["server.ts", "trusted employee, operator, or owner", "runtime prompt supports trusted employee onboarding"],
  ["src/routes/provisioning-routes.ts", "voice_operator_onboarding", "dashboard provisioning API exposes voice operator onboarding rows"],
  ["src/routes/provisioning-routes.ts", "voice_direct_onboarding", "dashboard provisioning API exposes direct voice onboarding rows"],
  ["src/routes/provisioning-routes.ts", "send only a currently enabled secure published checkout", "operator queue cannot imply a disabled broader plan is available"],
  ["src/components/SetupWizard.tsx", "label: \"Call Flow\"", "setup wizard labels the call instructions as Call Flow"],
  ["src/components/SetupWizard.tsx", "label: \"Owner Alert\"", "setup wizard labels owner email setup as Owner Alert"],
  ["src/components/SetupWizard.tsx", "label: \"Proof\"", "setup wizard labels activation readiness as Proof"],
  ["src/components/SetupWizard.tsx", "missed-call assistant", "setup wizard explains the assistant as missed-call recovery"],
  ["src/components/SetupWizard.tsx", "callback task creation", "setup wizard keeps callback task creation in the activation promise"],
  ["src/components/SetupWizard.tsx", "Complete setup for proof", "setup wizard CTA preserves the distinction between setup completion and verified live service"],
];

const failures = [];

for (const [relativePath, needle, description] of includesChecks) {
  const text = read(relativePath);
  if (!text.includes(needle)) failures.push(`${description}: missing ${needle} in ${relativePath}`);
}

const toolsText = read("src/tools.ts");
const checkoutContractOk = toolsText.includes("${notes}, 100, 'checkout_required', 'not_applicable'")
  && toolsText.includes('published_checkout_plan: FIRST_DOLLAR_PLAN')
  && toolsText.includes('owner_review_required: broaderPlanRequested')
  && toolsText.includes('No payment has been taken or broader plan promised')
  && toolsText.includes('payment_status: "not_collected"');
if (!checkoutContractOk) failures.push("voice intake must record one uncollected full recurring checkout without a deposit/balance promise");

for (const relativePath of ["server.ts", "src/function-calling.ts", "src/tools.ts", "src/routes/provisioning-routes.ts"]) {
  const text = read(relativePath);
  for (const staleClaim of ["10% deposit", "remaining balance after", "send deposit link"]) {
    if (text.includes(staleClaim)) failures.push(`${relativePath} still contains the unapproved active payment claim: ${staleClaim}`);
  }
}

const setupWizardText = read("src/components/SetupWizard.tsx");
const staleSetupCopy = [
  ["Agent Configuration", "setup wizard must not frame onboarding as generic agent configuration"],
  ["Activate Agent", "setup wizard activation CTA must stay tied to missed-call recovery"],
  ["Activate Recovery", "setup wizard must not claim setup completion activates an unproven live service"],
  ["Once live, your phone number will answer calls with AI", "setup wizard must explain the proof loop, not broad AI answering"],
];
for (const [needle, description] of staleSetupCopy) {
  if (setupWizardText.includes(needle)) failures.push(`${description}: found stale copy ${needle}`);
}

if (failures.length) {
  console.error("Client onboarding intake contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Client onboarding intake contract passed.");
