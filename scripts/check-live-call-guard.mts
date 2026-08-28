import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const functionCalling = fs.readFileSync(path.join(root, "src", "function-calling.ts"), "utf8");
const systemPrompt = fs.readFileSync(path.join(root, "src", "db.ts"), "utf8");

const expectations: Array<[string, boolean]> = [
  ["dashboard task mutation tools are not exposed to the call model", !/name: "complete_open_tasks"/.test(functionCalling)],
  ["caller task visibility remains available without dashboard scope", /name: "list_open_tasks"/.test(functionCalling) && /scope: "caller"/.test(functionCalling)],
  ["voice task mutations require authenticated dashboard access", functionCalling.includes("VOICE_TASK_MUTATION_REQUIRES_DASHBOARD_AUTH")],
  ["repeat live transfers are blocked", functionCalling.includes("LIVE_TRANSFER_ALREADY_ATTEMPTED")],
  ["SMIRK identity names Cameron Church", systemPrompt.includes("built and operated by Cameron Church")],
  ["SMIRK identity does not credit model vendors", systemPrompt.includes("Never say Google, Gemini, Twilio, OpenAI")],
  ["failed transfers become callbacks rather than repeated transfer attempts", systemPrompt.includes("Attempt a live human transfer at most once per call")],
  ["failed transfers create a callback task without relying on the model", fs.readFileSync(path.join(root, "src", "routes", "screened-transfer-routes.ts"), "utf8").includes("TRANSFER_CALLBACK_TASK_CREATED")],
];

const failures = expectations.filter(([, passed]) => !passed).map(([name]) => name);
if (failures.length) {
  console.error(`Live-call guard check failed: ${failures.join("; ")}`);
  process.exit(1);
}

console.log(`Live-call guard check passed (${expectations.length} assertions).`);
