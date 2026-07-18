import assert from "node:assert/strict";
import {
  runCheckpointedCrmSync,
  runMandatoryPostCallArtifactPipeline,
  type CrmCheckpointAction,
} from "../src/post-call-durability.js";

async function checkMandatoryArtifactResume(): Promise<void> {
  const callSid = "CA-durable-summary-fixture";
  const summaryRows = new Set<string>();
  const appointments = new Set<string>();
  const tasks = new Set<string>();
  const leads = new Set<string>();
  const completed = new Set<string>();
  let failAfterSummaryOnce = true;

  const runProductionPipeline = () => runMandatoryPostCallArtifactPipeline({
    persistSummaryRow: async () => { summaryRows.add(callSid); },
    persistAppointment: async () => {
      if (failAfterSummaryOnce) {
        failAfterSummaryOnce = false;
        throw new Error("injected failure after durable summary row");
      }
      appointments.add(`${callSid}/booked_appointment`);
    },
    persistTasks: async () => { tasks.add(`${callSid}/callback`); },
    persistLeadFanout: async () => { leads.add(`${callSid}/lead`); },
    markArtifactsComplete: async () => { completed.add(callSid); },
  });

  await assert.rejects(runProductionPipeline, /injected failure/);
  assert.equal(summaryRows.size, 1, "the failure must retain exactly one durable summary row");
  assert.equal(completed.size, 0, "a lone summary row must not mark mandatory artifacts complete");

  await runProductionPipeline();
  assert.equal(summaryRows.size, 1, "summary retry must remain an idempotent upsert");
  assert.equal(appointments.size, 1, "retry must produce exactly one required appointment artifact");
  assert.equal(tasks.size, 1, "retry must produce exactly one required callback task");
  assert.equal(leads.size, 1, "retry must produce exactly one required lead artifact");
  assert.equal(completed.size, 1, "completion follows every mandatory artifact");
}

async function checkCrmPartialSuccessResume(): Promise<void> {
  const completed = new Set<string>();
  const attempts = new Map<string, number>();
  let failSalesforceCallOnce = true;
  const providers = ["hubspot", "salesforce"] as const;
  const actionsForProvider = (_provider: string): readonly CrmCheckpointAction[] => ["contact_upsert", "call_log"];

  const runProductionCrmLoop = () => runCheckpointedCrmSync({
    providers,
    actionsForProvider,
    isActionComplete: async (provider, action) => completed.has(`${provider}/${action}`),
    executeAction: async (provider, action) => {
      const key = `${provider}/${action}`;
      attempts.set(key, (attempts.get(key) || 0) + 1);
      if (key === "salesforce/call_log" && failSalesforceCallOnce) {
        failSalesforceCallOnce = false;
        throw new Error("injected later-provider failure");
      }
      completed.add(key);
    },
  });

  await assert.rejects(runProductionCrmLoop, /salesforce\/call_log/);
  assert(completed.has("hubspot/contact_upsert") && completed.has("hubspot/call_log"));
  assert(completed.has("salesforce/contact_upsert"));
  assert(!completed.has("salesforce/call_log"));

  await runProductionCrmLoop();
  assert.equal(attempts.get("hubspot/contact_upsert"), 1, "completed HubSpot contact must not rerun");
  assert.equal(attempts.get("hubspot/call_log"), 1, "completed HubSpot activity must not rerun");
  assert.equal(attempts.get("salesforce/contact_upsert"), 1, "completed Salesforce contact must not rerun");
  assert.equal(attempts.get("salesforce/call_log"), 2, "only the failed provider action should retry");
}

await checkMandatoryArtifactResume();
await checkCrmPartialSuccessResume();
console.log("OK executable post-call artifact and CRM checkpoint retry fixtures passed");
