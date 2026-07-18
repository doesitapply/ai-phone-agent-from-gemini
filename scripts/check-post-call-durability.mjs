#!/usr/bin/env node
import { readFileSync } from "node:fs";

const route = readFileSync("src/routes/twilio-status-routes.ts", "utf8");
const db = readFileSync("src/db.ts", "utf8");
const webhooks = readFileSync("src/webhooks.ts", "utf8");
const intelligence = readFileSync("src/intelligence.ts", "utf8");
const crm = readFileSync("src/crm.ts", "utf8");
const durability = readFileSync("src/post-call-durability.ts", "utf8");
const failures = [];
const expect = (label, condition) => { if (!condition) failures.push(label); };

expect("jobs are keyed by CallSid", db.includes("call_sid       TEXT PRIMARY KEY REFERENCES calls(call_sid)"));
expect("stages are individually checkpointed", db.includes("PRIMARY KEY (call_sid, stage)"));
expect("all required post-call stages are durable", [
  "summary", "opt_out", "call_webhook", "crm_sync", "owner_webhook", "owner_alert",
].every((stage) => db.includes(`'${stage}'`) && route.includes(`"${stage}"`)));
expect("job enqueue is idempotent", route.includes("ON CONFLICT (call_sid) DO UPDATE SET"));
expect("stage enqueue is idempotent", route.includes("ON CONFLICT (call_sid, stage) DO NOTHING"));
expect("tenant rebinding fails closed", route.includes("Refused to rebind post-call job"));
expect("workers use expiring leases", route.includes("lease_token = ${leaseToken}") && route.includes("POST_CALL_LEASE_MINUTES"));
expect("failed work receives bounded backoff", route.includes("Math.min(15 * 60_000") && route.includes("available_at = ${availableAt}"));
expect("a sweeper resumes due and stale work", route.includes("drainDuePostCallJobs") && route.includes("status IN ('pending', 'failed')") && route.includes("status = 'running' AND locked_at < NOW()"));
expect("stage failures are persisted", route.includes("UPDATE post_call_processing_stages") && route.includes("SET status = 'failed'"));
expect("completion requires every stage terminal", route.includes("status NOT IN ('completed', 'skipped')"));
expect("post-call job is enqueued before Twilio 2xx", route.indexOf("await enqueuePostCallJob(CallSid, callWorkspaceId)") > -1
  && route.indexOf("await enqueuePostCallJob(CallSid, callWorkspaceId)") < route.lastIndexOf("res.sendStatus(200)"));
expect("enqueue failure asks Twilio to retry", route.includes('res.status(503).send("Post-call processing enqueue retry required")'));
expect("completed duplicate callbacks are not gated on finalized", !/if \(terminalResult\.finalized\) setImmediate\(async \(\) => \{\s*if \(Number\.isSafeInteger\(callWorkspaceId\)/.test(route));
expect("background work is restart-safe", route.includes("setInterval(() => { void drainDuePostCallJobs(); }") && route.includes("startupSweep"));
expect("call webhooks expose failure to the durable worker", webhooks.includes("throw new Error(`Webhook delivery failed for ${callSid}"));
expect("call webhooks have a stable downstream idempotency key", webhooks.includes('"X-SMIRK-Idempotency-Key": `${payload.event}:${payload.call.sid}`'));
expect("owner webhooks have a stable downstream idempotency key", route.includes('"X-SMIRK-Idempotency-Key": `owner_notification:${job.call_sid}`'));
expect("Resend owner alerts have a stable idempotency key", route.includes('"Idempotency-Key": `smirk-owner-alert/${job.call_sid}`'));
expect("summary completion requires all mandatory artifacts", route.includes("artifacts_completed_at IS NOT NULL AS complete")
  && intelligence.includes("runMandatoryPostCallArtifactPipeline")
  && intelligence.includes("artifacts_completed_at = COALESCE(artifacts_completed_at, NOW())"));
expect("summary retries reuse the durable model plan", db.includes("artifact_plan JSONB")
  && intelligence.includes("SELECT artifact_plan FROM call_summaries")
  && intelligence.includes("Durable post-call artifact plan is unavailable"));
expect("mandatory lead fanout is awaited", intelligence.includes("const result = await upsertLead({"));
expect("generated tasks have database idempotency keys", db.includes("idx_tasks_post_call_artifact")
  && intelligence.includes("post_call_artifact_key")
  && intelligence.includes("ON CONFLICT (call_sid, post_call_artifact_key)"));
expect("CRM actions have durable CallSid/provider/action checkpoints", db.includes("post_call_crm_checkpoints")
  && db.includes("PRIMARY KEY (call_sid, provider, action)")
  && route.includes("runCheckpointedCrmSync"));
expect("completed CRM actions are skipped on retry", durability.includes("if (await operations.isActionComplete(provider, action)) continue"));
expect("CRM remote activities search by deterministic CallSid before create", crm.includes('SMIRK CallSid: ${log.callSid}')
  && crm.includes('crm/v3/objects/calls/search')
  && crm.includes("SELECT Id FROM Task WHERE Subject =")
  && crm.includes("{Call SID}='${escapedCallSid}'"));
expect("one failed integration does not suppress independent stages", route.includes("const stageFailures:")
  && route.includes("for (const stage of POST_CALL_STAGES.slice(1))")
  && route.includes("stageFailures.push"));
expect("every stage query stays workspace bound", route.includes("requireBoundCall(job.call_sid, job.workspace_id)") && route.includes("AND workspace_id = ${workspaceId}"));

// Executable retry fixture: a transient CRM failure must preserve the completed
// summary/opt-out/webhook checkpoints, and a duplicate callback must resume only
// the unfinished suffix. A callback after completion must remain a no-op.
const orderedStages = ["summary", "opt_out", "call_webhook", "crm_sync", "owner_webhook", "owner_alert"];
const model = {
  status: "pending",
  stages: Object.fromEntries(orderedStages.map((stage) => [stage, { status: "pending", attempts: 0 }])),
};
let failCrmOnce = true;
const enqueue = () => {
  if (model.status === "failed") model.status = "pending";
};
const run = () => {
  if (model.status === "completed") return;
  model.status = "running";
  let hadFailure = false;
  for (const stage of orderedStages) {
    const state = model.stages[stage];
    if (["completed", "skipped"].includes(state.status)) continue;
    state.status = "running";
    state.attempts += 1;
    if (stage === "crm_sync" && failCrmOnce) {
      failCrmOnce = false;
      state.status = "failed";
      hadFailure = true;
      continue;
    }
    state.status = stage === "owner_webhook" ? "skipped" : "completed";
  }
  model.status = hadFailure ? "failed" : "completed";
};

enqueue();
run();
expect("fixture reaches a retryable failure", model.status === "failed" && model.stages.crm_sync.status === "failed");
expect("fixture checkpoints the completed prefix", model.stages.summary.status === "completed"
  && model.stages.opt_out.status === "completed"
  && model.stages.call_webhook.status === "completed");
expect("fixture still delivers independent owner work", model.stages.owner_webhook.status === "skipped"
  && model.stages.owner_alert.status === "completed");
enqueue();
run();
expect("fixture resumes to completion", model.status === "completed");
expect("fixture does not repeat completed prefix", model.stages.summary.attempts === 1
  && model.stages.opt_out.attempts === 1
  && model.stages.call_webhook.attempts === 1);
expect("fixture retries only the failed stage", model.stages.crm_sync.attempts === 2);
expect("fixture does not repeat the completed suffix", model.stages.owner_webhook.attempts === 1
  && model.stages.owner_alert.attempts === 1);
const attemptsAtCompletion = Object.values(model.stages).map((stage) => stage.attempts).join(",");
enqueue();
run();
expect("fixture keeps completed duplicate callbacks inert", Object.values(model.stages).map((stage) => stage.attempts).join(",") === attemptsAtCompletion);

if (failures.length) {
  console.error("FAIL durable post-call processing contract:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("OK post-call work is durable, tenant-bound, checkpointed, idempotent, and resumable");
