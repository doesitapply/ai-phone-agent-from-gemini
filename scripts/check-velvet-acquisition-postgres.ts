#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const adminDatabaseUrl = process.env.DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("DATABASE_URL must point to a local postgres/template1 admin database.");
}
const parsedAdminUrl = new URL(adminDatabaseUrl);
const adminDatabaseName = parsedAdminUrl.pathname.replace(/^\//, "");
if (!["127.0.0.1", "localhost", "::1"].includes(parsedAdminUrl.hostname)
  || !["postgres", "template1"].includes(adminDatabaseName)
  || process.env.SMIRK_ALLOW_TEMP_ACQUISITION_DB_CHECK !== "temporary-local-only") {
  throw new Error(
    "This check creates and drops a generated database and requires an explicitly approved local postgres/template1 admin URL.",
  );
}

const fixtureDatabaseName = `smirk_acquisition_check_${process.pid}_${randomBytes(6).toString("hex")}`;
const adminSql = postgres(parsedAdminUrl.toString(), { ssl: false, max: 1 });
let fixtureSql: any;
let fixtureCreated = false;

try {
  await adminSql.unsafe(`CREATE DATABASE "${fixtureDatabaseName}"`);
  fixtureCreated = true;
  const fixtureUrl = new URL(parsedAdminUrl);
  fixtureUrl.pathname = `/${fixtureDatabaseName}`;
  process.env.DATABASE_URL = fixtureUrl.toString();

  const { initSchema, sql } = await import("../src/db.js");
  const { initSaasSchema } = await import("../src/saas.js");
  const { createPostgresVelvetAcquisitionStore } = await import("../src/routes/velvet-acquisition-routes.js");
  const { velvetAcquisitionPayloadSchema } = await import("../src/velvet-acquisition.js");
  fixtureSql = sql;

  await initSaasSchema();
  await initSchema();
  await initSaasSchema();
  await initSchema();

  await sql`
    INSERT INTO workspaces (id, slug, name, owner_email, api_key)
    VALUES
      (42, 'velvet-acquisition-fixture', 'Velvet Acquisition Fixture', 'fixture@example.com', 'fixture-workspace-token-42'),
      (43, 'velvet-acquisition-other', 'Velvet Acquisition Other', 'other@example.com', 'fixture-workspace-token-43')
    ON CONFLICT (id) DO NOTHING
  `;

  const beforeRows = await sql<{
    contacts: number;
    calls: number;
    handoffs: number;
    tasks: number;
  }[]>`
    SELECT
      (SELECT COUNT(*)::INTEGER FROM contacts WHERE workspace_id = 42) AS contacts,
      (SELECT COUNT(*)::INTEGER FROM calls WHERE workspace_id = 42) AS calls,
      (SELECT COUNT(*)::INTEGER FROM handoffs WHERE workspace_id = 42) AS handoffs,
      (SELECT COUNT(*)::INTEGER FROM tasks WHERE workspace_id = 42) AS tasks
  `;

  const basePayload = velvetAcquisitionPayloadSchema.parse({
    workspaceId: 42,
    recordKind: "synthetic",
    sourceRecordId: "velvet-manus-fake-lead-postgres-0001",
    sourceEventId: "velvet-manus-fake-event-postgres-0001",
    caller: { phone: "+12025550124", name: "Synthetic Test Caller" },
    companyName: "Synthetic Test Company",
    reason: "Synthetic Postgres acquisition integration test.",
    urgency: "low",
  });
  const store = createPostgresVelvetAcquisitionStore(sql);
  const created = await store.receive(basePayload);
  const duplicate = await store.receive(basePayload);
  const secondEventPayload = {
    ...basePayload,
    sourceEventId: "velvet-manus-fake-event-postgres-0002",
  };
  const secondEvent = await store.receive(secondEventPayload);

  assert.equal(created.outcome, "created");
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(secondEvent.outcome, "created");
  assert.equal(created.acquisitionId, duplicate.acquisitionId);
  assert.equal(created.acquisitionId, secondEvent.acquisitionId);
  assert.notEqual(created.receiptId, secondEvent.receiptId);

  const realPayload = velvetAcquisitionPayloadSchema.parse({
    workspaceId: 42,
    recordKind: "real",
    sourceRecordId: "velvet-lead-postgres-0001",
    sourceEventId: "velvet-event-postgres-0001",
    caller: { phone: "+17755550142", name: "Prospect Owner" },
    companyName: "Prospect Plumbing Company",
    reason: "Qualified prospect evidence received for operator review.",
    urgency: "normal",
  });
  const real = await store.receive(realPayload);
  assert.equal(real.recordKind, "real");
  assert.equal(real.contactPermission, "unverified");
  assert.equal(real.contactBasis, "not_evaluated");

  const evidenceRows = await sql<{
    records: number;
    events: number;
    reviews: number;
  }[]>`
    SELECT
      (SELECT COUNT(*)::INTEGER FROM acquisition_records WHERE workspace_id = 42) AS records,
      (SELECT COUNT(*)::INTEGER FROM acquisition_events WHERE workspace_id = 42) AS events,
      (SELECT COUNT(*)::INTEGER FROM acquisition_reviews WHERE workspace_id = 42) AS reviews
  `;
  assert.deepEqual(evidenceRows[0], { records: 2, events: 3, reviews: 2 });

  const afterRows = await sql<{
    contacts: number;
    calls: number;
    handoffs: number;
    tasks: number;
  }[]>`
    SELECT
      (SELECT COUNT(*)::INTEGER FROM contacts WHERE workspace_id = 42) AS contacts,
      (SELECT COUNT(*)::INTEGER FROM calls WHERE workspace_id = 42) AS calls,
      (SELECT COUNT(*)::INTEGER FROM handoffs WHERE workspace_id = 42) AS handoffs,
      (SELECT COUNT(*)::INTEGER FROM tasks WHERE workspace_id = 42) AS tasks
  `;
  assert.deepEqual(afterRows[0], beforeRows[0]);

  const otherPayload = velvetAcquisitionPayloadSchema.parse({
    ...realPayload,
    workspaceId: 43,
    sourceRecordId: "velvet-lead-postgres-other-0001",
    sourceEventId: "velvet-event-postgres-other-0001",
  });
  const other = await store.receive(otherPayload);
  await assert.rejects(sql`
    INSERT INTO calls (call_sid, workspace_id, acquisition_id)
    VALUES ('tenant-mismatch-call', 42, ${other.acquisitionId})
  `, /foreign key constraint/);
  await assert.rejects(sql`
    INSERT INTO stripe_checkout_fulfillments (
      checkout_session_id, claim_token, acquisition_id, acquisition_workspace_id
    ) VALUES ('tenant-mismatch-checkout', 'claim', ${other.acquisitionId}, 42)
  `, /foreign key constraint/);

  await assert.rejects(sql`
    UPDATE acquisition_records
    SET source_record_id = 'velvet-manus-fake-mutated'
    WHERE acquisition_id = ${created.acquisitionId}
  `, /acquisition source identity is immutable/);
  await assert.rejects(sql`
    UPDATE acquisition_records
    SET contact_permission = 'eligible_for_later_review'
    WHERE acquisition_id = ${real.acquisitionId}
  `, /acquisition source identity is immutable/);
  await assert.rejects(sql`
    DELETE FROM acquisition_events
    WHERE receipt_id = ${created.receiptId}
  `, /append-only/);

  const constraintRows = await sql<{ conname: string }[]>`
    SELECT conname
    FROM pg_constraint
    WHERE conname IN (
      'calls_acquisition_tenant_fkey',
      'tasks_acquisition_tenant_fkey',
      'handoffs_acquisition_tenant_fkey',
      'acquisition_events_call_tenant_fkey',
      'acquisition_events_handoff_tenant_fkey',
      'stripe_checkout_fulfillments_acquisition_source_fkey'
    )
    ORDER BY conname
  `;
  assert.equal(constraintRows.length, 6);

  const triggerRows = await sql<{ tgname: string }[]>`
    SELECT tgname
    FROM pg_trigger
    WHERE NOT tgisinternal AND tgname LIKE 'trg_acquisition_%'
    ORDER BY tgname
  `;
  assert.equal(triggerRows.length, 3);

  console.log("OK disposable Postgres verified immutable evidence, tenant-safe joins, and zero queue writes");
} finally {
  if (fixtureSql) await fixtureSql.end({ timeout: 5 });
  if (fixtureCreated) {
    await adminSql`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${fixtureDatabaseName}
        AND pid <> pg_backend_pid()
    `;
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${fixtureDatabaseName}"`);
  }
  await adminSql.end({ timeout: 5 });
}
