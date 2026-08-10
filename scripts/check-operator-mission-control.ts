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
assert.equal(idle.overall, 0, "an idle portfolio must not receive a fabricated perfect score");

const routes = readFileSync(new URL("../src/routes/operator-routes.ts", import.meta.url), "utf8");
assert.match(
  routes,
  /app\.get\("\/api\/operator\/mission-control", dashboardAuth, requireFullOperator/,
  "cross-workspace Mission Control must require the full operator middleware",
);
assert.match(routes, /scope: "all_workspaces"/);
assert.match(routes, /access: "full_operator"/);
assert.doesNotMatch(
  routes,
  /app\.get\("\/api\/operator\/mission-control", dashboardAuth, requireOperator/,
  "demo operator middleware must not protect the owner scoreboard",
);

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(app, /Owner operator · full access/);
assert.match(app, /No pretend revenue math/);
assert.match(app, /Workspace Scoreboard/);

const authRoutes = readFileSync(new URL("../src/routes/auth-routes.ts", import.meta.url), "utf8");
assert.match(authRoutes, /allowedAdminEmails\.includes\(identity\.email\)/);
assert.match(authRoutes, /operatorClass: "owner_operator"/);
assert.match(authRoutes, /access: "full_operator"/);

console.log("OK owner-operator Mission Control is full-operator-only and its scoreboard uses bounded evidence-based metrics");
