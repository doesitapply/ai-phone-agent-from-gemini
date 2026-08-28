import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { registerScreenedTransferRoutes } from "../src/routes/screened-transfer-routes.ts";

type RecordedTask = { taskType: string; contactId: number | null; note: string };

const startRoute = async (callerPhone: string | null, contactId: number | null) => {
  const tasks: RecordedTask[] = [];
  const events: string[] = [];
  const sql: any = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join("?").replace(/\s+/g, " ");
    if (statement.includes("FROM calls c")) {
      return [{ contact_id: contactId, workspace_id: 7, caller_phone: callerPhone, existing_task_id: null }];
    }
    if (statement.includes("INSERT INTO tasks")) {
      tasks.push({ taskType: String(values[3]), contactId: values[0] as number | null, note: String(values[4]) });
      return [{ id: tasks.length }];
    }
    return [];
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  registerScreenedTransferRoutes(app, {
    sql,
    getAppUrl: () => "https://smirkcalls.com",
    logEvent: (_callSid, eventType) => events.push(eventType),
    log: () => {},
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, tasks, events, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

test("failed transfer creates exactly one callback task and ends cleanly when caller ID is usable", async () => {
  const route = await startRoute("+17753863205", 42);
  try {
    const response = await fetch(`${route.baseUrl}/api/twilio/transfer-result?callSid=CA_callback&targetName=Cam`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "DialCallStatus=no-answer&DialCallDuration=0",
    });
    const xml = await response.text();
    assert.equal(response.status, 200);
    assert.match(xml, /I couldn't connect you just now/i);
    assert.match(xml, /<Hangup\/>/);
    assert.deepEqual(route.tasks.map((task) => task.taskType), ["callback"]);
    assert.equal(route.tasks[0].contactId, 42);
    assert.ok(route.events.includes("TRANSFER_CALLBACK_TASK_CREATED"));
  } finally {
    await route.close();
  }
});

test("failed transfer creates one handoff follow-up when caller ID is unavailable", async () => {
  const route = await startRoute(null, null);
  try {
    const response = await fetch(`${route.baseUrl}/api/twilio/transfer-result?callSid=CA_anonymous&targetName=Cam`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "DialCallStatus=no-answer&DialCallDuration=0",
    });
    const xml = await response.text();
    assert.equal(response.status, 200);
    assert.match(xml, /leave the best callback number/i);
    assert.deepEqual(route.tasks.map((task) => task.taskType), ["handoff"]);
    assert.equal(route.tasks[0].contactId, null);
    assert.match(route.tasks[0].note, /Caller ID was unavailable/i);
    assert.ok(route.events.includes("TRANSFER_CALLBACK_TASK_CREATED"));
  } finally {
    await route.close();
  }
});
