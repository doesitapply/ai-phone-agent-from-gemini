import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { RequestHandler } from "express";
import { registerProspectOutreachRoutes } from "../src/routes/prospect-outreach-routes.ts";
import { registerProspectingRoutes } from "../src/routes/prospecting-routes.ts";
import { registerVelvetDiscoveryRoutes } from "../src/routes/velvet-discovery-routes.ts";
import { registerVelvetLeadSourceRoutes } from "../src/routes/velvet-lead-source-routes.ts";

type RouteMap = Map<string, Function[]>;

function captureApp() {
  const routes: RouteMap = new Map();
  const app: any = {};
  for (const method of ["get", "post", "patch", "delete"]) {
    app[method] = (path: string, ...handlers: Function[]) => {
      routes.set(`${method.toUpperCase()} ${path}`, handlers);
    };
  }
  return { app, routes };
}

function assertPauseGuard(
  routes: RouteMap,
  route: string
): void {
  const handlers = routes.get(route);
  assert.ok(handlers, `${route} was not registered`);
  assert.ok(
    handlers.some(
      handler =>
        handler.name ===
        "prospectAcquisitionUnpausedGuard"
    ),
    `${route} can bypass the positive-interaction pause`
  );
}

const pass: RequestHandler = (_req, _res, next) => next();
const inertSql: any = async () => [{ pending_count: 0 }];
inertSql.begin = async (callback: (tx: any) => unknown) =>
  callback(inertSql);
inertSql.json = (value: unknown) => value;

test("new acquisition, approval, and learning routes carry the pause guard", () => {
  const { app, routes } = captureApp();
  registerProspectOutreachRoutes(app, {
    dashboardAuth: pass,
    requireOperator: pass,
    requireFullOperator: pass,
    sql: inertSql,
    dbEnabled: true,
    getWorkspaceId: () => 1,
  });

  for (const route of [
    "POST /api/prospecting/learning/experiments",
    "POST /api/prospecting/learning/experiments/:experimentId/activate",
    "POST /api/prospecting/learning/experiments/:experimentId/prepare-drafts",
    "POST /api/prospecting/learning/experiments/:experimentId/close",
    "POST /api/prospecting/leads/:id/outreach",
    "POST /api/prospecting/outreach/:approvalId/approve",
    "POST /api/prospecting/learning/candidates",
    "POST /api/prospecting/learning/candidates/:id/decision",
    "POST /api/prospecting/learning/candidates/:id/apply-policy",
  ]) {
    assertPauseGuard(routes, route);
  }

  for (const deliberatelyAvailable of [
    "POST /api/prospecting/outreach/:approvalId/cancel",
    "POST /api/prospecting/outreach/:approvalId/reject",
    "POST /api/prospecting/outreach/:approvalId/record-execution",
    "POST /api/prospecting/learning/experiments/:experimentId/cancel",
    "POST /api/prospecting/learning/policies/:releaseId/rollback",
    "POST /api/prospecting/positive-outcomes/:reviewId/acknowledge",
    "POST /api/prospecting/email-replies/:reviewId/resolve",
    "POST /api/prospecting/leads/:id/outcomes",
  ]) {
    const handlers = routes.get(deliberatelyAvailable);
    assert.ok(handlers, `${deliberatelyAvailable} was not registered`);
    assert.equal(
      handlers.some(
        handler =>
          handler.name ===
          "prospectAcquisitionUnpausedGuard"
      ),
      false,
      `${deliberatelyAvailable} must remain available for truthful cleanup or review`
    );
  }
});

test("legacy campaign and lead acquisition routes carry the pause boundary", () => {
  const { app, routes } = captureApp();
  registerProspectingRoutes(app, {
    dashboardAuth: pass,
    requireOperator: pass,
    sql: inertSql,
    dbEnabled: true,
    getWorkspaceId: () => 1,
  });

  for (const route of [
    "POST /api/prospecting/campaigns",
    "POST /api/prospecting/campaigns/:id/leads",
  ]) {
    assertPauseGuard(routes, route);
  }

  const statusHandlers = routes.get(
    "PATCH /api/prospecting/campaigns/:id/status"
  );
  assert.ok(statusHandlers, "campaign status route was not registered");
  assert.equal(
    statusHandlers.some(
      handler =>
        handler.name ===
        "prospectAcquisitionUnpausedGuard"
    ),
    false,
    "campaign pausing and completion must remain available during review"
  );
});

test("Velvet discovery and reviewed-source acquisition routes carry the pause guard", () => {
  const discovery = captureApp();
  registerVelvetDiscoveryRoutes(discovery.app, {
    dashboardAuth: pass,
    requireOperator: pass,
    requireFullOperator: pass,
    sql: inertSql,
    dbEnabled: true,
    getWorkspaceId: () => 1,
  });
  for (const route of [
    "POST /api/prospecting/velvet-discovery/requests",
    "POST /api/prospecting/velvet-discovery/requests/:id/approve",
    "POST /api/prospecting/velvet-discovery/requests/:id/prepare-import",
  ]) {
    assertPauseGuard(discovery.routes, route);
  }

  const source = captureApp();
  registerVelvetLeadSourceRoutes(source.app, {
    dashboardAuth: pass,
    requireOperator: pass,
    requireFullOperator: pass,
    sql: inertSql,
    dbEnabled: true,
    getWorkspaceId: () => 1,
    store: {} as any,
  });
  for (const route of [
    "POST /api/prospecting/velvet-source/requests",
    "POST /api/prospecting/velvet-source/requests/:id/approve",
  ]) {
    assertPauseGuard(source.routes, route);
  }
});

test("stateful dispatch routes guard only new work and preserve reconciliation", () => {
  const outreachSource = readFileSync(
    new URL(
      "../src/routes/prospect-outreach-routes.ts",
      import.meta.url
    ),
    "utf8"
  );
  const discoverySource = readFileSync(
    new URL(
      "../src/routes/velvet-discovery-routes.ts",
      import.meta.url
    ),
    "utf8"
  );
  const sourceSource = readFileSync(
    new URL(
      "../src/routes/velvet-lead-source-routes.ts",
      import.meta.url
    ),
    "utf8"
  );
  const prospectingSource = readFileSync(
    new URL(
      "../src/routes/prospecting-routes.ts",
      import.meta.url
    ),
    "utf8"
  );
  const researchSource = readFileSync(
    new URL(
      "../src/routes/velvet-research-routes.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(
    outreachSource,
    /if \(job\.state === "APPROVED"\) \{\s+await assertProspectAcquisitionUnpaused\(\s+tx,\s+workspaceId\s+\);/
  );
  assert.match(
    outreachSource,
    /if \(row\.state === "PREPARED"\) \{\s+await assertProspectAcquisitionUnpaused\(\s+tx,\s+workspaceId\s+\);/
  );
  assert.match(
    discoverySource,
    /if \(row\.state === "APPROVED"\) \{\s+await assertProspectAcquisitionUnpaused\(\s+tx,\s+workspaceId\s+\);/
  );
  assert.match(
    sourceSource,
    /if \(row\.state !== "SENDING"\) \{\s+await assertProspectAcquisitionUnpaused\(\s+tx,\s+workspaceId\s+\);/
  );
  assert.ok(
    (
      outreachSource.match(
        /await assertProspectAcquisitionMutationUnpaused\(/g
      ) || []
    ).length >= 9,
    "every guarded outreach and learning mutation needs an in-transaction check"
  );
  assert.ok(
    (
      discoverySource.match(
        /await assertProspectAcquisitionMutationUnpaused\(/g
      ) || []
    ).length >= 3,
    "every discovery mutation needs an in-transaction check"
  );
  assert.ok(
    (
      sourceSource.match(
        /await assertProspectAcquisitionMutationUnpaused\(/g
      ) || []
    ).length >= 2,
    "every source mutation needs an in-transaction check"
  );
  assert.ok(
    (
      outreachSource.match(
        /await acquireProspectAcquisitionWorkspaceLock\(/g
      ) || []
    ).length >= 4,
    "positive outcomes, acknowledgments, and stateful dispatches must share the workspace lock"
  );
  assert.match(
    discoverySource,
    /const claim = await deps\.sql\.begin\(async \(tx: SqlClient\) => \{\s+await acquireProspectAcquisitionWorkspaceLock\(/
  );
  assert.match(
    sourceSource,
    /const claim = await deps\.sql\.begin\(async \(tx: SqlClient\) => \{\s+await acquireProspectAcquisitionWorkspaceLock\(/
  );
  assert.match(
    outreachSource,
    /if \(isPositiveProspectOutcome\(input\.outcome\)\) \{\s+await acquireProspectAcquisitionWorkspaceLock\(/
  );
  const prospectorSource = readFileSync(
    new URL("../src/prospector.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    prospectorSource,
    /await sql\.begin\(async \(tx: any\) => \{\s+await acquireProspectAcquisitionWorkspaceLock\(\s+tx,\s+row\.workspace_id\s+\);\s+const inserted = await tx/
  );
  assert.match(
    prospectingSource,
    /if \(status === "active"\) \{\s+await assertProspectAcquisitionMutationUnpaused\(tx, workspaceId\);/
  );
  assert.ok(
    (
      prospectingSource.match(
        /await assertProspectAcquisitionMutationUnpaused\(/g
      ) || []
    ).length >= 3,
    "legacy campaign creation, activation, and lead import need transaction-level pause checks"
  );
  assert.match(
    researchSource,
    /await acquireProspectAcquisitionWorkspaceLock\(\s+tx,\s+input\.workspaceId\s+\);/
  );
  assert.match(
    researchSource,
    /priorReceipt\?\.status === "received"[\s\S]+?return \{\s+outcome: "duplicate"/
  );
  assert.match(
    researchSource,
    /await assertProspectAcquisitionUnpaused\(\s+tx,\s+input\.workspaceId\s+\);/
  );

  for (const [source, route] of [
    [
      outreachSource,
      "/api/prospecting/outreach/:approvalId/execute",
    ],
    [
      outreachSource,
      "/api/prospecting/velvet-outcomes/:id/dispatch",
    ],
    [
      discoverySource,
      "/api/prospecting/velvet-discovery/requests/:id/dispatch",
    ],
    [
      sourceSource,
      "/api/prospecting/velvet-source/requests/:id/dispatch",
    ],
  ] as const) {
    const start = source.indexOf(`"${route}"`);
    assert.ok(start >= 0, `${route} was not found`);
    const routeHeader = source.slice(start, start + 500);
    assert.doesNotMatch(
      routeHeader,
      /requireAcquisitionUnpaused/,
      `${route} must not block same-key uncertain-state reconciliation before loading state`
    );
  }
});
