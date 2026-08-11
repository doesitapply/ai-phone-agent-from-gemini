import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateOperatorScoreboard } from "../src/operator-scoreboard.js";

const perfect = calculateOperatorScoreboard({
  calls: 10,
  completedCalls: 10,
  summarizedCalls: 10,
  tasks: 4,
  completedTasks: 4,
  handoffs: 2,
  clearedHandoffs: 2,
});
assert.equal(perfect.overall, 100);
assert.equal(perfect.grade, "A");

const mixed = calculateOperatorScoreboard({
  calls: 10,
  completedCalls: 8,
  summarizedCalls: 4,
  tasks: 10,
  completedTasks: 6,
  handoffs: 4,
  clearedHandoffs: 3,
});
assert.equal(mixed.overall, 67);
assert.equal(mixed.grade, "D");
assert.equal(mixed.components.length, 4);

const idle = calculateOperatorScoreboard({
  calls: 0,
  completedCalls: 0,
  summarizedCalls: 0,
  tasks: 0,
  completedTasks: 0,
  handoffs: 0,
  clearedHandoffs: 0,
});
assert.equal(idle.overall, null, "an idle portfolio must be N/A rather than fabricated success or failure");
assert.equal(idle.grade, "N/A");
assert.ok(idle.components.every(component => !component.applicable && component.score === null));

const callsOnly = calculateOperatorScoreboard({
  calls: 10,
  completedCalls: 10,
  summarizedCalls: 10,
  tasks: 0,
  completedTasks: 0,
  handoffs: 0,
  clearedHandoffs: 0,
});
assert.equal(callsOnly.overall, 100, "nonexistent task and handoff work must not depress the score");
assert.equal(callsOnly.applicableWeight, 55);

const routes = readFileSync(new URL("../src/routes/operator-routes.ts", import.meta.url), "utf8");
assert.match(
  routes,
  /app\.get\("\/api\/operator\/mission-control", dashboardAuth, requireFullOperator/,
  "cross-workspace Mission Control must require the full operator middleware",
);
assert.match(routes, /scope: "all_workspaces"/);
assert.match(routes, /access: "full_operator"/);
assert.match(routes, /'acknowledged', 'resolved', 'completed', 'transferred'/);
assert.match(routes, /status IN \('pending', 'screening'\)/);
assert.match(routes, /truncated: rawMetrics\.workspacesTotal > workspaceRows\.length/);
assert.doesNotMatch(
  routes,
  /app\.get\("\/api\/operator\/mission-control", dashboardAuth, requireOperator/,
  "demo operator middleware must not protect the owner scoreboard",
);

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(app, /Owner operator · full access/);
assert.match(app, /No pretend revenue math/);
assert.match(app, /Workspace Scoreboard/);
assert.match(app, /Portfolio scoreboard unavailable/);
assert.match(app, /component\.score === null \? "N\/A"/);

const authRoutes = readFileSync(new URL("../src/routes/auth-routes.ts", import.meta.url), "utf8");
assert.match(authRoutes, /allowedAdminEmails\.includes\(identity\.email\)/);
assert.match(authRoutes, /operatorClass: "owner_operator"/);
assert.match(authRoutes, /access: "full_operator"/);

console.log("OK owner-operator Mission Control is full-operator-only and its scoreboard uses bounded evidence-based metrics");
